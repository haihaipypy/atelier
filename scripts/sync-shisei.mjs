#!/usr/bin/env node
/**
 * Shisei 素材接入（男装 / 中性装 / 中性姿势）。
 *
 * 为什么单独一个脚本
 *   上游图库（ai-costume / ai-portrait / ai-pose）只提供女性向素材，且图片不可再分发，
 *   所以那边只能存「元数据 + 外链」。Shisei 不一样：它的图片是 CC0 1.0（放弃著作权），
 *   代码 Apache-2.0，明确允许再分发，因此可以按需下载并随站点分发 —— 这样国内访问
 *   不依赖 raw.githubusercontent.com，也不会被上游限流。
 *
 * 授权要点（见 THIRD-PARTY-NOTICES.md）
 *   · 图片：CC0 1.0，商用/修改/再分发均免费，不要求署名（本项目仍署名）
 *   · 姿势目录（编号、名称、分类）：沿用 ai-pose-gallery 的公开目录，Shisei 未获得授权、
 *     只注明出处。本项目只引用名称，不引用对方图片，与现有姿势库的处理方式一致。
 *   · 仅收录 rating=general；suggestive 系列（sexy / duo）与内衣类（LG）一律不收。
 *
 * 用法
 *   node scripts/sync-shisei.mjs             # 拉目录 + 下载缩略图 + 写 data/*.json
 *   node scripts/sync-shisei.mjs --no-images # 只更新索引，图片沿用本地已有文件
 */

import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'web/public/data');
const LIB_DIR = path.join(ROOT, 'web/public/library');

/** 锁版本：目录与图片必须来自同一个 tag，否则 id 与文件名会错位 */
const TAG = 'v0.4.1';
/**
 * 走 jsDelivr 而不是 raw.githubusercontent：
 * 后者在本机与国内网络都经常连不上，jsDelivr 实测稳定（且对国内友好）。
 */
const CDN = `https://cdn.jsdelivr.net/gh/wquguru/shisei@${TAG}`;
const IMG = `${CDN}/images`;

const CONCURRENCY = 10;

/** Shisei 没有男性姿势：std 系列是女性全身素体，upper 系列连双腿都不画（只到腰胯） */
const POSE_GENDER = 'F';
const POSE_GENDER_NOTE =
  '此库暂为女性素体；男性版只能借用其骨架，性别由脸与提示词决定';

/** 服装大类 → 中文分类（LG 内衣不收，故不列） */
const CAT_ZH = {
  AC: '配饰',
  FM: '西装礼服',
  FN: '幻想骑士',
  FS: '节庆',
  HC: '中华传统',
  IN: '家居服',
  MD: '现代休闲',
  SP: '运动',
  WE: '东亚传统',
  WH: '世界历史',
  WK: '职业装',
};

const ANGLE_ZH = { front: '正面', diag: '斜侧', side: '侧面', above: '俯视', below: '仰视' };

