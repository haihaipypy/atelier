#!/usr/bin/env node
/**
 * 图库索引同步：从上游图库抓取「条目列表 + 分类 + 标签」，生成本地索引。
 *
 * 版权立场（重要）
 *   上游图片版权归原作者，转载需授权。本仓库只保存「元数据 + 上游公开地址引用」，
 *   图片文件不进仓库。这样做的三个好处：
 *     1. Clone 后仓库只有几 MB，部署快、不占 Cloudflare/EdgeOne 的存储额度；
 *     2. 上游更新后重跑脚本即可，不会在仓库里留下过期副本；
 *     3. 不产生再分发风险。若要完全自主，把 SOURCES 换成自建图库即可，前端无需改动。
 *
 * 上游数据形态（实测 2026-11）
 *   outfit : 页面内 <script> 里内嵌 `const D=[{id,カテゴリ,キーワード,サムネ,原寸}]`
 *   pose   : 同上，`const D=[{id,系統,分類,ポーズ名,アングル,サムネ,原寸}]`
 *   face   : 独立脚本 data/images.js，`window.GALLERY_IMAGES = [...]`
 *
 * 用法
 *   node scripts/sync-catalogs.mjs              # 同步全部
 *   node scripts/sync-catalogs.mjs --only face  # 只同步一个库
 *   node scripts/sync-catalogs.mjs --offline    # 离线：写入内置样例，便于本地预览
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { zh, zhCats, zhTags } from '../web/public/i18n.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'web/public/data');
const UA = 'atelier-compose-catalog-sync/0.1';

export const SOURCES = {
  outfit: {
    label: '服装',
    homepage: 'https://ai-costume-gallery.pages.dev/',
    strategy: 'inline-D',
  },
  face: {
    label: '脸型',
    homepage: 'https://ai-portrait-gallery.pages.dev/',
    strategy: 'gallery-images',
  },
  pose: {
    label: '姿势',
    homepage: 'https://ai-pose-gallery.pages.dev/',
    strategy: 'inline-D',
  },
};

async function getText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

/** 从形如 `const D=[…]` 的脚本文本里截出 JSON 数组（括号配对，忽略字符串内的括号） */
function extractJsonArray(text, startIdx) {
  const open = text.indexOf('[', startIdx);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

const abs = (base, p) => (p ? new URL(p, base).href : '');

/**
 * 内容过滤：上游姿势库混入大量成人向条目（性行为体位等）。
 * 本项目定位是「服装 × 脸 × 姿势」的写真合成工具，需要能公开展示，
 * 因此按「分类命名」做白名单式排除——命中即整条丢弃，不做部分裁剪。
 * 排除名单用日文原词，避免翻译后误伤；如需完整库请自行调整此表。
 */
const BLOCKED_CATEGORY = [
  '正常位', '後背位', '騎乗位', '側位', '立位', '立位密着', '背面座位',
  '対面座位', '座位', '座位密着', '密着', '膝立ち', '膝站立', '特殊',
  'セクシー・露骨寄り系', '胸寄せ・谷間強調系', '全身1人・セクシー系',
  '2人絡み', '顔寄せ系',
];
/** 服装只排除「性感」主题；「内衣」属正常品类（居家/内搭），保留 */
const BLOCKED_OUTFIT = ['セクシー'];
const isBlocked = (cats = [], title = '') =>
  cats.some((c) => BLOCKED_CATEGORY.includes(c)) ||
  /露骨|ヌード|全裸|手ブラ|まんぐ|谷間/.test(String(title));

function normalizeOutfit(list, base) {
  return list.map((it) => ({
    rawCats: [it['カテゴリ']].filter(Boolean),
    rawTitle: it['キーワード'] || '',
    id: it.id,
    title: it.id,
    thumb: abs(base, it['サムネ']),
    full: abs(base, it['原寸'] || it['画像']),
    cats: zhCats([it['カテゴリ']].filter(Boolean)),
    // 服装标签原本是英文关键词（可直接当 prompt 弹药），保留原文并附上中文译名
    tags: String(it['キーワード'] || '').split(/\s+/).filter(Boolean).slice(0, 6),
    tagsZh: zhTags(String(it['キーワード'] || '').split(/\s+/).filter(Boolean).slice(0, 6)),
  }));
}

function normalizePose(list, base) {
  return list.map((it) => {
    const cats = zhCats([it['分類'], it['系統']].filter(Boolean));
    const tags = zhTags([it['アングル']].filter(Boolean));
    const nameZh = zh(it['ポーズ名'] || it.id, 'title');
    // 同一姿势有多个机位文件，标题会重复；视角不放进标题（会被截断），改由 UI 单独展示
    const angle = tags[0];
    return {
      rawCats: [it['分類'], it['系統']].filter(Boolean),
      rawTitle: it['ポーズ名'] || '',
      id: it.id,
      // 编号单独成字段；标题译成中文（原始日文保存在 rawTitle，便于回溯）
      code: it['ポーズ番号'] || '',
      title: nameZh,
      angle: angle || '',
      thumb: abs(base, it['サムネ']),
      full: abs(base, it['原寸']),
      cats,
      tags,
    };
  });
}

function normalizeFace(list, base) {
  return list
    .filter((it) => !it.section || it.section === 'face')
    .map((it) => ({
      id: it.id,
      title: it.style ? zh(it.style, 'text') : it.id,
      thumb: abs(base, it.thumb),
      full: abs(base, it.full),
      cats: zhCats([it.hair].filter(Boolean)),
      tags: [],
    }));
}

async function fetchCatalog(kind) {
  const src = SOURCES[kind];
  if (src.strategy === 'gallery-images') {
    const js = await getText(new URL('data/images.js', src.homepage).href);
    const raw = extractJsonArray(js, js.indexOf('='));
    if (!raw) throw new Error('images.js 结构变化，未找到数组');
    return normalizeFace(JSON.parse(raw), src.homepage);
  }
  const html = await getText(src.homepage);
  const idx = html.search(/const\s+D\s*=/);
  if (idx < 0) throw new Error('页面内未找到 const D= 数据块');
  const raw = extractJsonArray(html, idx);
  const list = JSON.parse(raw);
  return kind === 'outfit' ? normalizeOutfit(list, src.homepage) : normalizePose(list, src.homepage);
}

async function syncOne(kind, { offline }) {
  const src = SOURCES[kind];
  const fixture = path.join(ROOT, 'scripts/fixtures', `${kind}.sample.json`);
  let items;
  let mode = 'live';
  try {
    if (offline) throw new Error('offline');
    items = await fetchCatalog(kind);
    if (!items.length) throw new Error('上游返回 0 条');
  } catch (e) {
    mode = 'fixture';
    console.warn(`  ! ${kind} 线上同步失败（${e.message}），改用样例`);
    items = JSON.parse(await readFile(fixture, 'utf8')).items;
  }

  // 内容过滤（在原始分类尚未替换成中文前判断，因此对比归一化前的数据）
  if (kind === 'pose' || kind === 'outfit') {
    const before = items.length;
    items =
      kind === 'outfit'
        ? items.filter((it) => !(it.rawCats || []).some((c) => BLOCKED_OUTFIT.includes(c)))
        : items.filter((it) => !isBlocked(it.rawCats || [], it.rawTitle || ''));
    const removed = before - items.length;
    if (removed) console.log(`  · ${kind} 已过滤 ${removed} 条成人向内容`);
  }

  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  await writeFile(
    path.join(OUT_DIR, `${kind}.json`),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode,
      source: { label: src.label, homepage: src.homepage },
      count: items.length,
      items,
    }),
  );
  console.log(`  ✓ ${kind}: ${items.length} 条（${mode}）`);
  return items.length;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const onlyIdx = args.indexOf('--only');
  const kinds = onlyIdx >= 0 ? [args[onlyIdx + 1]] : Object.keys(SOURCES);

  await mkdir(OUT_DIR, { recursive: true });
  console.log('同步图库索引 →', OUT_DIR);

  const meta = {};
  for (const k of kinds) {
    if (!SOURCES[k]) throw new Error(`未知图库：${k}`);
    meta[k] = { count: await syncOne(k, { offline }), label: SOURCES[k].label };
  }
  // 保留未同步库的既有统计
  const metaPath = path.join(OUT_DIR, 'catalogs.json');
  let prev = {};
  if (existsSync(metaPath)) {
    try {
      prev = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch {}
  }
  const merged = { generatedAt: new Date().toISOString(), ...prev, ...meta };
  await writeFile(metaPath, JSON.stringify(merged, null, 2));
  console.log('完成。');
}

main().catch((e) => {
  console.error('同步失败：', e);
  process.exit(1);
});
