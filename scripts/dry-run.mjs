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
import { buildPrompt, buildCloudflareForm, parseDataUrl, generate, classifyAiFailure, clipPoseHint, DEFAULT_MODEL } from '../shared/generate.js';
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
check('男性版指出线稿是女性素体', /female artist mannequin/.test(pMale), pMale.slice(0, 120));
check('男性版要求忽略胸部与腰胯轮廓', /bust curve|waist-to-hip ratio/.test(pMale));
check('男性版禁止退回站姿', /Do not replace the pose with a standing/i.test(pMale));
check('姿态要点进入提示词', /intended pose in words[\s\S]*单膝竖起/.test(pHint), pHint.slice(-260));
check('姿态要点不越权改服装/脸', /never to override the outfit or the face/.test(pHint));
check('女性版不写这些男性专用说明', !/female artist mannequin/.test(buildPrompt({ gender: 'female' })));
check('要点超长会截断', clipPoseHint('x'.repeat(500)).length <= 201);

// 前端要真的把要点带上：漏传时后端拼不出那句「intended pose in words」
const appSrc = await readFile(path.join(ROOT, 'web/public/app.js'), 'utf8');
check('前端把姿态要点带进 /api/generate', /poseHint: poseHintFor\(state\.gender\)/.test(appSrc));
check('直连通道也带姿态要点', /const poseHint = poseHintFor\(state\.gender\);/.test(appSrc));
check('男性版要点附带「只取骨架」说明', /copy only its skeleton and camera/.test(appSrc));
check('姿势卡片悬停能看到要点', /it\.pose\?\.zh/.test(appSrc));
const poseMaleJson = await readFile(path.join(ROOT, 'web/public/data/pose-male.json'), 'utf8');
check('男性姿势库带「借用女性素体」标注', /poseGender/.test(poseMaleJson) && /女性素体/.test(poseMaleJson));
check('页面上有提示条', /此库是女性素体线稿/.test(appSrc) && /id="libNote"/.test(
  await readFile(path.join(ROOT, 'web/public/index.html'), 'utf8'),
));

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
  check('右上角有作者主页链接', /id="authorLink" href="https:\/\/www\.1day\.vip"/.test(html));
  check('项目地址旁有项目文档链接', /项目地址<\/a>\s*<a class="ghost" href="https:\/\/blog\.1day\.vip\/post\/ai-character-atelier"/.test(html));
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
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
if (fail) process.exit(1);
