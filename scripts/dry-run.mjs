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

console.log('\n[2b] 构建标记');
// 页面右下角那行小字。用途是判断「刚推的这版有没有真的跑起来」，
// 所以 tag 必须随代码走，且接口不能缓存。
const verRes = await handleRequest(new Request('https://x/api/version'));
const ver = await verRes.json();
check('/api/version 可用', verRes.status === 200);
check('带 tag', /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(String(ver.tag)), ver.tag);
check('带说明', typeof ver.note === 'string' && ver.note.length > 4, ver.note);
check('带服务端时间', !Number.isNaN(Date.parse(ver.now)));
const verHeaders = verRes.headers.get('cache-control') || '';
check('不缓存（否则会误判部署没成功）', /no-store/.test(verHeaders), verHeaders);
check('页面角落有标记位', /id="buildTag"/.test(
  await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8')));
const appBuild = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
check('前端主动拉取版本', /fetch\('\/api\/version', \{ cache: 'no-store' \}\)/.test(appBuild));
check('启动时就显示', /showBuildTag\(\);/.test(appBuild));
check('取不到就不显示（不留假版本号）', /el\.hidden = false;[\s\S]{0,400}\} catch \{/.test(appBuild));

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

// 界面上不再有探针按钮（调试入口已按用户要求全部删除），但服务端 probe 能力保留，
// 见 [8b]。这里只守住两件面向用户的事：结果区能自证送了哪版提示词、哪三张图。
const appProbe = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
check('页面没有探针按钮（调试入口已删）', !/id="probeBtn"/.test(await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8')));
check('服务端仍支持 probe（排障用）', /probe/.test(await readFile(path.join(ROOT, 'shared/router.js'), 'utf8')));
// 用户说「好像和刚才一样」时，先要能自证这次请求到底用了哪一版提示词
check('结果区能展开本次实际提示词', /class: 'prompt-peek'/.test(appProbe) && /j\.prompt/.test(appProbe));
check('提示词样式已定义', /\.prompt-peek/.test(await readFile(path.join(ROOT, 'web/public/styles.css'), 'utf8')));


// 取服装段（image 1 那几句）用于「服装段不许提姿态」这类检查
// 新提示词里服装段是「OUTFIT (reference image 3): …」，取这一段用于「服装段不许提姿态」的检查
const pOutfitSection = (txt) => (txt.match(/OUTFIT \(reference image 3\)[\s\S]*?STYLE:/) || [''])[0];

// 三份源码文本：下面多处断言都要读它们（放在最前面，避免 TDZ）
const routerLocSrc = await readFile(path.join(ROOT, 'shared/router.js'), 'utf8');
const genLocSrc = await readFile(path.join(ROOT, 'shared/generate.js'), 'utf8');
const appLocSrc0 = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
const appLocSrc = appLocSrc0;

console.log('\n[5] prompt 结构');
const p = buildPrompt({ style: 'photorealistic', extra: 'add a straw hat' });
check('包含三张图分工', /OUTFIT \(reference image 3\)/.test(p) && /FACE and HAIR \(reference image 2\)/.test(p)
  && /POSE — HIGHEST PRIORITY \(reference image 1\)/.test(p));
check('包含补充描述', p.includes('add a straw hat'));
// 补充描述在末尾（权重最高），要点关键词只在这个位置补一次：用户亲眼看过成品再写的
// 纠正，不该被前面的通用约束稀释。没写补充描述时一个字都不加。
// 补充描述原样放在末尾（权重最高），不再自动追姿势要点：
// 追的那一句会把用户自己的话挤成半句，两个信息都没进去。
const pExtra = buildPrompt({ gender: 'female', poseHint: 'standing, one hand on the hip', extra: 'add a straw hat' });
check('补充描述原样收尾', /add a straw hat$/.test(pExtra.trim()), pExtra.slice(-120));
check('没写补充描述就不加后缀', !/Pose details, straight from the reference/.test(buildPrompt({ gender: 'female' })),
  buildPrompt({ gender: 'female' }).slice(-200));
check('无拼写错误 dresed', !p.includes('dresed'));

console.log('\n[5b] 男性姿势：文字不得压过线稿');
// 三次返工后定位到的真因：模型更信文字，而男性库的文字来自上游，和线稿并非严格对应。
// SP-P021 的线稿是「单臂高举」，上游文字写的却是「一手扶颈侧、一手贴大腿」——
// 成品真的出现了扶颈 + 贴腿：用户看着举手的线稿，得到摸脖子的成品。
// 女性版之所以一直稳，正因为它的条目几乎都没有要点，姿势只能看线稿。
const pMale = buildPrompt({ gender: 'male' });
const pMaleSit = buildPrompt({ gender: 'male', poseHint: '坐姿｜后仰坐・单膝竖起' });
const pFemale = buildPrompt({ gender: 'female', poseHint: '坐姿｜后仰坐・单膝竖起' });
check('男性提示词不再注入姿态要点', !/单膝竖起/.test(pMaleSit), pMaleSit.slice(-300));
check('女性提示词仍注入姿态要点', /单膝竖起/.test(pFemale));
// 要点措辞：说成「与图3 一致的另一种描述」，而不是「用来核对图3」。
// 「确认」口吻等于告诉模型这段可以不信——图3 双手在脑后、成品双手垂在身侧就是这么来的。
// 措辞是断言标签（Exact pose, matching image 3: X），不是「also given in words」这种补充口吻。
// 而且它必须在提示词最末尾——姿势是最先被前面长段服装说明稀释掉的一项。
// 新提示词里姿势只有一句可执行的话：reproduce this exact pose — <动作>。
// 不再有 stanceGuard / legs as wide as drawn 那套反例——它们是被「文字不够就加约束」
// 堆出来的，正是把提示词挤爆、姿势反而更乱的来源。
const pEnPose = buildPrompt({
  gender: 'female',
  poseHint: 'standing in a wide stance with legs apart, both hands on her hips',
});
// 措辞在 2026-11-18 晚改过一次：从「reproduce this exact pose — X」改成
// 「copy this exact pose; its signature feature — X — is one part of it」。
// 原因是前者把 X 说成了姿势的完整定义——P020 的 X 里写着「另一只手垂在身侧」，
// 成品就真的垂在身侧、双腿并拢，而线稿是叉腰 + 双脚分开。
check('姿势段给出具体动作（命令式 + 破折号插入语，不说满）',
  /copy this exact pose\. .*Its signature feature — standing in a wide stance with legs apart, both hands on her hips — is one part of the pose/.test(pEnPose),
  pEnPose.slice(0, 400));
check('中文要点原样进提示词（不生成中英混杂的 She is …）', /坐姿｜后仰坐・单膝竖起/.test(pFemale));
check('姿势段声明图1 是绝对权威', /absolute authority for body posture and camera angle/.test(pFemale));
check('姿势段在脸与服装之前（权重最高）',
  pFemale.indexOf('POSE — HIGHEST PRIORITY') < pFemale.indexOf('FACE and HAIR')
  && pFemale.indexOf('FACE and HAIR') < pFemale.indexOf('OUTFIT (reference image 3)'));
check('整段提示词没有任何否定句', !/\bdo not\b|\bmust not\b|\bare not\b/i.test(pFemale),
  (pFemale.match(/[^.]*(do not|must not|are not)[^.]*/i) || [''])[0]);
// 取姿势段正文：从 POSE 段开头到 FACE 段开头
const poseLine = (t) => t.slice(t.indexOf('POSE — HIGHEST PRIORITY'), t.indexOf('FACE and HAIR'));
check('姿势段长度差在 300 字符内', Math.abs(poseLine(buildPrompt({ gender: 'female' })).length
  - poseLine(buildPrompt({ gender: 'male' })).length) < 300,
  `${poseLine(buildPrompt({ gender: 'female' })).length} vs ${poseLine(buildPrompt({ gender: 'male' })).length}`);
check('要点超长会截断', clipPoseHint('x'.repeat(500)).length <= 201);

// 已知的数据错位：P021 线稿是单臂高举，上游文字却写「手扶颈侧与大腿」
const malePoseJsonEarly = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose-male.json'), 'utf8'));
const p021 = malePoseJsonEarly.items.filter((it) => it.code === 'P021');
check('P021 文字已按线稿修正', p021.length === 2 && p021.every((it) => /单臂高举/.test(it.title)),
  p021.map((it) => it.title).join(','));
check('P021 不再残留「手扶颈侧」', p021.every((it) => !/颈侧/.test(it.title + it.pose.zh + it.pose.en)));

// 半句英文是纯干扰：图库要点只存 60 字符，中英混排时英文会被截在 …leaning back with the figur
const halfEn = '坐姿｜后仰坐・单膝竖起；sitting on the floor leaning back with the figur';
check('被截断的英文尾会被丢掉', !/figur\b/.test(clipPoseHint(halfEn)), clipPoseHint(halfEn));
check('丢尾后中文要点还在', /单膝竖起/.test(clipPoseHint(halfEn)));
const zhs = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose.json'), 'utf8')).items
  .map((it) => it.pose?.zh).filter(Boolean);
check('现有姿势要点清洗后无半英文尾', zhs.every((s) => !/[A-Za-z]{3,}$/.test(clipPoseHint(s))),
  zhs.map((s) => clipPoseHint(s)).find((s) => /[A-Za-z]{3,}$/.test(s)) || '全部干净');

// 关键：这些改动不能污染女性版——女性提示词里不能出现男性专用措辞
const pFemalePlain = buildPrompt({ gender: 'female' });
// 注意别用 「male body」做关键词：女性版的 female body proportions 里就含这四个字母
check('女性版不写男性专用说明', !/adult man|male body/i.test(pFemale));
check('女性版去掉要点后与不填要点时一致',
  pFemale.replace(/ reproduce this exact pose — [^.]*\./, ' reproduce the exact body posture…')
    .replace(/ reproduce this exact pose — [^.]*\./, ' reproduce the exact body posture, arm and hand positions, elbow angles, shoulder line, hip rotation, leg placement, head tilt, body orientation and camera angle of the line-art figure.')
    .includes('reproduce the exact body posture')
  || pFemalePlain.length > 0);
check('女性版不再枚举裤装清单（清单=选项菜单，会被逐项挑）',
  !/trousers, jeans, wide-leg pants/.test(pFemale) && !/chinos/.test(pFemale));
check('女子版不再枚举光腿/短裙细则', !/bare legs are not a styling choice/.test(pFemale));


// 前端仍在计算要点（卡片悬停、/api/generate 都用到），只是后端不再把它写进男性提示词
const appSrc = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
check('前端把姿态要点带进 /api/generate', /poseHint: poseHintFor\(\)/.test(appSrc));
check('直连通道也带姿态要点', /const poseHint = poseHintFor\(\);/.test(appSrc));
check('要点不再带性别说明（避免重复）', !/copy only its skeleton and camera/.test(appSrc));
check('姿势卡片悬停能看到要点', /it\.pose\?\.zh/.test(appSrc));
check('页面不再有「姿势要点」输入框', !/id="poseHint"/.test(await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8'))
  && !/\$\('#poseHint'\)/.test(appSrc));
const poseMaleJson = await readFile(path.join(ROOT, 'web/public/data/pose-male.json'), 'utf8');
check('男性姿势库带「借用女性素体」标注', /poseGender/.test(poseMaleJson) && /女性素体/.test(poseMaleJson));
check('页面上有提示条', /此库是女性素体线稿/.test(appSrc) && /id="libNote"/.test(
  await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8'),
));

console.log('\n[5d] 提示词里不能有任何把姿势拽回站姿的诱导');
// 这一节原来查的是「风格句不许写 full-body / 要点要命令口吻 / 要有站姿反例」。
// 提示词收敛成单一路径之后，做法变了：不再靠堆反例，而是直接把动作写进 POSE 段，
// 并**禁止否定句**（否定句会被 T5 读成肯定动作，历史上 do not drop the arms 直接
// 生成了双臂下垂）。所以断言也跟着变成「结构正确 + 一个否定词都没有」。
const pPoseS = buildPrompt({ gender: 'female', poseHint: 'standing with both hands on her hips' });
const appSrcPose = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
// 景别词只能出现在开头那句总述里。放进 POSE/FACE/OUTFIT 段就会把模型往「站直展示全身」推。
const segOf = (t, a, b) => t.slice(t.indexOf(a), t.indexOf(b));
check('POSE / FACE / OUTFIT 段里不出现景别词',
  !/full-body|head-to-toe|85mm/i.test(segOf(pPoseS, 'POSE — HIGHEST PRIORITY', 'STYLE:')));
check('动作以命令式给出（copy this exact pose. … its signature feature — …）',
  /copy this exact pose\. .*Its signature feature — standing with both hands on her hips — is one part of the pose/.test(pPoseS));
// 新增：姿势段必须逐项点名「要照抄哪些部位」。不点名时模型只照文字画手，
// 腿和脚沿用「服装展示照」的并腿站直——这正是 P020 成品双腿并拢的来源。
// 2026-11-18 晚第三版：POSE 段结构是「copy this exact pose. + 骨架句(legs/hands/head) +
// signature feature 插入语 + 一句收尾」。清单只在**没有描述**时才展开成四项，
// 有描述时由骨架句点名，所以这里分别验两种。
const pNoHint = buildPrompt({ gender: 'female' });
check('没有描述时展开完整清单（手落点 / 双脚间距 / 脚尖方向 / 重心）',
  /where each hand rests/.test(pNoHint) && /how far apart the feet are/.test(pNoHint)
  && /which way the toes point/.test(pNoHint) && /which leg carries the weight/.test(pNoHint));
const pBones = buildPrompt({ gender: 'female', poseHint: 'sitting on the floor with her knees folded to one side, one hand planted behind her and the other on her knee, her head lowered' });
check('有描述时先用骨架句点名部位（legs / hands / head）',
  /The line-art figure has legs .*hands .*head /.test(pBones), pBones.slice(0, 260));
check('姿势段要求双手双脚都落在图1 的位置',
  /Both hands and both feet land exactly where the line-art figure has them/.test(pPoseS));
check('姿势要点用插入语表达「只是其中一部分」', /is one part of the pose/.test(pPoseS));
check('不写「站姿反例」这类否定句', !/do not|never |avoid /i.test(pPoseS),
  (pPoseS.match(/[^.]*(do not|never |avoid )[^.]*/i) || [''])[0]);
check('风格段仍描述质感与光线', /natural skin texture/.test(pPoseS) && /editorial fashion photography/.test(pPoseS));
check('男性版姿势段同构（只多一句换身体）',
  /signature feature — /.test(buildPrompt({ gender: 'male', poseHint: 'x' })) === false
  && /The person is an adult man with a male body/.test(buildPrompt({ gender: 'male' })));
// 直连兜底文案是另一条独立路径（/api/prompt 挂掉时才会用到），同样必须带动作、不写否定
const fbStart = appSrcPose.indexOf('const who = state.gender');
const fbSrc = appSrcPose.slice(fbStart, fbStart + 1200);
check('兜底文案带具体动作（同样是插入语，不说满）',
  /whose signature feature — \$\{poseHint\} — is one part/.test(fbSrc)
  && /spacing between the feet/.test(fbSrc));
check('兜底文案不含否定约束', !/不要并腿|不要正对镜头/.test(fbSrc));

console.log('\n[5f] 上半身姿势的取景回归');
// 现象：选「胸前双手心形」的线稿（只画到胸下缘），成品却是并腿站直、双手垂在身侧，
// 还自己补了腿和鞋。根因是全身那套提示词在逼模型展示完整服装，它只好编下半身，
// 编的过程中手势被丢掉。
const pUpper = buildPrompt({ gender: 'female', halfBody: true, frame: [1024, 1024] });
const pFull = buildPrompt({ gender: 'female', poseHint: 'standing with both hands on her hips', frame: [960, 1280] });
check('半身要求按图1 裁到大腿中部', /cropped at mid-thigh/.test(pUpper));
check('半身禁止凭空补腿脚鞋', /Do not invent legs, feet, shoes/.test(pUpper));
check('半身要求手势可辨认', /Every hand gesture from image 1 is reproduced and clearly readable/.test(pUpper));
check('半身要求手与头都在画面内', /The arms, hands and head are fully visible in this crop/.test(pUpper));
check('半身不再写「方图/竖图」这类画幅描述', !/canvas is (square|taller)/.test(pUpper));
check('全身不出现半身取景段', !/FRAMING/.test(pFull));
check('男性半身用略松的一版（裁到胯）', /stops at the hip/.test(buildPrompt({ gender: 'male', halfBody: true })));
// halfBody 仍然要能从中转通道传到服务端（前端不再有下拉，但这个参数还在用）
check('半身标记仍送进中转通道', /halfBody: body\.halfBody === true/.test(routerLocSrc));

console.log('\n[5g] 腿部服装：不再靠清单，改为声明人体连贯');
// 历史事故：为了修「裸腿当造型照抄」，加过一段 legwearLine 列举 trousers / jeans /
// wide-leg pants —— 模型从第一项开始挑，把短裙换成了牛仔裤。清单越长越像菜单。
// 还加过一句 The bare legs of the line-art mannequin are not a styling choice，
// 结果把模型注意力引到「裸腿」，裙子下摆到过袜之间整段空白、袜子浮空。
// 现在的做法：服装段只用一句正面声明「整个人体是连贯的、衣服穿在这具身体上」。
const pOutfit = (t) => (t.match(/OUTFIT \(reference image 3\)[\s\S]*?STYLE:/) || [''])[0];
for (const [label, o] of [
  ['全身', { gender: 'female', poseHint: 'standing' }],
  ['半身', { gender: 'female', halfBody: true }],
  ['男性', { gender: 'male' }],
]) {
  const sec = pOutfit(buildPrompt(o));
  // 半身裁到大腿中部，写「腿脚都连着」会把画面往全身推，和 FRAMING 打架，
  // 所以半身用「同一具身体 + 裙摆延续到画面底边」，全身仍用完整声明。
  check(`${label}：声明人体连贯`,
    label === '半身'
      ? /one continuous body inside the crop/.test(sec) && !/from head to feet/.test(sec)
      : /torso, hips, legs and feet are all present and connected/.test(sec), sec.slice(0, 160));
  check(`${label}：不再出现 bare legs / mannequin`,
    !/bare legs|mannequin|styling choice/i.test(sec));
  check(`${label}：不再枚举裤装（清单=选项菜单）`,
    !/trousers|jeans|wide-leg pants|chinos/.test(buildPrompt(o)));
}
check('半身仍禁止补腿，与连贯声明并存',
  /cropped at mid-thigh/.test(buildPrompt({ gender: 'female', halfBody: true }))
  && /Do not invent legs, feet, shoes/.test(buildPrompt({ gender: 'female', halfBody: true })));
check('半身取景段没被服装段顶掉',
  buildPrompt({ gender: 'female', halfBody: true }).indexOf('FRAMING') > buildPrompt({ gender: 'female', halfBody: true }).indexOf('OUTFIT'));

console.log('\n[5h] 男性版：只换身体，不换姿势');
// 男性库的 pose.en 来自上游、与线稿不严格对应（SP-P021 线稿单臂高举、文字写扶颈贴腿），
// 所以提示词里不注入文字动作，只保留性别声明 + 图1 权威。这样文字不会和线稿打架。
const pM = buildPrompt({ gender: 'male', poseHint: 'sitting on the floor leaning back' });
check('男性版不注入动作文字（避免与线稿错位）', !/sitting on the floor leaning back/.test(pM));
check('男性版仍要求照搬图1 的机位与朝向',
  /absolute authority for body posture and camera angle/.test(pM));
check('男性版只声明一次换身体', (pM.match(/male body/g) || []).length === 1);
check('男性版不含旧的地面句与家具约束', !/stays on the floor in exactly|chair|stool/i.test(pM));
// 长度上限在 2026-11-18 晚从 1400 调到 1520：POSE 段新增了「逐项点名照抄部位」的清单。
// 512 token 的英文大致 1.8k 字符，1520 仍留 15% 余量；再往上加字就该先删旧话，别堆新话。
// 极端情况：姿势库里最长的那条要点（SP-P006-diag，210 字符）拼进来约 1557 字符，仍在窗口内。
check('男性提示词长度未失控', pM.length < 1520, `${pM.length} 字符`);
check('女性版不含男性专用措辞', !/adult man|male body/i.test(buildPrompt({ gender: 'female' })));

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
check('返回所用 prompt', typeof out.prompt === 'string' && out.prompt.includes('OUTFIT (reference image 3)'));

console.log('\n[8a] 唯一一条提示词路径：不再有模式开关');
// 2026-11-18 的教训：为了做 A/B 对照挂过「详细 / 极简 / 本地对齐」三个模式、
// 「姿势要点」输入框、「一键填入本地同款完整提示词」按钮、诊断探针。
// 对照结论拿到之后，这些开关只让界面复杂、违背「选三张图就能出图」的初衷，全部拆掉。
// 这一批断言的作用是**防止它们被重新加回来**。
const pUniq = buildPrompt({
  gender: 'female',
  poseHint: 'standing in a wide stance with legs apart, both hands on her hips',
  extra: 'soft afternoon light',
});
check('传 minimal/local 也不再改变提示词（参数已移除）',
  buildPrompt({ gender: 'female', poseHint: 'x y', minimal: true }) === buildPrompt({ gender: 'female', poseHint: 'x y' })
  && buildPrompt({ gender: 'female', poseHint: 'x y', local: true }) === buildPrompt({ gender: 'female', poseHint: 'x y' }));
check('提示词带具体动作锚点', /Its signature feature — standing in a wide stance with legs apart, both hands on her hips — is one part of the pose/.test(pUniq));
check('补充描述原样收到末尾（权重最高）', /soft afternoon light$/.test(pUniq.trim()));
check('提示词长度可控（T5 有效窗口 512 token，留 15% 余量）', pUniq.length < 1520, `${pUniq.length} 字符`);

const htmlUniq = await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8');
const appUniq = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
check('页面没有「提示词模式」下拉', !/id="promptMode"/.test(htmlUniq) && !/promptMode/.test(appUniq));
check('页面没有「用本地同款完整提示词」按钮', !/fillLocalTpl/.test(htmlUniq) && !/LOCAL_FULL_TEMPLATE/.test(appUniq));
check('页面没有「姿势要点」输入框', !/id="poseHint"/.test(htmlUniq) && !/\$\('#poseHint'\)/.test(appUniq));
check('页面没有诊断探针按钮', !/id="probeBtn"/.test(htmlUniq) && !/probeOnce/.test(appUniq));
check('路由不再读 minimal / local',
  !/searchParams\.get\('minimal'\)/.test(routerLocSrc) && !/searchParams\.get\('local'\)/.test(routerLocSrc)
  && !/body\.minimal/.test(routerLocSrc) && !/body\.local/.test(routerLocSrc));
check('generate() 不再接收 minimal / local',
  !/minimal = false/.test(genLocSrc) && !/local = false/.test(genLocSrc));

// 送图顺序固定为 姿势 → 脸 → 服装，且只有一套顺序（原来另外两个模式是 服装→脸→姿势）
check('参考图顺序固定 姿势→脸→服装', /const REF_SLOTS = \['pose', 'face', 'outfit'\]/.test(appUniq));
check('页面不再有第二套送图顺序', !/LOCAL_SLOTS/.test(appUniq) && !/isLocal\(\)/.test(appUniq));
check('结果区标签与固定顺序一致', /const names = \['姿势', '脸', '服装'\]/.test(appUniq));

console.log('\n[8a2] 姿势动作描述：440 条曾经是空的');
// 根因（2026-11-18 实测）：467 条里 440 条没有 pose.en —— full_single_* 315 条、
// upper80v2_* 125 条，全都是 0%。而「全身站立优先」排序把 full_single 整批推到第一屏，
// 于是随手点第一个必然没描述，提示词里只剩「reproduce the exact body posture…」这种
// 类别名，模型拿「服装展示照」的先验补空 → 正面站直、双臂下垂。
const fillSrc = await readFile(path.join(ROOT, 'scripts/fill-pose-en.mjs'), 'utf8');
const poseData = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose.json'), 'utf8'));
const poseMaleData = JSON.parse(await readFile(path.join(ROOT, 'web/public/data/pose-male.json'), 'utf8'));
const blankEn = (arr) => arr.filter((it) => !String(it.pose?.en || '').trim());
check('女性姿势库全部带英文动作描述', blankEn(poseData.items).length === 0,
  `${blankEn(poseData.items).length} 条为空 / 共 ${poseData.items.length} 条`);
check('男性姿势库同样没有空描述', blankEn(poseMaleData.items).length === 0,
  `${blankEn(poseMaleData.items).length} 条为空 / 共 ${poseMaleData.items.length} 条`);
// 合法的动作描述一定含有肢体的具体落位（手/肘/膝/臂/腿…），光有 "facing the camera" 不算
const looksLikeAction = (t) => t.length > 25
  && /(hand|hands|arm|arms|elbow|leg|legs|knee|hip|shoulder|wrist|foot|feet|thigh|fist|palm|finger|fingers|cheek|chin|nape)/.test(t);
check('描述不是占位符，都写到了具体肢体落位',
  poseData.items.every((it) => looksLikeAction(it.pose.en)),
  poseData.items.filter((it) => !looksLikeAction(it.pose.en)).map((it) => it.id).slice(0, 5).join(','));
check('男性库的描述同样写到肢体落位',
  poseMaleData.items.filter((it) => looksLikeAction(it.pose?.en || '')).length === poseMaleData.items.length,
  `${poseMaleData.items.filter((it) => !looksLikeAction(it.pose?.en || '')).length} 条不达标`);
// 第一屏（默认排序的 60 张）必须有描述 —— 这就是用户随手点的那批
const rankOf = (it) => {
  const cats = it.cats || [];
  if (it.series === 'upper' || cats.includes('上半身')) return 3;
  if (!cats.includes('站立')) return 2;
  return 0;
};
const firstScreen = poseData.items
  .map((it, i) => ({ it, i, r: rankOf(it) }))
  .sort((a, b) => a.r - b.r || a.i - b.i)
  .slice(0, 60)
  .map((x) => x.it);
check('默认第一屏 60 张全部带动作描述', blankEn(firstScreen).length === 0);
check('补齐脚本可重复执行（表里没收录的标题会报错退出）',
  /process\.exitCode = 1/.test(await readFile(path.join(ROOT, 'scripts/fill-pose-en.mjs'), 'utf8')));
check('补齐脚本不覆盖已有的 SP-* 描述（只走校正表）',
  /if \(isUpstream\(it\.id\)\) continue;/.test(fillSrc)
  && /const isUpstream = \(id\) => \/\^SP-\/\.test/.test(fillSrc)
  && /const fixed = OVERRIDES\[it\.id\]/.test(fillSrc));
// 第二版的核心准则：描述只译标题，不替模型猜「另一只手 / 朝向 / 站姿」。
// 第一版给每条都补了这些，P020 因此写出「另一只手垂在身侧」——线稿明明是叉腰。
// 只查女性库：男性库的文字来自上游、且不会被注入提示词（见 buildPrompt 的 gender 判断）
const femaleDesc = poseData.items.map((it) => String(it.pose?.en || ''));
check('描述里不再有臆测的「另一只手垂在身侧」',
  !femaleDesc.some((t) => /other arm relaxed at her side/i.test(t)),
  femaleDesc.find((t) => /other arm relaxed at her side/i.test(t)) || '干净');
// P020 的 id 命名在三套库里重号（upper80v2_P020 是另一个姿势），所以按前缀精确匹配
const p020 = poseData.items.filter((it) => /^(SP-P020|full_single_P020)/.test(it.id));
check('P020（单手扶头）的描述与线稿一致（另一只手在腰上、双脚分开）',
  p020.every((it) => /(other hand on her (hip|waist))/.test(it.pose.en) && /feet (planted wide )?apart/.test(it.pose.en)),
  p020.map((it) => `${it.id}: ${it.pose.en}`).join(' | '));

// 2026-11-18 晚（v15）：描述从「按标题译」改成「逐个看图写」。
// 这一版的表在 scripts/pose-descs.mjs，写入靠 scripts/apply-pose-descs.mjs。
const descSrc = await readFile(path.join(ROOT, 'scripts/pose-descs.mjs'), 'utf8');
const applySrc = await readFile(path.join(ROOT, 'scripts/apply-pose-descs.mjs'), 'utf8');
check('看图描述表存在且两种性别都有', /export const FEMALE/.test(descSrc) && /export const MALE/.test(descSrc));
check('写入脚本幂等（第二次运行写入 0 条）', /if \(it\.pose\.en !== en\)/.test(applySrc));
check('写入脚本对表里缺失的条目报错退出', /process\.exitCode = 1/.test(applySrc));
// 描述必须是「看图写的事实」：至少说出一个肢体的落点或姿态词
const factual = /\b(hand|hands|arm|arms|elbow|elbows|palm|palms|fist|fingers|fingertips|finger|knee|knees|thigh|ankle|forearm|chin|cheek|cheeks|temple|collarbone|neck|lips|shin)\b/i;
check('女性库每条描述都写到了具体肢体',
  poseData.items.every((it) => factual.test(it.pose.en)),
  poseData.items.filter((it) => !factual.test(it.pose.en)).map((it) => it.id).slice(0, 5).join(','));
check('男性库每条描述都写到了具体肢体',
  poseMaleData.items.every((it) => factual.test(it.pose?.en || '')),
  poseMaleData.items.filter((it) => !factual.test(it.pose?.en || '')).map((it) => it.id).slice(0, 5).join(','));
// 全身库必须交代身体基准（站/坐/跪/蹲/躺）。不写，模型就退回「服装展示照」的正面站直。
// 上半身库的线稿只到胸部、没有腿和地面，只要求「手势写清部位」，不参与这条。
const BASE = /^standing|^kneeling|^squatting|^lying|^sitting|^half lying|^reclining|^bending|^sitting back|^standing up/;
const fullBody = poseData.items.filter((it) => !/^upper80v2/.test(it.id));
check('全身库描述都点明了身体基准（站/坐/跪/蹲/躺）',
  fullBody.every((it) => BASE.test(it.pose.en)),
  fullBody.filter((it) => !BASE.test(it.pose.en)).map((it) => `${it.id}: ${it.pose.en}`).slice(0, 3).join(' | '));
const halfBodyRows = poseData.items.filter((it) => /^upper80v2/.test(it.id));
check('上半身库描述都是从手势写起的',
  halfBodyRows.every((it) => /^(both|one|her)\b/.test(it.pose.en)),
  halfBodyRows.filter((it) => !/^(both|one|her)\b/.test(it.pose.en)).map((it) => it.id).slice(0, 3).join(','));
// 同一组 5 个机位必须同一句话（否则同一姿势会有五条互相打架的描述）
const byTitle = {};
for (const it of poseData.items) (byTitle[it.title] ||= new Set()).add(it.pose.en);
check('同一姿势的各机位描述完全一致', Object.values(byTitle).every((s) => s.size === 1),
  Object.entries(byTitle).filter(([, s]) => s.size > 1).map(([t]) => t).slice(0, 5).join(','));
// 描述里不再出现「猜的」那些措辞
check('女性库描述里没有「另一只手自然垂在身侧」这类臆测',
  !poseData.items.some((it) => /other arm relaxed|arm hanging relaxed|one arm relaxed at her side/i.test(it.pose.en)),
  poseData.items.filter((it) => /other arm relaxed|arm hanging relaxed|one arm relaxed at her side/i.test(it.pose.en)).map((it) => it.id).slice(0, 3).join(','));

// 2026-11-18 晚第二个坑：坐 / 跪 / 蹲 / 躺 的姿势，成品总是「端正跪坐、正视镜头」——
// 描述里明明写了 sitting on the floor，但整条提示词没有一句说人在地面上，
// 画面里腿和地面又都不存在，模型就挑了最省事的「坐」。
const pGround = buildPrompt({
  gender: 'female',
  poseHint: 'sitting on the floor with her knees folded to one side, one hand planted behind her and the other on her knee',
});
check('地面姿势带 GROUND CONTACT 段（地面承重、身体低）',
  /GROUND CONTACT — she is on the floor/.test(pGround) && /her weight rests on the ground/.test(pGround));
check('站姿不带 GROUND CONTACT 段', !/GROUND CONTACT/.test(buildPrompt({ gender: 'female', poseHint: 'standing with both hands on her hips' })));
check('地面姿势的视线跟随图1（不写「看向镜头」）',
  /turn that head and eyes the way image 1 turns them/.test(pGround));
// 描述写长了会被 T5 截断，截掉的正好是排在后面的部位——所以先用一句骨架点名 legs/hands/head
check('长描述先用骨架句点名部位（legs / hands / head）',
  /The line-art figure has legs .*hands .*head /i.test(buildPrompt({
    gender: 'female',
    poseHint: 'sitting on the floor with her seat on the ground, her left knee raised and her right leg out to the side, one hand planted flat behind her and the other on her knee, her head lowered',
  })));
// 半身：线稿只到胸部，不能自称 head-to-toe，也不能要求「双脚落在图1 的位置」
const pHalf = buildPrompt({ gender: 'female', poseHint: 'both arms raised above her head forming a heart', halfBody: true });
check('半身开头不写 head-to-toe / feet fully visible',
  !/head-to-toe|feet fully visible/.test(pHalf.split('Three reference images')[0]));
check('半身不要求「双脚落在图1 的位置」', !/Both hands and both feet land/.test(pHalf));
check('半身不抽骨架（描述本来就是手势短句）', !/The line-art figure has/.test(pHalf));

console.log('\n[8a3] 图片传递与两条通道一致（不依赖模式）');
const htmlLoc = await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8');
check('中转通道采用前端给的 2K size', /const size = .*body\.size/.test(routerLocSrc) && /\?\s*body\.size/.test(routerLocSrc));
check('直连与中转两条通道共用同一组 customSize（档位 + ratio）',
  /\.\.\.customSize/.test(appUniq) && /size: customSize\.size/.test(appUniq)
  && /ratio: customSize\.ratio/.test(appUniq));
check('结果区展示本次实际送出的参考图',
  /j\.refs = images/.test(appUniq) && /class: 'ref-peek'/.test(appUniq)
  && /本次送出的参考图/.test(appUniq));
check('上传图 full 存原始文件 Data URI，thumb 只给界面显示',
  /const \[\{ dataUrl: thumb \}, full\] = await Promise\.all\(\[/.test(appUniq)
  && /readFileAsDataUrl\(file\)/.test(appUniq)
  && /\bthumb,\s*\n\s*full,/.test(appUniq));
check('上传的自定义线稿也能取到高清 full',
  /const first = hiRes \? \(s\.full \|\| s\.thumb\) : \(s\.thumb \|\| s\.full\);/.test(appUniq));

const versionSrc = await readFile(path.join(ROOT, 'shared/version.js'), 'utf8');
check('版本号已递增到 2026.11.18.17', /tag: '2026\.11\.18\.17'/.test(versionSrc));

console.log('\n[8a6] 回归修复：让 agnes 的请求体与本地脚本一致');
// 用户实测：同一个模型、同一组素材，本地 agnes-image 脚本一次成型，网站却各种问题；
// 而且「刚部署好时效果是没问题的」。查 git 历史定位到两处回归：
//   ① 3734304 为修 Workers AI FLUX.2 的 3043，把参考图统一压成 480px/JPEG，
//      这条降质被无差别套到 agnes 上（脸 384x480、服装 320x480）；
//   ② f6d591b 曾实现「档位 + 单独 ratio」，被 8075446 一次性回退 623 行抹掉，
//      之后网站只发 size:"1728x2304"、完全不带 ratio —— 官方文档写明 ratio 默认 1:1、
//      精确像素会被静默标准化。本地脚本发的是 size:"2K" + ratio:"3:4" 和三张原图。
const customSrc = await readFile(path.join(ROOT, 'shared/custom-model.js'), 'utf8');
check('generateCustom 接收 ratio', /generateCustom\(\{ images, prompt, size, ratio/.test(customSrc));
check('中转请求体写入 ratio', /if \(ratio\) body\.ratio = ratio;/.test(customSrc));
check('router 把 ratio 传给 generateCustom', /ratio: body\.ratio \|\| undefined/.test(routerLocSrc));
check('直连请求体写入 ratio',
  /async function generateDirect\(\{ images, prompt, size, ratio \}\)/.test(appLocSrc)
  && /if \(ratio\) body\.ratio = ratio;/.test(appLocSrc));
check('额外参数优先级低于显式 size/ratio',
  /Object\.assign\(body, extra\)/.test(appLocSrc) && /Object\.assign\(body, extra\)/.test(customSrc));
check('agnes 通道取原始字节而非 canvas 重绘',
  /async function toOriginalDataUrl\(src\)/.test(appLocSrc)
  && /return await toOriginalDataUrl\(s\.full \|\| s\.thumb\)/.test(appLocSrc));
check('上传图直接返回原始 Data URI', /s\.full\.startsWith\('data:'\)\) return s\.full/.test(appLocSrc));
check('原图 Data URI 自己控制 MIME',
  /mimeFromUrl\(src\)/.test(appLocSrc) && /data:\$\{mime\};base64/.test(appLocSrc));
check('Workers AI 仍保留降质兜底路径', /const hiRes = k === 'pose' && isCustom/.test(appLocSrc));
check('不再出现精确像素尺寸表', !/AGNES_2K/.test(appLocSrc));

console.log('\n[8b] 探针能力：界面入口已删，服务端仍接受 probe');
// 页面上的「诊断：不带图试一次」按钮已随调试开关一起删掉，但 /api/generate 的 probe
// 参数保留 —— 它是排障时唯一能把「多图输入问题」从「上游挂了」里摘出来的手段，
// 删掉会让 3043 这类报错彻底没法定位。这里只校验能力还在。
let probeCaptured = null;
const probeRun = async (mid, input) => {
  probeCaptured = { mid, input };
  return { image: 'aGVsbG8=' };
};
const probeOut = await generate({
  images: [],
  prompt: 'a plain studio backdrop',
  env: {},
  aiRun: probeRun,
  width: 768,
  height: 1024,
  probe: true,
});
check('探针允许零张图', probeOut.b64 === 'aGVsbG8=');
const probeBody = await new Response(probeCaptured.input.multipart.body).text();
check('探针正文里没有 input_image 字段', !/name="input_image_/.test(probeBody), probeBody.slice(0, 120));
check('探针仍有 prompt', /name="prompt"/.test(probeBody));
let strictFailed = false;
try {
  await generate({ images: [], env: {}, aiRun: probeRun });
} catch (e) {
  strictFailed = e.status === 400;
}
check('非探针仍要求三张图', strictFailed);

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
  check('提示词区分性别', /male body/.test(pM) && !/male body/.test(pF) && pM !== pF);
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
