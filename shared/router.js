/**
 * HTTP 层：把 Web 标准的 Request 映射到 /api/config 与 /api/generate。
 * 只用 Web 标准 API（fetch / Request / Response / FormData），Node 里也能直接跑 dry-run。
 */

import { generate, buildPrompt, MODELS, DEFAULT_MODEL, HttpError, assertThreeImages } from './generate.js';
import { makeDemoImage } from './demo-image.js';
import {
  readProfile,
  publicProfile,
  saveProfile,
  clearProfile,
  generateCustom,
  normalizeBaseUrl,
} from './custom-model.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** /api/proxy 允许转发的素材源域名（与 scripts/sync-catalogs.mjs 的上游一致） */
const ALLOWED_IMAGE_HOSTS = new Set([
  'ai-costume-gallery.pages.dev',
  'ai-portrait-gallery.pages.dev',
  'ai-pose-gallery.pages.dev',
]);

/**
 * 探测运行环境能力。
 * 有 AI binding → 真实生成；没有 → 演示模式（前端会明确标注）。
 * 这样仓库 Clone 下来即使没配账号也能完整走通 UI，不会静默出错。
 */
export async function resolveBackends(env = {}) {
  const cfReady = !!(env.AI && typeof env.AI.run === 'function');
  const custom = await readProfile(env);
  const model = cfReady ? env.FLUX_MODEL || DEFAULT_MODEL : null;
  return {
    ready: cfReady || custom.ready,
    demo: !(cfReady || custom.ready),
    model,
    modelLabel: Object.values(MODELS).find((m) => m.modelId === model)?.label || model,
    models: Object.values(MODELS),
    repo: env.REPO_URL || '',
    engines: [
      ...(custom.ready ? ['custom'] : []),
      ...(cfReady ? ['cloudflare'] : []),
    ],
    engine: custom.ready ? 'custom' : cfReady ? 'cloudflare' : null,
    custom: {
      configured: custom.ready,
      model: custom.model,
      baseUrl: custom.baseUrl,
      source: custom.source,
    },
  };
}

