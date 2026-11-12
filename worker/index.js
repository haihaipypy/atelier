/**
 * Cloudflare Worker 入口
 *  - /api/*  由共享路由处理
 *  - 其余请求用 Workers Static Assets（ASSETS 绑定）返回 web/public 的产物
 *
 * wrangler.jsonc 里 `assets.directory = "./web/public"`，
 * 这样无需单独构建步骤：克隆 → wrangler deploy 即可上线。
 */

import { handleRequest, withStaticHeaders } from '../shared/router.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const res = await handleRequest(request, env, env.AI?.run?.bind(env.AI));
      return res ?? new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // 静态资源：交给 ASSETS 绑定；找不到时回退到 index.html（单页）
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return withStaticHeaders(asset, url.pathname);

    if (request.method === 'GET' && !url.pathname.includes('.')) {
      const index = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
      return withStaticHeaders(index, '/index.html');
    }
    return asset;
  },
};
