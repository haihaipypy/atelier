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
import { buildPrompt, buildCloudflareForm, parseDataUrl, generate, DEFAULT_MODEL } from '../shared/generate.js';
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
}

console.log('\n[10] 自定义模型：URL 规范化');
check('补 /v1', normalizeBaseUrl('https://api.foo.com') === 'https://api.foo.com/v1');
check('去尾斜杠', normalizeBaseUrl('https://api.foo.com/v1/') === 'https://api.foo.com/v1');
check('缺协议自动补 https', normalizeBaseUrl('api.foo.com/v1') === 'https://api.foo.com/v1');
check('完整端点不改写', normalizeBaseUrl('https://a.com/v1/images/generations') === 'https://a.com/v1/images/generations');

console.log('\n[11] 自定义模型：保存校验');
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

console.log('\n[12] 自定义模型：KV 读写与脱敏');
const kv = fakeKV();
await saveProfile({ CONFIG: kv }, { baseUrl: 'api.demo.com', apiKey: 'sk-abcdefgh1234', model: 'my-model' });
const pub = await publicProfile({ CONFIG: kv });
check('保存后 configured=true', pub.configured === true);
check('baseUrl 已补全 /v1', pub.baseUrl === 'https://api.demo.com/v1', pub.baseUrl);
check('密钥被脱敏', pub.apiKeyMasked.includes('••••') && !pub.apiKeyMasked.includes('abcdefgh'), pub.apiKeyMasked);
check('前端拿不到明文密钥', !JSON.stringify(pub).includes('sk-abcdefgh'));
const cfgWithCustom = await (await handleRequest(new Request('https://x/api/config'), { CONFIG: kv })).json();
check('/api/config 反映自定义通道', cfgWithCustom.engine === 'custom' && cfgWithCustom.ready === true);

console.log('\n[13] 自定义模型：真实调用（本地假服务器）');
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

console.log('\n[14] 自定义模型：错误分类');
const srv2 = await startFakeImageServer({ fail: 401 });
try {
  await generateCustom({ images: [], prompt: 'x', size: '1024x1024', profile: { baseUrl: `http://127.0.0.1:${srv2.port}/v1`, apiKey: 'k', model: 'm', ready: true } });
  check('401 应抛错', false);
} catch (e) {
  check('401 → 提示 Key 无效', e.status === 400 && /Key 无效/.test(e.message), e.message);
} finally {
  await srv2.close();
}

console.log('\n[15] 图片代理：白名单与错误处理');
{
  const bad = await handleRequest(new Request('https://x/api/proxy?url=' + encodeURIComponent('https://evil.example/a.png')), {});
  check('非白名单域名被拒绝', bad.status === 403, `status=${bad.status}`);
  const invalid = await handleRequest(new Request('https://x/api/proxy?url=not-a-url'), {});
  check('非法 URL 返回 400', invalid.status === 400, `status=${invalid.status}`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
if (fail) process.exit(1);
