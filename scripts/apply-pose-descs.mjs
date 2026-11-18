/**
 * 把 descs.mjs 里的「看图描述」写进姿势库（女性 + 男性）。
 *
 * 与 fill-pose-en.mjs 的分工：
 *   · fill-pose-en.mjs 是按**标题**译的初版（会有猜的部分），只在新增条目、还没看图时用；
 *   · 本脚本是**看图重写**的正式版，跑完就以本脚本为准。
 * 两者共用同一张 descs 表的话容易出现「先跑哪个」的歧义，所以这里写成独立的、幂等的一步：
 * 每次运行都按 descs 表整段覆盖，机位后缀（_diag/_front/_high/_low/_side）不影响取词。
 *
 * 用法：node scripts/apply-pose-descs.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { FEMALE, MALE } from './pose-descs.mjs';

const ROOT = new URL('../', import.meta.url);
const dry = process.argv.includes('--dry');

/** full_single_P020_diag → P020；upper80v2_P020_diag → U020；SP-P020-front → SP-P020 */
function keyOf(it) {
  const id = String(it.id || '');
  if (/^upper80v2_/.test(id)) return `U${(id.match(/P(\d+)/) || [])[1] || ''}`;
  // 男性库的编号有 SP-Pxxx 与 SP-Uxxx 两套，字母必须一起保留，否则 U 组会被算成 P 组
  // 男性库的编号有 SP-Pxxx 与 SP-Uxxx 两套，字母必须一起保留，否则 U 组会被算成 P 组
  if (/^SP-/.test(id)) return (id.match(/^SP-[PU]\d+/) || [id])[0];
  
  return `P${(id.match(/P(\d+)/) || [])[1] || ''}`;
}

function apply(file, table, label) {
  const path = new URL(file, ROOT);
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  let changed = 0;
  const missing = new Set();
  for (const it of data.items) {
    const k = keyOf(it);
    const en = table[k];
    if (!en) {
      missing.add(`${it.id} (${k})`);
      continue;
    }
    it.pose = it.pose || {};
    if (it.pose.en !== en) {
      it.pose.en = en;
      changed += 1;
    }
    it.pose.src = 'lineart-v3';
  }
  console.log(`[${label}] 写入 ${changed} 条 / 共 ${data.items.length} 条`);
  if (missing.size) {
    // 表里没有的条目一律报出来，不做「保留旧文字」的静默兜底——
    // 旧文字正是这一版要清掉的猜出来的内容
    console.error(`[${label}] 以下 ${missing.size} 条在表里没有描述：`);
    for (const m of [...missing].slice(0, 20)) console.error('  ' + m);
    process.exitCode = 1;
  }
  if (!dry && changed) writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return changed;
}

const a = apply('web/public/data/pose.json', FEMALE, 'female');
const b = apply('web/public/data/pose-male.json', MALE, 'male');
if (dry) console.log('--dry：未写文件');
else console.log(`合计写入 ${a + b} 条`);