const GENDER_ZH = { M: '男装', F: '女装', U: '中性' };

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'atelier-compose-sync/0.2' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 并发下载，跳过已存在的文件（重复执行只补缺） */
async function downloadAll(jobs, { skipExisting = true } = {}) {
  let done = 0;
  let skipped = 0;
  let failed = 0;
  const queue = [...jobs];

  async function worker() {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const { url, file } = job;
      try {
        if (skipExisting && (await exists(file))) {
          skipped++;
          continue;
        }
        const r = await fetch(url, { headers: { 'user-agent': 'atelier-compose-sync/0.2' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, buf);
        done++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.warn(`  ! 下载失败 ${path.basename(file)}：${e.message}`);
      }
      if ((done + skipped + failed) % 100 === 0) {
        console.log(`  · 进度 ${done + skipped + failed}/${jobs.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { done, skipped, failed };
}

/** 服装 → 前端条目。thumb 用本地打包的 w300，full 指向远端 w900（拿不到时前端回落 thumb） */
function costumeItem(it, { idPrefix }) {
  const id = `${idPrefix}-${it.id}`;
  const file = `sc-${it.id}`;
  const view = it.views?.front || Object.values(it.views || {})[0];
  const fullName = view ? view.replace('/w300/', '/w900/') : '';
  return {
    id,
    code: it.id,
    title: it.name_zh || it.name_en || it.id,
    thumb: `/library/costume/${file}.webp`,
    full: view ? `${IMG}/costume/grey/w900/${fullName.replace(/^.*\//, '')}` : `/library/costume/${file}.webp`,
    cats: [CAT_ZH[it.cat] || '服装'],
    tags: [it.era_zh, GENDER_ZH[it.gender]].filter(Boolean),
    src: 'shisei',
    license: 'CC0-1.0',
    _remote: view ? `${IMG}/costume/grey/w300/${view.replace(/^.*\//, '')}` : '',
  };
}

/** 姿势 → 前端条目（一个机位一条，和现有姿势库的粒度一致） */
function poseItem(it, view) {
  const id = `SP-${it.id}-${view}`;
  const name = it.views?.[view] || '';
  return {
    id,
    code: it.id,
    title: it.name_cn || it.name_en || it.id,
    angle: ANGLE_ZH[view] || view,
    thumb: `/library/pose/${id}.webp`,
    full: name ? `${IMG}/line/w900/${name}` : '',
    cats: [it.class_cn || '姿势'],
    tags: [it.class_cn, it.name_en].filter(Boolean).slice(0, 3),
    series: it.series,
    // 上游的英文姿态描述，例如 "sitting on the floor leaning back with her torso arched…"。
    // 这张人偶是女性素体（画了胸部曲线），描述里的 her / she 会把性别一起带进提示词，
    // 生成时和「成年男性」冲突——所以留英文原文备用，另存一份中性化的中文要点。
    pose: {
      en: it.desc_en || '',
      zh: poseZh(it).slice(0, 60),
    },
    src: 'shisei',
    license: 'CC0-1.0',
    _remote: name ? `${IMG}/line/w300/${name}` : '',
  };
}

/**
 * 姿态要点（中文）。
 *
 * 为什么不直接用上游 desc_en：那是给女性素体写的（159/181 条带 her），直接塞进
 * 男性版提示词会和「成年男性」打架，模型往往退回成站立。这里只保留「哪只手撑地、
 * 哪条腿屈/伸、躯干朝哪边倾」这类与性别无关的骨架信息，
 * 并把代词统一换成中性词，避免把性别一起带进去。
 */
function poseZh(it) {
  const classZh = it.class_cn || '姿势';
  const nameZh = it.name_cn || it.name_en || '';
  const desc = neutralDesc(it.desc_en);
  return `${classZh}｜${nameZh}${desc ? `；${desc}` : ''}`;
}

/** 英文描述的中性化：代词替换 + 女性专属造型词剔除 */
function neutralDesc(src) {
  return String(src || '')
    .replace(/\b(her|she|hers|herself)\b/gi, 'the figure')
    // 这些词只出现在女性造型上，男性版照抄会把性别带偏
    .replace(/\b(heart[ -]?shaped?|hearts?|cute|kawaii)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*,/g, ',')
    .trim();
}


function strip(items) {
  return items.map(({ _remote, ...rest }) => rest);
}

function writeCatalog(file, { label, homepage, items, extra = {} }) {
  return writeFile(
    path.join(OUT_DIR, file),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: 'live',
        origin: 'bundled',
        source: { label, homepage, license: 'CC0-1.0' },
        count: items.length,
        ...extra,
        items,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const noImages = process.argv.includes('--no-images');
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`拉取 Shisei 目录（${TAG}）…`);
  const [costumes, poses] = await Promise.all([
    getJson(`${CDN}/data/costumes.json`),
    getJson(`${CDN}/data/catalog.json`),
  ]);

  // ── 服装：只收 general，排除内衣类
  const usableCostumes = costumes.items.filter(
    (it) => it.rating !== 'suggestive' && it.cat !== 'LG' && it.views?.front,
  );
  const maleCostumes = usableCostumes.filter((it) => it.gender === 'M' || it.gender === 'U');
  const femaleCostumes = usableCostumes.filter((it) => it.gender === 'F' || it.gender === 'U');
  console.log(
    `服装：可用 ${usableCostumes.length}（男/中性 ${maleCostumes.length}，女/中性 ${femaleCostumes.length}）`,
  );

  // ── 姿势：只要单人系列（std / upper），duo 是双人、sexy 是成人向
  const usablePoses = poses.filter((it) => ['std', 'upper'].includes(it.series) && it.rating !== 'suggestive');
  const poseViews = ['front', 'diag'];
  console.log(`姿势：可用 ${usablePoses.length} 套 × ${poseViews.length} 机位`);

  const maleOutfits = maleCostumes.map((it) => costumeItem(it, { idPrefix: 'SC' }));
  const femaleOutfits = femaleCostumes.map((it) => costumeItem(it, { idPrefix: 'SC' }));
  const malePoses = usablePoses.flatMap((it) =>
    poseViews.filter((v) => it.views?.[v]).map((v) => poseItem(it, v)),
  );
  // upper 系列只画到腰部，配「全身照」会得到一张半身图；分类名改成能看懂的样式
  for (const it of malePoses) {
    if (it.series !== 'upper') continue;
    it.cats = ['上半身'];
    it.pose.zh = `上半身｜${it.title}；${neutralDesc(String(it.pose.zh).split('；').slice(1).join('；'))}`.trim();
  }

  if (!noImages) {
    console.log('下载缩略图（w300）→ web/public/library …');
    const jobs = [
      ...maleOutfits.map((it) => ({
        url: it._remote,
        file: path.join(ROOT, 'web/public', it.thumb.replace(/^\//, '')),
      })),
      ...femaleOutfits.map((it) => ({
        url: it._remote,
        file: path.join(ROOT, 'web/public', it.thumb.replace(/^\//, '')),
      })),
      ...malePoses.map((it) => ({
        url: it._remote,
        file: path.join(ROOT, 'web/public', it.thumb.replace(/^\//, '')),
      })),
    ].filter((j) => j.url);
    const res = await downloadAll(jobs);
    console.log(`  ✓ 新下载 ${res.done}，已存在 ${res.skipped}，失败 ${res.failed}`);
    if (res.failed) console.warn(`  ! 有 ${res.failed} 张失败，重跑脚本即可补齐`);
  }

  await writeCatalog('outfit-male.json', {
    label: '男装',
    homepage: 'https://github.com/wquguru/shisei',
    items: strip(maleOutfits),
  });
  await writeCatalog('pose-male.json', {
    label: '姿势（男性版借用女性素体骨架）',
    homepage: 'https://github.com/wquguru/shisei',
    items: strip(malePoses),
    // 这是个「借用库」：上游没有男性姿势，男的只能拿女性素体的骨架用。
    // 标出来，前端才能对用户讲清楚「图是女性的，但性别由脸决定」。
    extra: { note: POSE_GENDER_NOTE, poseGender: POSE_GENDER },
  });
  console.log(`  ✓ outfit-male: ${maleOutfits.length} 条`);
  console.log(`  ✓ pose-male: ${malePoses.length} 条`);

  // ── 并入女性姿势库：Shisei 的 std 系列是全身女性素体，正好补女性版的站立/坐卧姿势
  const posePath = path.join(OUT_DIR, 'pose.json');
  const prevPose = JSON.parse(await readFile(posePath, 'utf8'));
  const keptPose = (prevPose.items || []).filter((it) => it.src !== 'shisei');
  const femalePoses = malePoses.filter((it) => it.series !== 'upper');
  const mergedPose = [...keptPose, ...femalePoses].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  prevPose.items = mergedPose;
  prevPose.count = mergedPose.length;
  prevPose.sources = [
    ...(prevPose.sources || []).filter((x) => x.label !== 'Shisei'),
    { label: 'Shisei', homepage: 'https://github.com/wquguru/shisei', license: 'CC0-1.0', count: femalePoses.length },
  ];
  await writeFile(posePath, JSON.stringify(prevPose, null, 2));
  console.log(`  ✓ pose（女性）: ${keptPose.length} + ${femalePoses.length} = ${mergedPose.length} 条`);

  // ── 并入女性服装库：保留原有上游条目，去除旧的本项目 Shisei 条目后重新追加
  const outfitPath = path.join(OUT_DIR, 'outfit.json');
  const prev = JSON.parse(await readFile(outfitPath, 'utf8'));
  const kept = (prev.items || []).filter((it) => it.src !== 'shisei');
  const merged = [...kept, ...strip(femaleOutfits)].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  prev.items = merged;
  prev.count = merged.length;
  prev.sources = [
    ...(prev.sources || []).filter((s) => s.label !== 'Shisei'),
    { label: 'Shisei', homepage: 'https://github.com/wquguru/shisei', license: 'CC0-1.0', count: femaleOutfits.length },
  ];
  await writeFile(outfitPath, JSON.stringify(prev, null, 2));
  console.log(`  ✓ outfit（女性）: ${kept.length} + ${femaleOutfits.length} = ${merged.length} 条`);

  // ── 汇总
  const metaPath = path.join(OUT_DIR, 'catalogs.json');
  let meta = {};
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {}
  meta.generatedAt = new Date().toISOString();
  meta.outfit = { count: merged.length, label: '服装' };
  meta['outfit-male'] = { count: maleOutfits.length, label: '男装' };
  meta['pose'] = { count: mergedPose.length, label: '姿势' };
  meta['pose-male'] = { count: malePoses.length, label: '姿势（男性版）', note: POSE_GENDER_NOTE };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  console.log('完成。');
}

main().catch((e) => {
  console.error('同步失败：', e);
  process.exit(1);
});
