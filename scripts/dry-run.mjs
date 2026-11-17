#!/usr/bin/env node
/**
 * 端到端自检：不部署、不需要密钥，用 Node 内置 fetch 模拟 Worker 运行时，
 * 直接调用共享路由，检查
 *   1. /api/config 的能力探测（有 / 无 AI binding）
 *   2. 演示模式能返回可用的合成预览图
 *   3. 关键约束：三张参考图必须齐全
 *   4. multipart 请求体的字段命名与数量符合 FLUX.2 规范
 *   5. 模型白名单：乱传 model 会被忽略
 *
 * 用法：node scripts/dry-run.mjs
 */

import { handleRequest, resolveBackends } from '../shared/router.js';
import { buildPrompt, buildCloudflareForm, parseDataUrl, generate, classifyAiFailure, clipPoseHint, normalizeRefImages, describeRefImages, DEFAULT_MODEL } from '../shared/generate.js';
import {
  normalizeBaseUrl,
  saveProfile,
  publicProfile,
  generateCustom,
} from '../shared/custom-model.js';
import { createServer } from 'node:http';

/** 内存 KV，模拟 Cloudflare KV 的 get/put/delete */
function fakeKV() {
  const m = new Map();
  return {
    async get(k, type) {
      const v = m.get(k);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

/** 本地假图像接口，用于端到端验证自定义通道（无需真实密钥） */
async function startFakeImageServer({ fail = 0 } = {}) {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const state = { lastPath: '', lastBody: null, lastAuth: '' };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    state.lastPath = req.url;
    state.lastAuth = req.headers.authorization || '';
    try { state.lastBody = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { state.lastBody = null; }
    if (fail) {
      res.writeHead(fail, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG.toString('base64') }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    get lastPath() { return state.lastPath; },
    get lastBody() { return state.lastBody; },
    get lastAuth() { return state.lastAuth; },
    close: () => new Promise((r) => server.close(r)),
  };
}
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const toDataUrl = async (p) => {
  const buf = await readFile(p);
  return `data:image/webp;base64,${buf.toString('base64')}`;
};

const imgs = await Promise.all(
  ['outfit', 'face', 'pose'].map((k) => toDataUrl(path.join(ROOT, `web/public/samples/${k}.webp`))),
);

console.log('\n[1] 能力探测');
const b0 = await resolveBackends({});
check('无 AI binding → demo 模式', b0.demo === true);
check('无 AI binding → 未就绪', b0.ready === false);
const b1 = await resolveBackends({ AI: { run() {} } });
check('有 AI binding → 就绪', b1.ready === true);
check('就绪时给出默认模型', b1.model === DEFAULT_MODEL);
const b2 = await resolveBackends({ AI: { run() {} }, FLUX_MODEL: '@cf/black-forest-labs/flux-2-dev' });
check('FLUX_MODEL 可覆盖默认', b2.model === '@cf/black-forest-labs/flux-2-dev', b2.model);
const b3 = await resolveBackends({ CUSTOM_BASE_URL: 'https://x/v1', CUSTOM_API_KEY: 'k', CUSTOM_MODEL: 'm' });
check('配好自定义模型 → 就绪且优先', b3.ready === true && b3.engine === 'custom', JSON.stringify(b3.engine));

console.log('\n[2] /api/config');
const cfgRes = await handleRequest(new Request('https://x/api/config'));
const cfg = await cfgRes.json();
check('返回 demo=true', cfg.demo === true);
check('未配置时 engine 为空', cfg.engine === null);
check('未配置时 engines 为空数组', Array.isArray(cfg.engines) && cfg.engines.length === 0);
check('返回可选模型列表', Array.isArray(cfg.models) && cfg.models.length >= 3);

console.log('\n[3] 演示模式生成');
const genRes = await handleRequest(
  new Request('https://x/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images: imgs, width: 864, height: 1152 }),
  }),
);
const gen = await genRes.json();
check('HTTP 200', genRes.status === 200, JSON.stringify(gen).slice(0, 200));
check('返回 SVG dataURL', typeof gen.image === 'string' && gen.image.startsWith('data:image/svg+xml;base64,'));

console.log('\n[4] 输入约束');
const badRes = await handleRequest(
  new Request('https://x/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ images: imgs.slice(0, 2) }),
  }),
);
check('少于三张图 → 400', badRes.status === 400);

console.log('\n[5] prompt 结构');
const p = buildPrompt({ style: 'photorealistic', extra: 'add a straw hat' });
check('包含三张图分工', /OUTFIT ONLY/.test(p) && /FACE ONLY/.test(p) && /POSE AND CAMERA ANGLE ONLY/.test(p));
check('包含补充描述', p.includes('add a straw hat'));
check('无拼写错误 dresed', !p.includes('dresed'));

console.log('\n[5b] 男性姿势不生效的回归');
// 现象：男性版选「双手叉腰」的姿势，生成图却是正面站姿。
// 原因：姿势参考图是女性素体线稿，胸部曲线与「成年男性」冲突，模型直接把姿势丢了。
const pMale = buildPrompt({ gender: 'male' });
const pHint = buildPrompt({ gender: 'male', poseHint: '坐姿｜后仰坐・单膝竖起' });
check('男性版把图3 当姿势来源', /Reference image 3 is the source of the pose/.test(pMale), pMale.slice(0, 120));
check('男性版仍换男性身体', /flat chest, male shoulder width/.test(pMale));
check('男性版只丢女性轮廓一项', /bust and hip curve/.test(pMale) && !/ignore that mannequin/i.test(pMale));
check('姿态要点进入提示词', /written out[\s\S]*单膝竖起/.test(pHint), pHint.slice(-260));
check('姿态要点不越权改服装/脸', /never to override the outfit or the face/.test(
  buildPrompt({ gender: 'female', poseHint: '坐姿｜后仰坐・单膝竖起' })));
check('要点超长会截断', clipPoseHint('x'.repeat(500)).length <= 201);

// 之前男性版给要点额外挂了一句英文括注，前端挂一次、后端又挂一次，同一句话出现两遍；
// 叠上「线稿女 / 人物男」的冲突，模型反而更容易丢掉姿势。现在只由后端按 gender 拼一次。
check('男性版「女性轮廓」只交代一次', (pHint.match(/female body surface/g) || []).length === 1);
check('男性版要点不再带重复括注', !/not its bust or waist-hip contour\)/.test(pHint));
// 否定句里带上动作词就等于给模型递了个候选动作：「别退回站姿」实测最容易被选中
check('男性版不再用「别退回站姿」的否定句', !/Do not replace the pose with a standing/i.test(pMale));

// 半句英文是纯干扰：图库要点只存 60 字符，中英混排时英文会被截在 …leaning back with the figur
const halfEn = '坐姿｜后仰坐・单膝竖起；sitting on the floor leaning back with the figur';
check('被截断的英文尾会被丢掉', !/figur\b/.test(clipPoseHint(halfEn)), clipPoseHint(halfEn));
check('丢尾后中文要点还在', /单膝竖起/.test(clipPoseHint(halfEn)));
const zhs = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose.json'), 'utf8')).items
  .map((it) => it.pose?.zh).filter(Boolean);
check('现有姿势要点清洗后无半英文尾', zhs.every((s) => !/[A-Za-z]{3,}$/.test(clipPoseHint(s))),
  zhs.map((s) => clipPoseHint(s)).find((s) => /[A-Za-z]{3,}$/.test(s)) || '全部干净');

// 关键：这些改动不能污染女性版——女性提示词里不能出现男性专用措辞
const pFemale = buildPrompt({ gender: 'female', poseHint: '坐姿｜后仰坐・单膝竖起' });
const pFemalePlain = buildPrompt({ gender: 'female' });
check('女性版不写这些男性专用说明', !/female artist mannequin/.test(pFemale));
check('女性版不提骨架/轮廓那套', !/skeleton|bust|waist-to-hip|adult man/.test(pFemale));
check('女性版要点只作确认，不改成命令', /use it to confirm image 3/.test(pFemale));
check('女性版主体约束与不填要点时一致', pFemale.replace(/ The intended pose in words[^.]*\./, '') === pFemalePlain);

// 前端要真的把要点带上：漏传时后端拼不出那句「intended pose in words」
const appSrc = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
check('前端把姿态要点带进 /api/generate', /poseHint: poseHintFor\(\)/.test(appSrc));
check('直连通道也带姿态要点', /const poseHint = poseHintFor\(\);/.test(appSrc));
check('要点不再带性别说明（避免重复）', !/copy only its skeleton and camera/.test(appSrc));
check('前端也会丢掉被截断的英文尾', /replace\(\/\\s\*\[A-Za-z\]/.test(appSrc));
check('姿势卡片悬停能看到要点', /it\.pose\?\.zh/.test(appSrc));
const poseMaleJson = await readFile(path.join(ROOT, 'web/public/data/pose-male.json'), 'utf8');
check('男性姿势库带「借用女性素体」标注', /poseGender/.test(poseMaleJson) && /女性素体/.test(poseMaleJson));
check('页面上有提示条', /此库是女性素体线稿/.test(appSrc) && /id="libNote"/.test(
  await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8'),
));

console.log('\n[5d] 姿势被站姿覆盖的回归');
// 现象：图3 是双腿分开、重心偏一侧、单臂前垂的线稿，成品却是并腿站直、双手贴身的正面站姿。
// 三处诱导：① 风格句写死 full-body shot；② 服装句反复强调 standing front view；
// ③ 姿态要点用「确认」口吻，模型宁可听文字也不看图。三条各自都能把姿势拽回默认站姿。
const pPose = buildPrompt({ gender: 'female', poseHint: '站立｜双腿分开・单臂前垂' });
const appSrcPose = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
check('风格句不再写死景别', !/full-body/i.test(pPose), pPose.match(/[^.]*full-body[^.]*/i)?.[0]);
check('服装句不再提站姿', !/standing front view/i.test(pPose));
check('服装句明确不取图1的姿态', /NO body posture, leg position or camera from image 1/.test(pPose));
check('姿态要点改为命令口吻', /The stance must follow image 3/.test(pPose));
check('点出模型默认滑向的四种站姿', /straighten the legs[\s\S]*close the gap between the feet[\s\S]*square the hips/.test(pPose));
check('男性版同样带反默认站姿约束', /The stance must follow image 3/.test(buildPrompt({ gender: 'male', poseHint: '站立' })));
check('风格句仍描述质感与光线', /realistic skin texture/.test(pPose) && /natural light/.test(pPose));
// 直连兜底文案是另一条独立路径（/api/prompt 挂掉时才会用到），同样不能写死景别
check('兜底文案不再写死全身照', !/全身人物照/.test(appSrcPose) && /不要并腿/.test(appSrcPose));
check('兜底文案也排除图1的站姿', /也不要取它的站姿/.test(appSrcPose));

console.log('\n[5f] 上半身姿势的取景回归');
// 现象：选「胸前双手心形」的线稿（只画到胸下缘），成品却是并腿站直、双手垂在身侧，
// 还自己补了腿和鞋。根因是全身那套提示词在逼模型展示完整服装，它只好编下半身，
// 编的过程中手势被丢掉。
const pUpper = buildPrompt({ gender: 'female', halfBody: true, frame: [1024, 1024] });
const pFull = buildPrompt({ gender: 'female', poseHint: '站立｜双腿分开', frame: [960, 1280] });
check('半身要求按图3裁到大腿中部', /cropped at mid-thigh/.test(pUpper));
check('半身禁止凭空补腿脚鞋', /Do not invent legs, feet, shoes/.test(pUpper));
check('半身要求手势可辨认', /every hand gesture from image 3 must be reproduced/.test(pUpper));
check('半身点名不许放下手臂', /do not lower the arms/.test(pUpper));
check('半身点出常见手势', /heart shape, peace sign, hands on cheeks/.test(pUpper));
check('半身要求脸在手后仍可见', /face must stay visible behind or between the hands/.test(pUpper));
check('半身不再要求并腿等站姿反例', !/default catalogue pose/.test(pUpper));
check('方画幅有对应描述', /square; frame the figure to fill it/.test(pUpper));

// 关键：全身这条路径一个字都不能受影响
check('全身仍带站姿反例', /default catalogue pose/.test(pFull));
check('全身不带半身取景段', !/FRAMING/.test(pFull) && !/mid-thigh/.test(pFull));
check('全身不写方画幅', !/square; frame the figure/.test(pFull));
check('全身画幅描述是竖版', /taller than wide/.test(pFull));
const pMaleUpper = buildPrompt({ gender: 'male', halfBody: true, frame: [1024, 1024] });
check('男性半身同样走进取景段', /cropped at mid-thigh/.test(pMaleUpper) && !/default catalogue pose/.test(pMaleUpper));

// 前端判定：两个库的半身标记不一样，认错就退回全身构图
const appUpper = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
const isHalfSrc = appUpper.slice(appUpper.indexOf('function isHalfBodyPose('), appUpper.indexOf('/** 页面上的画幅选项'));
// 注意 new Function 里不能直接 return 外层变量名，必须写成闭包，否则返回的是函数本身
const isHalf = (st) => new Function('state', `${isHalfSrc}; return isHalfBodyPose();`)(st);
check('女性库「上半身·单人」判为半身',
  isHalf({ selected: { pose: { cats: ['可爱系', '上半身·单人'] } } }) === true);
check('男性库 series=upper 判为半身',
  isHalf({ selected: { pose: { series: 'upper', cats: ['上半身'] } } }) === true);
check('全身站姿不判为半身',
  isHalf({ selected: { pose: { cats: ['站立', '全身·单人·常规'] } } }) === false);
check('没选姿势时不判为半身', isHalf({ selected: { pose: null } }) === false);

// 两个库的数据都要能被上面这条判定正确分类
const upperFemale = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose.json'), 'utf8')).items
  .filter((it) => isHalf({ selected: { pose: it } }));
check('女性库确实有上半身条目且能被识别', upperFemale.length > 100, `${upperFemale.length} 条`);
const standFemale = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose.json'), 'utf8')).items
  .filter((it) => (it.cats || []).includes('站立') && isHalf({ selected: { pose: it } }));
check('站立条目不会被误判为半身', standFemale.length === 0, `${standFemale.length} 条被误判`);

check('选半身姿势会自动切方图', /sel\.value = isHalfBodyPose\(\) \? RATIO_HALF : '3:4'/.test(appUpper));
check('用户改过画幅就不再自动切', /if \(state\.ratioTouched\) return;/.test(appUpper));
check('半身标记送进中转通道', /halfBody,\n\s*model:/.test(appUpper));
check('半身标记送进 /api/prompt', /halfBody: halfBody \? '1' : '0'/.test(appUpper));

console.log('\n[5g] 腿部服装被丢掉的回归');
// 现象：坐姿姿势是对的，裙子上半身也对，只有腿光着——图1 的黑丝袜和短靴都没了。
// 根因是防站姿的那句「图1 的腿位置一律不要」连腿上的衣物一起否掉了，
// 而图3 的腿又是裸露的素体线稿，模型照抄裸腿。
const pSit = buildPrompt({ gender: 'female', poseHint: '坐姿', frame: [960, 1280] });
check('明说图3 是裸体素体', /Image 3 is an unclothed mannequin/.test(pSit));
check('裸腿线稿不等于裸腿成品', /bare legs are not a styling choice/.test(pSit));
check('点名腿袜与鞋类', /tights, stockings, socks, boots, shoes/.test(pSit));
check('弯曲交叉的腿同样要穿', /bent and crossed legs included/.test(pSit));
check('图1 没有腿袜就不许瞎加', /If image 1 shows no legwear, the legs stay bare/.test(pSit));
check('图1 衣物覆盖范围含腿脚', /clothing still applies to the whole body, legs and feet included/.test(pSit));
// 只限定腿脚，不能扩成「全身都盖住」——否则露肩、露背会被模型补布料
check('没有要求全身覆盖', !/covered where image 1 is covered/.test(pSit));
check('保留露肩与剪裁自由', !/cover the shoulders|no exposed skin/i.test(pSit));

// 这条约束对每种姿势都要在（它们共用同一段），但不能改变各自的取景分支
for (const [label, opt] of [
  ['全身站姿', { gender: 'female', poseHint: '站立', frame: [960, 1280] }],
  ['半身', { gender: 'female', halfBody: true, frame: [1024, 1024] }],
  ['男性', { gender: 'male', poseHint: '坐姿', frame: [960, 1280] }],
]) {
  const p = buildPrompt(opt);
  check(`${label}：同样带腿部服装约束`, /Image 3 is an unclothed mannequin/.test(p));
}
// 半身不该被这条带偏：它仍然禁止凭空补腿，与「要穿丝袜」不冲突（丝袜只在腿可见时生效）
const pUp = buildPrompt({ gender: 'female', halfBody: true, frame: [1024, 1024] });
check('半身仍禁止补腿，与腿袜约束并存', /Do not invent legs, feet, shoes/.test(pUp) && /tights, stockings/.test(pUp));
check('半身取景段没被腿袜段顶掉', /cropped at mid-thigh/.test(pUp));
// 提示词长度要控制：T5 有效窗口 512 token，涨太多会把前面的职责分工挤出去
check('提示词仍在合理长度内', pSit.length < 2200, `${pSit.length} 字符`);

console.log('\n[5h] 男性姿势再次不生效：举起的胳膊被放下');
// 现象：图3 是单手高举过头的站立姿势，成品却是双手垂在身侧的正面站姿。
// 旧版男性段落把「忽略」说了四遍（ignore that mannequin / do NOT carry / never /
// do not replace the pose with a standing pose），「照搬」只有一句——模型权衡下来
// 干脆整张图都不用。加上要点通道对男性基本是空的（见下面 pose.en 那条），
// 姿势彻底没有落脚点。
const pM = buildPrompt({ gender: 'male', poseHint: 'standing with one arm raised high above the head, the other arm hanging at the side, legs apart' });
check('男性版逐肢体点名：举起的胳膊仍然举着',
  /a raised arm stays raised above the head/.test(pM));
check('男性版逐肢体点名：抬起的膝盖仍然抬起', /a bent or lifted knee stays bent/.test(pM));
check('男性版要求照搬骨架要素', /which limb is where, every joint angle, the weight-bearing leg/.test(pM));
check('男性版把「换身体」放在照搬之后',
  pM.indexOf('keep the same skeleton') < pM.indexOf('Give that skeleton a male body'));
check('男性版不再连说忽略', !/ignore that mannequin|its overall silhouette/i.test(pM));
check('「忽略」只留一处，且只针对身体表面', (pM.match(/female body surface/g) || []).length === 1);
check('男性版提示词长度未失控', pM.length < 2700, `${pM.length} 字符`);

// 女性版必须逐字不受影响：出现任何一条男性专用措辞都算污染
const pF = buildPrompt({ gender: 'female', poseHint: '站立｜单手高举' });
for (const [label, re] of [
  ['姿势来源句', /is the source of the pose/],
  ['逐肢体点名', /raised arm stays raised/],
  ['换男性身体', /flat chest, male shoulder width/],
  ['女性身体表面', /female body surface/],
  ['要点改写句', /written out/],
]) check(`女性版不含男性专用措辞：${label}`, !re.test(pF));
check('女性版仍走原来的确认式要点', /use it to confirm image 3/.test(pF));

// 要点字段：男性库的 pose.zh 只存 60 字符，清洗完只剩「站立｜单手高举；」这种小标题，
// 等于什么也没说；pose.en 才是完整的一句。取错字段就是「姿势没有文字落脚点」。
check('纯英文要点不会被砍掉最后一个词',
  clipPoseHint('standing with both arms raised overhead') === 'standing with both arms raised overhead',
  clipPoseHint('standing with both arms raised overhead'));
check('中英混排仍砍掉半句英文尾',
  clipPoseHint('站立｜单手高举；standing with one arm rais') === '站立｜单手高举；');
const longEn = clipPoseHint('standing with the left arm raised high above the head while the right hand rests on the hip and the weight shifts onto one leg, the torso turned away from the camera and the head tilted back'.repeat(2));
check('超长英文确实被截短', longEn.length <= 201, `${longEn.length} 字符`);
check('超长英文按词边界截断', /…$/.test(longEn) && !/\s…$/.test(longEn), longEn);
check('截断后不出现半个单词', !/[A-Za-z]…$/.test(longEn.slice(-3)) || /\b\w+…$/.test(longEn), longEn);

const maleItems = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose-male.json'), 'utf8')).items;
const betterEn = maleItems.filter((it) => String(it.pose?.en || '').length > String(clipPoseHint(it.pose?.zh || '')).length * 3);
check('男性库绝大多数条目 pose.en 信息量远大于 pose.zh', betterEn.length / maleItems.length > 0.8,
  `${betterEn.length}/${maleItems.length}`);

// 前端取值：男性优先 pose.en，女性只认 pose.zh（多取一个字段就是行为变化）
const appM = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
const hintSrc = appM.slice(appM.indexOf('function poseHintFor('), appM.indexOf('function isHalfBodyPose('));
const hintFor = (st) => new Function('state', `${hintSrc}; return poseHintFor();`)(st);
const samplePose = { zh: '站立｜单手高举；standing with one arm rais', en: 'standing with one arm raised high above the head, the other arm hanging at the side' };
check('男性取完整英文描述',
  hintFor({ gender: 'male', selected: { pose: { pose: samplePose } } }) === samplePose.en,
  hintFor({ gender: 'male', selected: { pose: { pose: samplePose } } }));
check('女性仍然只取中文要点',
  hintFor({ gender: 'female', selected: { pose: { pose: samplePose } } }) === '站立｜单手高举；');
check('男性没有 pose.en 时退回中文', hintFor({ gender: 'male', selected: { pose: { pose: { zh: '坐姿｜后仰坐' } } } }) === '坐姿｜后仰坐');
check('前端不会把纯英文要点砍掉最后一个词',
  hintFor({ gender: 'male', selected: { pose: { pose: { en: 'legs apart, weight on one hip' } } } }) === 'legs apart, weight on one hip');

console.log('\n[5e] 姿势库排序：全身站立优先');
// 现象：点开姿势库第一页全是坐姿（上游按编号排，P001 是「仰反弓坐姿」），站姿被埋到几十页后
const appSrc2 = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
const sortSrc = appSrc2.slice(appSrc2.indexOf('function poseRank('), appSrc2.indexOf('function renderGrid('));
const { sortPoses, poseRank } = new Function(`${sortSrc}; return { sortPoses, poseRank };`)();
for (const [label, file] of [['女性', 'pose.json'], ['男性', 'pose-male.json']]) {
  const items = JSON.parse(await readFile(path.join(ROOT, 'web/public/data', file), 'utf8')).items;
  const sorted = sortPoses(items);
  const head = sorted.slice(0, 12);
  check(`${label}：首页前 12 条全是全身站立`, head.every((it) => poseRank(it) === 0), head.map((it) => it.title).join(' / '));
  check(`${label}：条目数不变`, sorted.length === items.length);
  check(`${label}：无重复`, new Set(sorted.map((x) => x.id)).size === items.length);
  const firstOther = sorted.findIndex((it) => poseRank(it) !== 0);
  check(`${label}：站姿之后不再回插站姿`, sorted.slice(firstOther).every((it) => poseRank(it) !== 0));
  const stably = sorted.filter((it) => poseRank(it) === 0).map((it) => it.id);
  const origin = items.filter((it) => poseRank(it) === 0).map((it) => it.id);
  check(`${label}：同档不打乱原顺序`, stably.join() === origin.join());
}
check('只有姿势库重排', /state\.tab === 'pose' \? sortPoses\(list\) : list/.test(appSrc2));
// 排序只在展示层做，不动 data/*.json：数据文件里坐姿仍排在前面
const poseRaw = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose.json'), 'utf8')).items;
check('数据文件保持原顺序', poseRank(poseRaw[0]) !== 0, poseRaw[0].title);

console.log('\n[6] Cloudflare multipart');
const { form, modelId } = buildCloudflareForm({ images: imgs, prompt: p, modelId: '@cf/black-forest-labs/flux-2-klein-9b' });
const fields = [...form.keys()];
check('模型 id 正确', modelId === '@cf/black-forest-labs/flux-2-klein-9b');
check('包含 prompt / width / height', fields.includes('prompt') && fields.includes('width') && fields.includes('height'));
check('输入图字段命名为 input_image_0..2', ['input_image_0', 'input_image_1', 'input_image_2'].every((k) => fields.includes(k)));
check('无多余第 4 张', !fields.includes('input_image_3'));
const ref = parseDataUrl(imgs[0]);
check('dataURL 可解析为二进制', ref.bytes.length > 1000 && ref.mime.startsWith('image/'));

console.log('\n[7] 未绑定 AI 时快速失败');
try {
  await generate({ images: imgs, env: {}, aiRun: null });
  check('未绑定 AI 应报错', false);
} catch (e) {
  check('未绑定 AI 返回 501', e.status === 501, e.message);
}

console.log('\n[8] 假 binding 走通真实调用链');
let captured = null;
const fakeRun = async (modelId, input) => {
  captured = { modelId, input };
  return { image: 'aGVsbG8=' }; // "hello" 的 base64
};
const out = await generate({
  images: imgs,
  model: '../../evil/model',      // 非法模型，应被白名单拒绝
  env: { AI: { run: fakeRun } },
  aiRun: fakeRun,
  width: 864,
  height: 1152,
});
check('非法 model 回落到默认', captured.modelId === DEFAULT_MODEL, captured.modelId);
check('传入 multipart 入参', !!captured.input.multipart?.body && !!captured.input.multipart?.contentType);
check('返回 base64 与耗时', out.b64 === 'aGVsbG8=' && typeof out.ms === 'number');
check('返回所用 prompt', typeof out.prompt === 'string' && out.prompt.includes('OUTFIT ONLY'));

console.log('\n[9] 配额耗尽给出可读报错');
try {
  await generate({
    images: imgs,
    env: {},
    aiRun: async () => { throw new Error('4007: you have used up your daily free allocation of 10,000 neurons'); },
  });
  check('应抛错', false);
} catch (e) {
  check('识别为 429 配额问题', e.status === 429, `${e.status} ${e.message}`);
  check('提示里带上游原文便于自查', /daily free allocation/.test(e.message), e.message);
  check('detail.raw 保留完整错误', /neurons/.test(e.detail?.raw || ''), JSON.stringify(e.detail));
}

console.log('\n[9b] 误判回归：非配额报错不得说成「额度用完」');
// 曾经的问题：一条 /limit|exceed/ 正则把内存、尺寸、限流全吞成配额提示，
// 用户第二天额度已重置却仍看到「今日免费额度可能已用完」。
const misjudge = [
  ['AiError: Memory limit exceeded', '内存超限不应算配额', 502],
  ['AiError: image size limit exceeded, max 512x512', '尺寸超限应为 400', 400],
  ['AiError: Rate limit exceeded, retry later', '限流应为 503', 503],
  ['AiError: Internal server error', '普通 5xx 应为 502', 502],
];
for (const [msg, label, want] of misjudge) {
  const got = classifyAiFailure({ msg });
  check(label, got.status === want, `得到 ${got.status}：${got.message}`);
}
const quotaOk = classifyAiFailure({ msg: '4007: you have used up your daily free allocation of 10,000 neurons' });
check('真实配额错误仍判 429', quotaOk.status === 429, `${quotaOk.status}`);
check('容量类错误不出现「额度用完」字样', !/额度可能已用完/.test(classifyAiFailure({ msg: 'Memory limit exceeded' }).message));

console.log('\n[9c] 额度耗尽：官方文档与实测的错误码并不一致');
// 官方错误码表写的是 3036 "Account limited"，但自由额度耗尽实际抛 4006，两条文案一致。
// 只按码判定会漏掉 4006（用户的真实报错就是这么来的）。
const codes = [null, 3036, 4006, '4006'];
for (const c of codes) {
  const got = classifyAiFailure({
    msg: "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
    code: c,
  });
  check(`错误码 ${c ?? '缺失'} 也能判成 429`, got.status === 429, `得到 ${got.status}`);
}
const quotaMsg = classifyAiFailure({ msg: 'you have used up your daily free allocation of 10,000 neurons' }).message;
check('不再写死「UTC 0 点重置」误导用户', !/UTC 0 点重置/.test(quotaMsg), quotaMsg);
check('解释「面板 0/10k 仍被拦」的原因', /0\/10k|24 小时/.test(quotaMsg), quotaMsg);
check('提示额度是账号级共享', /账号级/.test(quotaMsg), quotaMsg);

console.log('\n[10] 3043 瞬时错误自动重试一次');
let calls = 0;
const flaky = async () => {
  calls += 1;
  if (calls === 1) {
    const e = new Error('AiError: Internal server error (a4a1cdedab1da502-GRU)');
    e.internalCode = 3043;
    throw e;
  }
  return { image: 'aGVsbG8=' };
};
const retried = await generate({ images: imgs, env: {}, aiRun: flaky });
check('首次 3043 后重试成功', calls === 2 && retried.b64 === 'aGVsbG8=', `calls=${calls}`);

let calls2 = 0;
try {
  await generate({
    images: imgs,
    env: {},
    aiRun: async () => {
      calls2 += 1;
      const e = new Error('AiError: Internal server error');
      e.internalCode = 3043;
      throw e;
    },
  });
  check('两次都失败应抛错', false);
} catch (e) {
  check('两次失败后不再重试', calls2 === 2, `calls=${calls2}`);
  check('错误码与 Ray 一并透出', e.status === 502 && e.detail?.code === 3043, JSON.stringify(e.detail));
  check('提示可换模型/画幅', /3043/.test(e.message));
}

console.log('\n[11] 4xx 类错误不重试');
let calls3 = 0;
try {
  await generate({
    images: imgs,
    env: {},
    aiRun: async () => {
      calls3 += 1;
      throw new Error('3005: prompt is too long');
    },
  });
  check('应抛错', false);
} catch (e) {
  check('非瞬时错误只调用一次', calls3 === 1, `calls=${calls3}`);
  check('状态码 502', e.status === 502, String(e.status));
}

console.log('\n[12] 自定义模型：URL 规范化');
check('补 /v1', normalizeBaseUrl('https://api.foo.com') === 'https://api.foo.com/v1');
check('去尾斜杠', normalizeBaseUrl('https://api.foo.com/v1/') === 'https://api.foo.com/v1');
check('缺协议自动补 https', normalizeBaseUrl('api.foo.com/v1') === 'https://api.foo.com/v1');
check('完整端点不改写', normalizeBaseUrl('https://a.com/v1/images/generations') === 'https://a.com/v1/images/generations');

console.log('\n[13] 自定义模型：保存校验');
for (const [name, body, code] of [
  ['缺 Base URL', { apiKey: 'k', model: 'm' }, 400],
  ['缺模型名', { baseUrl: 'https://a.com', apiKey: 'k' }, 400],
  ['缺 API Key', { baseUrl: 'https://a.com', model: 'm' }, 400],
]) {
  try {
    await saveProfile({ CONFIG: fakeKV() }, body);
    check(`${name} 应拒绝`, false);
  } catch (e) {
    check(`${name} → ${code}`, e.status === code, `${e.status} ${e.message}`);
  }
}

console.log('\n[14] 自定义模型：KV 读写与脱敏');
const kv = fakeKV();
await saveProfile({ CONFIG: kv }, { baseUrl: 'api.demo.com', apiKey: 'sk-abcdefgh1234', model: 'my-model' });
const pub = await publicProfile({ CONFIG: kv });
check('保存后 configured=true', pub.configured === true);
check('baseUrl 已补全 /v1', pub.baseUrl === 'https://api.demo.com/v1', pub.baseUrl);
check('密钥被脱敏', pub.apiKeyMasked.includes('••••') && !pub.apiKeyMasked.includes('abcdefgh'), pub.apiKeyMasked);
check('前端拿不到明文密钥', !JSON.stringify(pub).includes('sk-abcdefgh'));
const cfgWithCustom = await (await handleRequest(new Request('https://x/api/config'), { CONFIG: kv })).json();
check('/api/config 反映自定义通道', cfgWithCustom.engine === 'custom' && cfgWithCustom.ready === true);

console.log('\n[15] 自定义模型：真实调用（本地假服务器）');
const srv = await startFakeImageServer();
try {
  const profile = { baseUrl: `http://127.0.0.1:${srv.port}/v1`, apiKey: 'sk-test', model: 'fake-img', ready: true, sendMode: 'auto', extraJson: '' };
  const out = await generateCustom({ images: imgs, prompt: 'compose', size: '864x1152', profile });
  check('解析 b64_json 返回', out.b64.length > 50 && out.model === 'fake-img', `len=${out.b64.length}`);
  check('请求打到 /v1/images/generations', srv.lastPath === '/v1/images/generations', srv.lastPath);
  check('参考图随 extra_body.image 传入', Array.isArray(srv.lastBody?.extra_body?.image) && srv.lastBody.extra_body.image.length === 3);
  check('携带 Bearer 鉴权', srv.lastAuth === 'Bearer sk-test', srv.lastAuth);
} finally {
  await srv.close();
}

// toReference() 返回 { dataUrl, w, h }，历史上有一次改动把对象直接塞进了 extra_body.image，
// 上游只回「image 必须包含图片值」——界面上三张图都在，根本看不出是格式问题。
// 现在进请求体前统一归一化，堵死这条复发路径。
const srvObj = await startFakeImageServer();
try {
  const profile = { baseUrl: `http://127.0.0.1:${srvObj.port}/v1`, apiKey: 'k', model: 'm', ready: true };
  await generateCustom({
    images: imgs.map((u) => ({ dataUrl: u, w: 320, h: 480 })),
    prompt: 'x',
    size: '1024x1024',
    profile,
  });
  const sent = srvObj.lastBody?.extra_body?.image || [];
  check('对象包装的参考图会被归一化成字符串',
    sent.length === 3 && sent.every((x) => typeof x === 'string' && x.startsWith('data:image/')),
    sent.map((x) => typeof x).join(','));
} finally {
  await srvObj.close();
}

// 彻底不是图的东西，要在本地就报清楚，别丢给上游去猜
try {
  await generateCustom({
    images: [{ foo: 1 }, { bar: 2 }, { baz: 3 }],
    prompt: 'x',
    size: '1024x1024',
    profile: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', ready: true },
  });
  check('非图对象应报错', false);
} catch (e) {
  check('非图对象 → 本地明确报「格式不对」', /参考图格式不对/.test(e.message), e.message);
  check('报错里写明实际张数', /参考图 0 张/.test(e.message), e.message);
}

check('参考图摘要含格式与体积', /参考图 3 张（image\/webp×3|webp×3）/.test(describeRefImages(imgs)),
  describeRefImages(imgs));

console.log('\n[16] 自定义模型：错误分类');
const srv2 = await startFakeImageServer({ fail: 401 });
try {
  await generateCustom({ images: [], prompt: 'x', size: '1024x1024', profile: { baseUrl: `http://127.0.0.1:${srv2.port}/v1`, apiKey: 'k', model: 'm', ready: true } });
  check('401 应抛错', false);
} catch (e) {
  check('401 → 提示 Key 无效', e.status === 400 && /Key 无效/.test(e.message), e.message);
} finally {
  await srv2.close();
}

for (const [code, expectStatus, pattern, label] of [
  [403, 400, /无权访问|地区\/IP/, '403 → 说明权限或来源地区被拦'],
  [429, 429, /限流|额度/, '429 → 透传限流状态'],
  [422, 400, /不接受这组参数/, '422 → 提示参数不被接受'],
]) {
  const s = await startFakeImageServer({ fail: code });
  try {
    await generateCustom({ images: [], prompt: 'x', size: '1024x1024', profile: { baseUrl: `http://127.0.0.1:${s.port}/v1`, apiKey: 'k', model: 'm', ready: true } });
    check(`${code} 应抛错`, false);
  } catch (e) {
    check(`${code} → HTTP ${expectStatus}`, e.status === expectStatus, `status=${e.status}`);
    check(label, pattern.test(e.message), e.message);
    check(`${code} → 带出上游原文`, /上游：/.test(e.message) && e.detail?.upstreamStatus === code, e.message);
    // 「图无效」类报错只有带上本次发送摘要，才能分清洗是没带图还是格式不对
    check(`${code} → 报错带本次送出摘要`, /本次送出 参考图 0 张/.test(e.message), e.message);
  } finally {
    await s.close();
  }
}

console.log('\n[17] 图片代理：白名单与错误处理');
{
  const bad = await handleRequest(new Request('https://x/api/proxy?url=' + encodeURIComponent('https://evil.example/a.png')), {});
  check('非白名单域名被拒绝', bad.status === 403, `status=${bad.status}`);
  const invalid = await handleRequest(new Request('https://x/api/proxy?url=not-a-url'), {});
  check('非法 URL 返回 400', invalid.status === 400, `status=${invalid.status}`);
}

console.log('\n[18] 浏览器直连通道（静态检查）');
{
  const app = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
  const html = await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8');
  check('存在直连生成函数', /async function generateDirect\(/.test(app));
  check('直连请求带 Bearer 鉴权', /authorization: `Bearer \$\{cfg\.apiKey\}`/.test(app));
  check('直连配置只写 localStorage', /localStorage\.setItem\(LS_CUSTOM/.test(app));
  check('localStorage 里没有明文变量名误用', !/sessionStorage\.setItem\(.apiKey/.test(app));
  check('有请求发起位置选择器', /id="cfgRelay"/.test(html) && /value="browser"/.test(html));
  check('直连模式不走 /api/generate', /if \(direct\) \{\s*j = await generateDirect/.test(app));
  // 直连不经过 Worker，服务端那道归一化用不上，前端必须自带一份等价实现
  check('直连前先归一化参考图', /const refs = normalizeRefImages\(images\)/.test(app));
  check('直连接口收的是字符串', /image: refs \}/.test(app) && !/image: images \}/.test(app));
  check('直连报错带本次送出摘要', /upstreamMsg\(res\.status, json, raw, endpoint, refs\)/.test(app));
  check('右上角有作者主页链接', /id="authorLink" href="https:\/\/www\.1day\.vip"/.test(html));
  check('项目地址旁有项目文档链接', /项目地址<\/a>\s*<a class="ghost" href="https:\/\/blog\.1day\.vip\/post\/ai-character-atelier"/.test(html));
  // 手机端顶栏：商标、页签、切换、外链都必须完整显示，不能被压成竖排或溢出
  const cssSrc = await readFile(path.join(ROOT, 'web/public/styles.css'), 'utf8');
  check('顶栏各组不随空间压缩', /\.brand \{[^}]*flex: none/.test(cssSrc) && /\.tabs \{[^}]*flex: none/.test(cssSrc));
  check('窄屏页签组独占一行', /@media \(max-width: 399px\)[\s\S]{0,300}\.tabs \{ order: 3;/.test(cssSrc));
  // 前端拼的端点规则要与后端一致
  const norm = (raw) => {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    u = u.replace(/\/+$/, '');
    if (/\/images\/generations$/.test(u)) return u.replace(/\/images\/generations$/, '');
    if (!/\/v\d+$/i.test(u)) u += '/v1';
    return u;
  };
  check('端点拼接：缺 /v1 会补', norm('https://a.com') === 'https://a.com/v1', norm('https://a.com'));
  check('端点拼接：保留已有 /v1', norm('https://a.com/v1/') === 'https://a.com/v1');
  check('端点拼接：完整端点不重复拼', norm('https://a.com/v1/images/generations') === 'https://a.com/v1');
  check('端点拼接：补协议', norm('a.com/v1') === 'https://a.com/v1');

  // 前端那份 normalizeRefImages 必须与 shared 里的行为一致，否则直连和中转会分叉
  const feSrc = app.slice(app.indexOf('function normalizeRefImages('), app.indexOf('/** 参考图摘要'));
  const feNorm = new Function(`${feSrc}; return normalizeRefImages;`)();
  const cases = [
    ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'],
    [{ dataUrl: 'data:image/png;base64,CCC', w: 320, h: 480 }],
    ['data:image/jpeg;base64,AAA', { url: 'https://a.com/x.png' }],
    [{ foo: 1 }, null, ''],
    [],
  ];
  check('前后端归一化结果完全一致',
    cases.every((c) => JSON.stringify(feNorm(c)) === JSON.stringify(normalizeRefImages(c))),
    cases.map((c) => JSON.stringify(feNorm(c))).join(' | '));
  check('前端归一化也会丢掉空值', feNorm([{ foo: 1 }, null, '']).length === 0);
}

console.log('\n[19] 设置面板与抽屉排版（回归）');
{
  const css = await readFile(path.join(ROOT, 'web/public/styles.css'), 'utf8');
  const html = await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8');
  const app = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
  // .adv-body label 的 display:flex 会压过 [hidden] 的 UA 样式，两个模型行会同时露出来
  check('模型行能真正被 hidden 隐藏', /\.adv-body label\[hidden\]\s*\{\s*display:\s*none/.test(css));
  check('抽屉为三段式（body/foot 存在）', /class="drawer-body"/.test(html) && /class="drawer-foot"/.test(html));
  check('抽屉卡片不整体滚动（靠 body 滚）', /\.drawer-body\s*\{[^}]*overflow-y:\s*auto/.test(css));
  check('样例图有尺寸上限', /#cfgSample\s*\{[^}]*max-height/.test(css));
  check('保存成功后自动关闭抽屉', /function afterSaved[\s\S]{0,400}closeModelDrawer\(\)/.test(app));
}


console.log('\n[20] 女性 / 男性双版本');
{
  const app = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
  const css = await readFile(path.join(ROOT, 'web/public/styles.css'), 'utf8');
  const html = await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8');
  const router = await readFile(path.join(ROOT, 'shared/router.js'), 'utf8');

  const read = async (f) => JSON.parse(await readFile(path.join(ROOT, 'web/public/data', f), 'utf8'));
  const male = { outfit: await read('outfit-male.json'), pose: await read('pose-male.json'), face: await read('face-male.json') };
  const female = { outfit: await read('outfit.json'), pose: await read('pose.json'), face: await read('face.json') };

  check('男性三库都有条目', Object.values(male).every((d) => d.items.length > 0), Object.entries(male).map(([k, d]) => `${k}:${d.items.length}`).join(' '));
  check('女性服装含 Shisei 补充', female.outfit.items.some((it) => it.src === 'shisei'), `总 ${female.outfit.items.length}`);

  // 图片必须真实存在，避免出现「索引有、图挂了」
  let missing = 0;
  for (const d of Object.values(male)) {
    for (const it of d.items) {
      if (!it.thumb.startsWith('/')) continue;
      try {
        await readFile(path.join(ROOT, 'web/public', it.thumb.replace(/^\//, '')));
      } catch {
        missing++;
      }
    }
  }
  check('男性素材缩略图全部存在', missing === 0, `缺失 ${missing}`);

  check('默认女性版', /state\.gender = 'female'|gender: 'female'/.test(app));
  check('切换会重载图库', /async function setGender[\s\S]{0,900}loadCatalog/.test(app));
  check('男性走 *-male 索引', /state\.gender === 'male' \? `\$\{kind\}-male`/.test(app));
  check('配色随 data-gender 切换', /:root\[data-gender="male"\]/.test(css));
  check('女性版为粉色主色', /--accent:\s*#c05579/.test(css));
  check('男性版为蓝色主色', /:root\[data-gender="male"\][\s\S]{0,400}--accent:\s*#3a6ea5/.test(css));
  check('顶栏有性别切换按钮', /class="gender-switch"/.test(html) && /data-gender="male"/.test(html));
  check('站名已改', /<title>AI角色合成工坊/.test(html));

  const pM = buildPrompt({ gender: 'male' });
  const pF = buildPrompt({ gender: 'female' });
  check('提示词区分性别', /adult man/.test(pM) && /adult woman/.test(pF) && pM !== pF);
  check('代理放行 jsDelivr', /cdn\.jsdelivr\.net/.test(router));
  check('未引入 generated.photos', !/generated\.photos/.test(app + router + css));
}

console.log('\n[21] 文档拆分');
{
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  const manual = await readFile(path.join(ROOT, 'docs/manual.md'), 'utf8');
  // README 只留介绍/演示/部署/使用，细节搬去 docs/manual.md
  check('README 变短', readme.split('\n').length < 200, `${readme.split('\n').length} 行`);
  check('README 不再堆错误码表', !/unsupported_country_region_territory/.test(readme));
  check('README 指向详细说明', /docs\/manual\.md/.test(readme));
  check('README 指向图文教程', /blog\.1day\.vip\/post\/ai-character-atelier/.test(readme));
  check('详细说明接手了错误码表', /unsupported_country_region_territory/.test(manual));
  check('详细说明含部署细节', /automatic provisioning|自动资源供给/.test(manual));
  check('详细说明不再重复断言数量', !/项断言/.test(readme));

  // README 里引用的每张图都得真的存在，别让首屏裂图
  const imgs = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
  let broken = [];
  for (const rel of imgs) {
    try {
      await readFile(path.join(ROOT, rel));
    } catch {
      broken.push(rel);
    }
  }
  check('README 图片全部存在', broken.length === 0 && imgs.length >= 5, `${imgs.length} 张，缺 ${broken.join(',') || '无'}`);
  check('演示章节覆盖四步', ['选一张服装', '选一张脸', '选一张姿势', '合成'].every((t) => readme.includes(t)));

  // 定时同步是整份重写：服装和姿势都补过 Shisei 条目，漏一个就会被静默覆盖
  const sync = await readFile(path.join(ROOT, 'scripts/sync-catalogs.mjs'), 'utf8');
  check('定时同步不会覆盖 Shisei 姿势', /kind === 'outfit' \|\| kind === 'pose'/.test(sync));
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
if (fail) process.exit(1);