export async function handleRequest(request, env = {}, aiRun = null) {
  const url = new URL(request.url);

  if (url.pathname === '/api/config' && request.method === 'GET') {
    return json(await resolveBackends(env));
  }

  /* ── 自定义模型配置 ─────────────────────────────── */
  if (url.pathname === '/api/model' && request.method === 'GET') {
    return json(await publicProfile(env));
  }

  if (url.pathname === '/api/model' && request.method === 'POST') {
    try {
      const body = await request.json();
      return json(await saveProfile(env, body));
    } catch (e) {
      return json({ error: e.message || '保存失败', detail: e.detail ?? null },
        e instanceof HttpError ? e.status : 400);
    }
  }

  if (url.pathname === '/api/model' && request.method === 'DELETE') {
    try {
      return json(await clearProfile(env));
    } catch (e) {
      return json({ error: e.message || '清除失败' }, 500);
    }
  }

  // 连通性测试：只做一次极小的文生图，验证 baseURL / key / model 是否正确
  if (url.pathname === '/api/model/test' && request.method === 'POST') {
    try {
      const body = await request.json().catch(() => ({}));
      const cfg = body.baseUrl
        ? {
            baseUrl: normalizeBaseUrl(body.baseUrl),
            apiKey: String(body.apiKey || ''),
            model: String(body.model || ''),
            ready: !!(body.baseUrl && body.apiKey && body.model),
            sendMode: body.sendMode || 'auto',
            extraJson: '',
          }
        : await readProfile(env);
      if (!cfg.ready) throw new HttpError(400, '请先填写 Base URL、API Key 与模型名');
      const out = await generateCustom({
        images: [],
        prompt: 'a small red dot on a white background, minimal',
        size: '1024x1024',
        profile: cfg,
      });
      return json({ ok: true, ms: out.ms, sample: `data:${out.mime};base64,${out.b64}` });
    } catch (e) {
      return json(
        { ok: false, error: e.message || '测试失败', detail: e.detail ?? null },
        e instanceof HttpError ? e.status : 500,
      );
    }
  }

  if (url.pathname === '/api/prompt' && request.method === 'GET') {
    const style = url.searchParams.get('style') || 'photorealistic';
    const extra = url.searchParams.get('extra') || '';
    return json({ prompt: buildPrompt({ style, extra }) });
  }

  /**
   * 素材图片代理。
   * 浏览器把跨域图读进 <canvas> 时，受 CORS 与连接并发影响会偶发卡死（既不 load 也不 error），
   * 导致「参考图准备中」永久挂起。服务端 fetch 不受 CORS 约束，由这里统一转发即可根治。
   * 只允许白名单域名，避免被当成任意 URL 的开放代理。
   */
  if (url.pathname === '/api/proxy' && request.method === 'GET') {
    const target = url.searchParams.get('url') || '';
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return json({ error: '无效的图片地址' }, 400);
    }
    if (!ALLOWED_IMAGE_HOSTS.has(parsed.hostname) || parsed.protocol !== 'https:') {
      return json({ error: '该域名不在允许列表内' }, 403);
    }
    try {
      const upstream = await fetch(parsed, {
        headers: { accept: 'image/webp,image/png,image/jpeg,*/*' },
        cf: { cacheEverything: true, cacheTtl: 86400 },
      });
      if (!upstream.ok) return json({ error: `上游返回 ${upstream.status}` }, 502);
      const headers = new Headers(upstream.headers);
      headers.set('cache-control', 'public, max-age=86400');
      headers.set('access-control-allow-origin', '*');
      headers.delete('set-cookie');
      return new Response(upstream.body, { status: 200, headers });
    } catch (e) {
      return json({ error: `图片获取失败：${e.message}` }, 502);
    }
  }

  if (url.pathname === '/api/generate' && request.method === 'POST') {
    const started = Date.now();
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '请求体必须是 JSON' }, 400);
    }

    const backends = await resolveBackends(env);

    // 演示模式：既没有自定义模型也没绑定 AI 时拼一张「布局预览图」，让交互可以完整走通。
    // 校验前置，保证演示模式与真实生成的入参规则一致（避免演示能过、上线才报错）。
    if (!backends.ready) {
      try {
        assertThreeImages(body.images);
        const image = await makeDemoImage({ images: body.images, width: body.width, height: body.height });
        return json({
          image,
          demo: true,
          model: 'none (demo layout)',
          ms: Date.now() - started,
        });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        return json({ error: e.message || '演示模式渲染失败', detail: e.detail ?? null }, status);
      }
    }

    try {
      // 通道优先级：请求指定 > 自定义模型 > Workers AI
      const wantCustom =
        body.engine === 'custom' || (!body.engine && backends.engine === 'custom');

      if (wantCustom) {
        const profile = await readProfile(env);
        if (!profile.ready) throw new HttpError(400, '自定义模型尚未配置完整');
        assertThreeImages(body.images);
        const out = await generateCustom({
          images: body.images,
          prompt: body.prompt || buildPrompt({ style: body.style, extra: body.extra }),
          size: `${body.width || 1024}x${body.height || 1024}`,
          profile,
          signal: AbortSignal.timeout(Number(env.CUSTOM_TIMEOUT_MS || 120000)),
        });
        return json({
          image: `data:${out.mime};base64,${out.b64}`,
          model: out.model,
          engine: 'custom',
          ms: out.ms,
          prompt: out.prompt,
        });
      }

      const out = await generate({
        images: body.images,
        model: body.model,
        prompt: body.prompt || undefined,
        style: body.style,
        extra: body.extra,
        width: body.width || 1024,
        height: body.height || 1024,
        seed: body.seed,
        env,
        aiRun: aiRun || env.AI?.run?.bind(env.AI),
      });
      return json({
        image: `data:${out.mime || 'image/png'};base64,${out.b64}`,
        model: out.model,
        ms: out.ms ?? Date.now() - started,
        prompt: out.prompt,
      });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      console.error('[generate]', e?.message, e?.detail ? JSON.stringify(e.detail).slice(0, 800) : '');
      return json({ error: e.message || '生成失败', detail: e.detail ?? null }, status);
    }
  }

  if (url.pathname.startsWith('/api/')) return json({ error: 'Not Found' }, 404);

  return null; // 交给静态资源处理
}

/** 统一给静态响应补上缓存头 */
export function withStaticHeaders(response, pathname) {
  if (!response) return response;
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  const ext = pathname.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
  const headers = new Headers(response.headers);
  if (ext && types[ext] && !headers.has('content-type')) headers.set('content-type', types[ext]);
  // 图库 JSON 每天同步更新，不能长缓存：允许本地缓存但每次都要回源校验（配合 ETag），
  // 否则用户会长时间看到旧版数据（例如分类仍是日文、条数还是旧的）。
  const isData = /\/data\/.*\.json$/.test(pathname);
  const isSample = /\/samples\//.test(pathname);
  if (isData) headers.set('cache-control', 'no-cache');
  else headers.set('cache-control', isSample ? 'public, max-age=86400' : 'public, max-age=300');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, { status: response.status, headers });
}
