/**
 * 通道解析：优先用「自定义 OpenAI 兼容接口」，没有则回落 Workers AI。
 *
 * 为什么自定义通道的密钥放服务端：
 *   用户填的 baseURL / apiKey 如果留在 localStorage，任何 XSS 或浏览器插件都能读到。
 *   这里改为「前端提交 → 服务端校验并保存在 Worker 侧（KV 或环境变量）」，
 *   返回给前端的只有脱敏信息（尾号 4 位）。个人项目最简做法见 README 的配置说明。
 *
 * 同时支持两种存法：
 *   1. 环境变量（部署时写死，最稳）：
 *        CUSTOM_BASE_URL / CUSTOM_API_KEY / CUSTOM_MODEL
 *   2. KV（页面里填，随时改）：binding 名 CONFIG，键名 profile
 */

import { HttpError } from './generate.js';

const KEY = 'profile';

/** 规范化 baseURL：去掉末尾斜杠，缺 /v1 时补上（常见坑） */
export function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  // 已经是完整的 generations 端点就直接用
  if (/\/images\/generations$/.test(u)) return u;
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

export function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  return s.length <= 8 ? '••••' : `${s.slice(0, 3)}••••${s.slice(-4)}`;
}

/** 读配置：env 优先，其次 KV。返回内部完整配置（含密钥，勿下发前端） */
export async function readProfile(env = {}) {
  let stored = null;
  if (env.CONFIG?.get) {
    try {
      stored = await env.CONFIG.get(KEY, 'json');
    } catch {
      stored = null;
    }
  }
  const merged = {
    baseUrl: env.CUSTOM_BASE_URL || stored?.baseUrl || '',
    apiKey: env.CUSTOM_API_KEY || stored?.apiKey || '',
    model: env.CUSTOM_MODEL || stored?.model || '',
    sendMode: env.CUSTOM_SEND_MODE || stored?.sendMode || 'auto', // auto | url | b64
    extraJson: stored?.extraJson || '',
  };
  const ready = !!(merged.baseUrl && merged.apiKey && merged.model);
  return { ...merged, ready, source: env.CUSTOM_API_KEY ? 'env' : stored ? 'kv' : 'none' };
}

/** 下发前脱敏 */
export async function publicProfile(env = {}) {
  const p = await readProfile(env);
  return {
    configured: p.ready,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKeyMasked: maskKey(p.apiKey),
    sendMode: p.sendMode,
    source: p.source,
    // 没配 KV 时页面无法保存，只能靠环境变量
    canPersist: !!env.CONFIG?.put,
  };
}

