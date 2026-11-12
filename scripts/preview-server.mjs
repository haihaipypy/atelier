/**
 * 本地/预览用 HTTP 服务：Node 标准库实现，把静态资源与 /api/* 挂到同一端口。
 * 生产环境不用它——生产是 Cloudflare Worker（worker/index.js）。
 *
 * 监听 PORT 环境变量（默认 8099），绑定 0.0.0.0 以便容器外访问。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handleRequest } from '../shared/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUB = path.join(ROOT, 'web/public');
const PORT = Number(process.env.PORT || 8099);

/** 代理图片的内存缓存（仅预览服务器用，生产由 Cloudflare 边缘缓存承担） */
const proxyCache = new Map();
const PROXY_TTL = 6 * 60 * 60 * 1000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    // 图片代理在本地要自己缓存：生产环境有 Cloudflare 边缘缓存，本地回源到海外 CDN 单张要 2–3 秒
    if (url.pathname === '/api/proxy' && req.method === 'GET') {
      const key = url.searchParams.get('url') || '';
      const hit = proxyCache.get(key);
      if (hit && Date.now() - hit.at < PROXY_TTL) {
        res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'public, max-age=86400' });
        res.end(hit.buf);
        return;
      }
      const out = await handleRequest(
        new Request(url, { method: 'GET', headers: req.headers }),
        process.env,
      ).catch(() => null);
      if (out && out.ok) {
        const buf = Buffer.from(await out.arrayBuffer());
        if (buf.length < 8 * 1024 * 1024) proxyCache.set(key, { buf, at: Date.now(), type: out.headers.get('content-type') || 'application/octet-stream' });
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(buf);
        return;
      }
      if (out) {
        res.writeHead(out.status, Object.fromEntries(out.headers));
        res.end(Buffer.from(await out.arrayBuffer()));
        return;
      }
      res.writeHead(502).end('{"error":"proxy failed"}');
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    try {
      const out =
        (await handleRequest(
          new Request(url, {
            method: req.method,
            headers: req.headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          }),
          process.env,
        )) || new Response('{"error":"Not Found"}', { status: 404 });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  // 静态资源：防目录穿越
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.join(PUB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const buf = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': /\/(data|samples)\//.test(rel) ? 'public, max-age=3600' : 'no-cache',
    });
    res.end(buf);
  } catch {
    // 单页回退
    if (!rel.includes('.')) {
      try {
        const idx = await readFile(path.join(PUB, 'index.html'));
        res.writeHead(200, { 'content-type': TYPES['.html'] });
        res.end(idx);
        return;
      } catch {}
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`preview on http://0.0.0.0:${PORT}`));