export async function saveProfile(env, body = {}) {
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const apiKey = String(body.apiKey || '').trim();
  const model = String(body.model || '').trim();
  const sendMode = ['auto', 'url', 'b64'].includes(body.sendMode) ? body.sendMode : 'auto';

  if (!baseUrl) throw new HttpError(400, '请填写 Base URL');
  if (!model) throw new HttpError(400, '请填写模型名称');
  try {
    new URL(baseUrl);
  } catch {
    throw new HttpError(400, 'Base URL 格式不正确');
  }
  // 只允许 http(s)，防止把请求打到 file:// 等协议
  if (!/^https?:\/\//i.test(baseUrl)) throw new HttpError(400, 'Base URL 必须是 http/https 地址');

  const prev = env.CONFIG?.get ? await env.CONFIG.get(KEY, 'json').catch(() => null) : null;
  const profile = {
    baseUrl,
    apiKey: apiKey || prev?.apiKey || '',
    model,
    sendMode,
    extraJson: String(body.extraJson || '').slice(0, 2000),
  };
  if (!profile.apiKey) throw new HttpError(400, '请填写 API Key');

  if (!env.CONFIG?.put) {
    throw new HttpError(501, '当前部署未绑定 KV，无法在页面保存。请改用环境变量 CUSTOM_* 配置', {
      hint: 'wrangler.jsonc 增加 kv_namespaces 绑定 CONFIG 后即可在页面保存',
    });
  }
  await env.CONFIG.put(KEY, JSON.stringify(profile));
  return publicProfile(env);
}

export async function clearProfile(env) {
  if (env.CONFIG?.delete) await env.CONFIG.delete(KEY);
  return publicProfile(env);
}

/**
 * 调自定义 OpenAI 兼容图像接口。
 *
 * 兼容三种主流返回：
 *   A. { data: [{ url }] }            —— OpenAI DALL·E / 多数聚合网关
 *   B. { data: [{ b64_json }] }       —— 指定 response_format=b64_json
 *   C. { created, images: [...] } / { output: [...] } —— 部分自建服务
 *
 * 参考图的传递方式各家不同，因此 sendMode 提供三档：
 *   url  —— 参考图走 extra_body.image 的 https URL（需要图有公网地址）
 *   b64  —— 参考图走 data URI（最通用，本项目的默认：前端已压缩到 <512）
 *   auto —— 先用 b64，遇到「不支持图生图」类错误再提示用户切换
 */
export async function generateCustom({ images, prompt, size, profile, signal }) {
  if (!profile.ready) throw new HttpError(400, '自定义模型尚未配置完整');

  const endpoint = /\/images\/generations$/.test(profile.baseUrl)
    ? profile.baseUrl
    : `${profile.baseUrl}/images/generations`;

  let extra = {};
  if (profile.extraJson) {
    try {
      extra = JSON.parse(profile.extraJson);
    } catch {
      throw new HttpError(400, '额外参数不是合法 JSON');
    }
  }

  const body = {
    model: profile.model,
    prompt,
    n: 1,
    size,
    ...extra,
  };

  // 多图输入：放进 extra_body.image（与 Agnes / 多数聚合网关一致）
  if (images?.length) {
    body.extra_body = { ...(body.extra_body || {}), image: images };
  }
  // 明确要 base64，省掉二次下载
  body.extra_body = { ...(body.extra_body || {}), response_format: 'b64_json' };

  const started = Date.now();
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new HttpError(502, `连接自定义接口失败：${e.message}`);
  }

  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* 非 JSON，下面统一处理 */
  }

  if (!res.ok) {
    // 上游原文一定要带出去：403 这类错误的真正原因只在上游 message / code 里
    const upstream = String(json?.error?.message || json?.message || raw || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    const code = String(json?.error?.code || json?.error?.type || '').trim();
    const hint =
      res.status === 401
        ? 'API Key 无效或已过期'
        : res.status === 402
          ? '账户余额不足'
          : res.status === 403
            ? '密钥无权访问该模型，或服务商拦截了来源地区/IP（云函数出口 IP 被拦是常见原因）'
            : res.status === 404
              ? `接口路径不存在，当前请求 ${endpoint}。请确认 Base URL 是否需要带 /v1`
              : res.status === 429
                ? '触发限流或额度用尽'
                : res.status === 400 || res.status === 422
                  ? '上游不接受这组参数（size / model / response_format 可能不支持）'
                  : '';
    const detail = upstream ? `（上游：${upstream}${code ? ` · ${code}` : ''}）` : '';
    // 4xx 是配置或凭据问题，不该当成网关故障（502）报给前端
    const status = res.status === 429 ? 429 : res.status >= 500 ? 502 : 400;
    throw new HttpError(status, `自定义模型返回 ${res.status}${hint ? '：' + hint : ''}${detail}`, {
      upstream,
      code,
      upstreamStatus: res.status,
      endpoint,
      model: profile.model,
    });
  }

  const item = json?.data?.[0] || json?.images?.[0] || json?.output?.[0] || null;
  let b64 = item?.b64_json || item?.base64 || (typeof item === 'string' ? null : null);
  const url = item?.url || (typeof item === 'string' ? item : null);

  if (!b64 && url) {
    // URL 模式：服务端转一次 base64，避免前端跨域拿不到
    const img = await fetch(url, { signal });
    if (!img.ok) throw new HttpError(502, `图片下载失败（${img.status}）`);
    const buf = new Uint8Array(await img.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    b64 = btoa(bin);
  }
  if (!b64) throw new HttpError(502, '自定义模型返回里没找到图片字段', { shape: Object.keys(json || {}) });

  return {
    b64: b64.replace(/^data:[^;]+;base64,/, ''),
    mime: 'image/png',
    model: profile.model,
    prompt,
    ms: Date.now() - started,
    engine: 'custom',
  };
}
