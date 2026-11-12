/**
 * Atelier 前端：图库浏览 → 三选一 → 合成
 *
 * 关键取舍：三张参考图在上传前由浏览器 Canvas 统一缩放/转码。
 *   - Cloudflare FLUX.2 要求输入图 < 512×512，超限直接报错
 *   - 转 base64 后走 JSON，请求体小、传输快
 *   - 用户自己上传的图也走同一条路径，尺寸可控
 */

import { zh } from './i18n.js';

const SLOTS = ['outfit', 'face', 'pose'];
const SLOT_NAME = { outfit: '服装', face: '脸', pose: '姿势' };
const PAGE = 60;
const MAX_SIDE = 480;      // 输入参考图最长边（< 512 满足 FLUX.2 约束）
const REF_QUALITY = 0.9;   // JPEG 质量：480px 下约 50KB/张，肉眼无损

const state = {
  tab: 'outfit',
  data: { outfit: null, face: null, pose: null },
  selected: { outfit: null, face: null, pose: null },
  q: '', cat: '', page: 1, lbItem: null, lbBig: null,
  config: { ready: false, demo: true, engine: null, engines: [], model: null },
  custom: { configured: false },
  engine: 'cloudflare',
  busy: false,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
};

/* ─────────────────────────── 启动 ─────────────────────────── */

async function boot() {
  await loadConfig();
  await Promise.all(SLOTS.map(loadCatalog));
  renderTabs();
  renderGrid();
  bindUI();
  setDefaultPrompt();
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.config = await r.json();
  } catch {
    state.config = { ready: false, demo: true, engine: null, engines: [], model: null };
  }
  await refreshModelPanel();
  renderEngineBadge();
}

/** 拉取自定义模型状态并刷新下拉、徽标 */
async function refreshModelPanel() {
  try {
    const r = await fetch('/api/model');
    state.custom = r.ok ? await r.json() : { configured: false };
  } catch {
    state.custom = { configured: false };
  }
  paintModelPanel();
}

/** Cloudflare 模型下方的额度提示：数字随所选模型变（klein-9b 7 张、4b 9 张、dev 2–3 张） */
function paintModelQuota() {
  const el = $('#modelQuota');
  if (!el) return;
  const cur = (state.config.models || []).find((m) => m.modelId === $('#model').value);
  const q = cur?.quota || '7 张';
  el.textContent = `每天免费额度约 ${q}（10,000 Neurons，UTC 0 点重置）；产出不够建议点下方按钮，接自己的 API。`;
}

function paintModelPanel() {
  const cfg = state.config;
  const engineSel = $('#engine');
  const customReady = !!state.custom.configured;

  const cfReady = cfg.ready && (cfg.engines || []).includes('cloudflare');

  // 通道下拉：不可用的通道也列出来，但标注状态，避免只有一个选项时选不到
  const opts = [];
  if (cfReady) {
    opts.push({ v: 'cloudflare', t: 'Cloudflare Workers AI' });
  } else {
    opts.push({ v: 'cloudflare', t: 'Cloudflare Workers AI（未绑定）', disabled: true });
  }
  opts.push({
    v: 'custom',
    t: customReady ? `自定义模型 · ${state.custom.model}` : '自定义模型（未配置）',
  });
  engineSel.innerHTML = '';
  for (const o of opts) {
    engineSel.append(el('option', { value: o.v, disabled: o.disabled ? '' : null }, o.t));
  }

  // 默认通道：有自定义且用户没选过 → 跟随后端推荐
  if (!state.engineTouched) {
    state.engine = cfg.engine || (customReady ? 'custom' : 'cloudflare');
  }
  // 选中的通道若不可用，回落到另一个可用通道，保证下拉值不为空
  if (state.engine === 'cloudflare' && !cfReady) {
    state.engine = customReady ? 'custom' : 'cloudflare';
  }
  engineSel.value = state.engine;

  // 自定义入口按钮：任何通道下都可见，文案随配置状态变化
  $('#openModelCfg').textContent = customReady ? '修改自定义模型 →' : '去配置自定义模型 →';

  $('#modelRow').hidden = state.engine !== 'cloudflare';
  $('#customModelRow').hidden = state.engine !== 'custom';

  const ms = $('#model');
  if (cfg.models?.length && ms.options.length !== cfg.models.length) {
    ms.innerHTML = '';
    for (const m of cfg.models) ms.append(el('option', { value: m.modelId, title: m.note }, m.label));
  }
  if (cfg.model) ms.value = cfg.model;
  paintModelQuota();

  const cm = $('#customModel');
  cm.innerHTML = '';
  cm.append(
    el(
      'option',
      { value: 'custom' },
      customReady ? `${state.custom.model}（${state.custom.baseUrl}）` : '尚未配置',
    ),
  );

  // 持久化提示
  $('#cfgPersistNote').textContent = state.custom.canPersist
    ? '密钥仅存于服务端 KV，前端只能看到尾号。'
    : '当前部署没有绑定 KV，无法在页面保存。请改用环境变量 CUSTOM_BASE_URL / CUSTOM_API_KEY / CUSTOM_MODEL 配置，或在 wrangler.jsonc 添加 KV 绑定。';

  const keyHint = $('#cfgKeyHint');
  if (state.custom.apiKeyMasked) keyHint.textContent = `已保存：${state.custom.apiKeyMasked}（留空则保持不变）`;
  else keyHint.textContent = '仅存服务端，不下发浏览器';
  if (state.custom.baseUrl && !$('#cfgBaseUrl').value) $('#cfgBaseUrl').value = state.custom.baseUrl;
  if (state.custom.model && !$('#cfgModel').value) $('#cfgModel').value = state.custom.model;
}

function renderEngineBadge() {
  const badge = $('#engineBadge');
  const cfg = state.config;
  if (state.engine === 'custom') {
    if (state.custom.configured) {
      badge.textContent = `自定义 · ${state.custom.model}`;
      badge.className = 'engine-badge ok';
      badge.title = `${state.custom.baseUrl}｜请求由服务端转发`;
      return;
    }
    badge.textContent = '自定义模型未配置';
    badge.className = 'engine-badge warn';
    badge.title = '点「配置自定义模型」填写 Base URL / Key / 模型名';
    return;
  }
  if (cfg.engines?.includes('cloudflare')) {
    badge.textContent = `Workers AI · ${cfg.modelLabel || 'FLUX.2'}`;
    badge.className = 'engine-badge ok';
    badge.title = `模型：${cfg.model}｜消耗本账号 Workers AI 额度`;
    return;
  }
  badge.textContent = '演示模式 · 未绑定 AI';
  badge.className = 'engine-badge warn';
  badge.title = '部署到 Cloudflare 或配置自定义模型后即可真实生成';
}

/** 生成按钮是否可用：通道就绪 + 三项选齐。
 *  演示模式下也放行，让用户能看到完整流程（后端返回拼版预览图，不产生真实图像）。 */
function canGenerate() {
  const engineReady =
    state.engine === 'custom' ? !!state.custom.configured : state.config.engines?.includes('cloudflare');
  const allowed = engineReady || state.config.demo;
  return allowed && SLOTS.every((k) => state.selected[k]) && !state.busy;
}

async function loadCatalog(kind) {
  try {
    const r = await fetch(`/data/${kind}.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data[kind] = await r.json();
  } catch {
    state.data[kind] = { items: [], count: 0, mode: 'missing', source: {} };
  }
  updateSlotThumb(kind);
}

/* ─────────────────────────── 图库渲染 ─────────────────────────── */

function renderTabs() {
  $$('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      state.tab = b.dataset.slot;
      state.page = 1;
      state.q = '';
      state.cat = '';
      $('#search').value = '';
      renderTabs();
      renderGrid();
    });
  });
}

function renderTabsState() {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.slot === state.tab)));
  $('#libTitle').textContent = `${SLOT_NAME[state.tab]}库`;
  const d = state.data[state.tab];
  const mode = d?.mode === 'live' ? '上游同步' : d?.mode === 'fixture' ? '本地样例' : '样例';
  $('#libMeta').textContent = d ? `${d.count ?? d.items?.length ?? 0} 条 · ${mode}${d.generatedAt ? ' · ' + new Date(d.generatedAt).toLocaleDateString('zh-CN') : ''}` : '';
}

function filtered() {
  const d = state.data[state.tab];
  if (!d?.items) return [];
  const terms = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return d.items.filter((it) => {
    if (state.cat && !(it.cats || []).includes(state.cat)) return false;
    if (!terms.length) return true;
    const hay = [it.id, it.title, ...(it.cats || []), ...(it.tags || [])].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function renderGrid() {
  renderTabsState();
  const grid = $('#grid');
  const items = filtered();
  const sel = state.selected[state.tab];

  // 分类下拉：仅在当前库有分类时刷新
  const cats = [...new Set((state.data[state.tab]?.items || []).flatMap((i) => i.cats || []))].sort();
  const catSel = $('#catFilter');
  const sig = cats.join('|');
  if (catSel.dataset.sig !== sig) {
    catSel.dataset.sig = sig;
    catSel.innerHTML = '';
    catSel.append(el('option', { value: '' }, '全部分类'));
    cats.forEach((c) => catSel.append(el('option', { value: c }, c)));
    if (state.cat && !cats.includes(state.cat)) state.cat = '';
    catSel.value = state.cat;
  }

  grid.innerHTML = '';
  if (!items.length) {
    grid.append(el('div', { class: 'empty-state' }, '没有匹配的素材。试试更短的关键词，或切换分类。'));
  }

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * PAGE;
  const slice = items.slice(start, start + PAGE);
  const frag = document.createDocumentFragment();
  for (const it of slice) {
    const isSel = sel?.id === it.id;
    const img = el('img', { src: it.thumb, alt: it.title || it.id, loading: 'lazy', decoding: 'async' });
    // 上游图床偶发抖动：失败后延迟重试一次，避免留下空洞
    img.addEventListener('error', () => {
      if (img.dataset.retried) {
        img.classList.add('failed');
        return;
      }
      img.dataset.retried = '1';
      setTimeout(() => { img.src = `${it.thumb}${it.thumb.includes('?') ? '&' : '?'}r=1`; }, 800);
    });
    const card = el(
      'div',
      {
        class: 'card',
        role: 'option',
        'aria-selected': String(isSel),
        'data-id': it.id,
        tabindex: '0',
        onclick: () => openLightbox(it),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(it); }
        },
      },
      img,
      el('div', { class: 'cap' }, ...captionOf(it)),
    );
    frag.append(card);
  }
  grid.append(frag);

  $('#count').textContent =
    items.length > PAGE
      ? `第 ${start + 1}–${start + slice.length} 条 / 共 ${items.length} 条`
      : `共 ${items.length} 条`;
  renderPager(totalPages);
}

/** 页码序列：首页、末页、当前页 ±1，中间用省略号，最多 7 个位置 */
function pageItems(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set([1, total, cur, cur - 1, cur + 1]);
  if (cur <= 3) [2, 3, 4].forEach((n) => set.add(n));
  if (cur >= total - 2) [total - 3, total - 2, total - 1].forEach((n) => set.add(n));
  const nums = [...set].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out = [];
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) out.push('gap');
    out.push(n);
  });
  return out;
}

function renderPager(total) {
  const cur = state.page;
  $('#pgFirst').disabled = $('#pgPrev').disabled = cur <= 1;
  $('#pgNext').disabled = $('#pgLast').disabled = cur >= total;

  const box = $('#pgPages');
  box.innerHTML = '';
  if (total <= 1) {
    $('#pager').hidden = false;
    $('#pgPages').append(el('span', { class: 'pg-gap' }, '共 1 页'));
    return;
  }
  for (const p of pageItems(cur, total)) {
    if (p === 'gap') box.append(el('span', { class: 'pg-gap' }, '…'));
    else
      box.append(
        el(
          'button',
          {
            class: 'pg-num',
            'aria-current': p === cur ? 'page' : null,
            onclick: () => gotoPage(p),
          },
          String(p),
        ),
      );
  }
}

function gotoPage(p) {
  const items = filtered();
  const total = Math.max(1, Math.ceil(items.length / PAGE));
  const next = Math.min(Math.max(1, p), total);
  if (next === state.page) return;
  state.page = next;
  renderGrid();
  // 翻页后回到列表顶部，避免停在半空
  const grid = $('#grid');
  grid.scrollIntoView({ block: 'start', behavior: 'auto' });
}

/* ─────────────────────────── 选择与槽位 ─────────────────────────── */

function selectItem(it) {
  const kind = state.tab;
  const cur = state.selected[kind];
  if (cur?.id === it.id) {
    state.selected[kind] = null;
  } else {
    state.selected[kind] = { ...it, kind, origin: 'library' };
    // 预热：选中即开始经代理拉取原图，点生成时多半已进缓存，避免卡在「准备参考图」
    prefetchReference(it);
    // 选完后自动跳到下一个未选板块，减少点击
    const next = SLOTS.find((s) => s !== kind && !state.selected[s]);
    if (next) {
      state.tab = next;
      state.q = '';
      state.cat = '';
      state.page = 1;
      $('#search').value = '';
    }
  }
  renderGrid();
  updateSlots();
}

function updateSlotThumb(kind) {
  const s = state.selected[kind];
  const box = $(`.slot[data-slot="${kind}"] .slot-thumb`);
  const slotEl = $(`.slot[data-slot="${kind}"]`);
  if (!box) return;
  box.innerHTML = '';
  if (s?.thumb) {
    box.append(el('img', { src: s.thumb, alt: SLOT_NAME[kind] }));
    box.removeAttribute('data-empty');
    slotEl.classList.add('filled');
  } else {
    box.setAttribute('data-empty', '未选');
    slotEl.classList.remove('filled');
  }
  const filled = SLOTS.filter((k) => state.selected[k]).length;
  $('#genBtn').disabled = !canGenerate();
  $('#hint').classList.remove('error');
  $('#hint').textContent =
    filled < 3
      ? `还差 ${3 - filled} 项：${SLOTS.filter((k) => !state.selected[k]).map((k) => SLOT_NAME[k]).join('、')}`
      : '三项已就绪，点「生成合成图」。';
}

function updateSlots() {
  SLOTS.forEach(updateSlotThumb);
}

/* ─────────────────────────── 图片处理 ─────────────────────────── */

/** 选中素材时预取原图（失败不提示，生成时会再试一次并给出可读错误） */
function prefetchReference(it) {
  const src = it.full || it.thumb;
  if (!src) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = proxied(src);
}

/** 任意图片来源 → 统一尺寸的 PNG dataURL（兜底 JPEG，避免 PNG 过大）。
 *  上游图片一律走本站 /api/proxy，避免跨域图读进 canvas 时偶发卡死。 */
async function toReference(src) {
  const img = await loadImage(proxied(src));
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.max(64, Math.round(img.width * scale));
  const h = Math.max(64, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // 统一输出 JPEG，而不是 PNG：
  //   1. canvas 的 PNG 是 RGBA（带 alpha 通道），部分推理后端遇到会直接抛 3043；
  //   2. 480px 照片 PNG 约 400–700KB，JPEG 只要 40–70KB，三张一起能让请求体小一个量级，
  //      而请求体过大同样是 3043 的常见诱因。
  return { dataUrl: canvas.toDataURL('image/jpeg', REF_QUALITY), w, h };
}

/** 外链图片改走本站代理；data: / blob: 与同源地址原样返回 */
function proxied(src) {
  if (!src) return src;
  if (src.startsWith('data:') || src.startsWith('blob:')) return src;
  try {
    const u = new URL(src, location.href);
    if (u.origin === location.origin) return src;
    return `/api/proxy?url=${encodeURIComponent(u.href)}`;
  } catch {
    return src;
  }
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    // CORS 被拒或代理冷启动时浏览器可能长时间不回调，超时兜底避免界面永久卡住
    const timer = setTimeout(() => {
      cleanup();
      rej(new Error('参考图加载超时，请检查网络后重试，或改用「↑」上传本地图片'));
    }, 20000);
    const cleanup = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      cleanup();
      res(img);
    };
    img.onerror = () => {
      cleanup();
      rej(new Error('图片加载失败（可能被上游防盗链拦截，请改用本地样例或上传）'));
    };
    img.src = src;
  });
}

/* ─────────────────────────── 生成 ─────────────────────────── */

/* 尺寸统一为 16/64 的倍数（FLUX 系列对非对齐尺寸容易内部报错），且都在 256–1920 内 */
const RATIO_MAP = { '3:4': [960, 1280], '1:1': [1024, 1024], '9:16': [720, 1280], '4:3': [1280, 960] };

async function generate() {
  if (state.busy) return;
  const ratio = $('#ratio').value;
  const [width, height] = RATIO_MAP[ratio] || [1024, 1024];
  setBusy(true, '正在准备参考图…');
  try {
    // 三张并行处理：串行等待时每张都要单独跨域往返，累计很容易触发超时
    const images = await Promise.all(
      SLOTS.map(async (k) => {
        const s = state.selected[k];
        if (!s) throw new Error('素材未选齐');
        // 参考图最长边只需 480px，图库缩略图（300–360px）已够用且体积小、加载快；
        // 直接用原图会拖来 1MB+ 的 PNG，三张并发容易超时。上传的图没有原图之分，用 thumb。
        const first = s.origin === 'upload' ? s.thumb : s.thumb || s.full;
        const fallback = s.full && s.full !== first ? s.full : null;
        try {
          return (await toReference(first)).dataUrl;
        } catch (e) {
          if (!fallback) throw e;
          return (await toReference(fallback)).dataUrl;
        }
      }),
    );

    const engineReady =
      state.engine === 'custom' ? !!state.custom.configured : !!state.config.engines?.includes('cloudflare');
    setBusy(true, engineReady ? '模型生成中，通常 10–30 秒…' : '演示模式：正在拼接预览…');
    const payload = {
      images,
      width,
      height,
      style: $('#style').value,
      extra: $('#extra').value.trim(),
      prompt: $('#promptOverride').value.trim(),
      model: state.engine === 'cloudflare' ? $('#model')?.value || undefined : undefined,
      engine: state.engine,
    };

    const r = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || j.error) {
      // 把 Workers AI 的错误码与 Ray ID 一起显示：3043 这类内部错误只能靠 Ray 让 Cloudflare 定位
      const d = j.detail || {};
      const tag = d.code ? `（错误码 ${d.code}${d.ray ? ` · Ray ${d.ray}` : ''}）` : '';
      throw new Error(`${j.error || `生成失败（HTTP ${r.status}）`}${tag}`);
    }

    showResult(j);
    // 成功后给明确的状态文案，避免停留在「正在生成…」
    const hint = $('#hint');
    hint.classList.remove('error');
    hint.textContent = j.demo
      ? '演示模式完成：这是布局预览图，绑定 Workers AI 后会输出融合后的成品。'
      : `已生成，耗时 ${((j.ms ?? 0) / 1000).toFixed(1)}s。可换素材再生成一次做对比。`;
  } catch (e) {
    $('#hint').textContent = e.message;
    $('#hint').classList.add('error');
  } finally {
    setBusy(false);
  }
}

function setBusy(busy, msg) {
  state.busy = busy;
  $('#genBtn').disabled = !canGenerate();
  $('.spinner').hidden = !busy;
  $('#genBtn .label').textContent = busy ? '处理中' : '生成合成图';
  if (msg) {
    $('#hint').classList.remove('error');
    $('#hint').textContent = msg;
  }
}

function showResult(j) {
  const box = $('#result');
  box.innerHTML = '';
  const src = j.image.startsWith('data:') ? j.image : j.image;
  const img = el('img', { src, alt: '合成结果' });
  box.append(img);

  const meta = $('#resultMeta');
  meta.innerHTML = '';
  if (j.demo) {
    meta.append(el('span', {}, '演示模式（本地预览拼接图），配置模型密钥后即为真实生成结果'));
  }
  if (j.model) meta.append(el('span', {}, `模型：${j.model}`));
  if (j.ms) meta.append(el('span', {}, `耗时 ${(j.ms / 1000).toFixed(1)}s`));
  const dl = el('a', { href: src, download: `atelier-${Date.now()}.png` }, '下载');
  meta.append(dl);
  if (j.requestId) meta.append(el('span', {}, `#${j.requestId}`));
}

/* ─────────────────────────── 其它交互 ─────────────────────────── */

let uploadTarget = null;

function bindUI() {
  $('#search').addEventListener('input', (e) => {
    state.q = e.target.value;
    state.page = 1;
    renderGrid();
  });
  $('#catFilter').addEventListener('change', (e) => {
    state.cat = e.target.value;
    state.page = 1;
    renderGrid();
  });
  $('#pgFirst').addEventListener('click', () => gotoPage(1));
  $('#pgPrev').addEventListener('click', () => gotoPage(state.page - 1));
  $('#pgNext').addEventListener('click', () => gotoPage(state.page + 1));
  $('#pgLast').addEventListener('click', () => {
    const total = Math.max(1, Math.ceil(filtered().length / PAGE));
    gotoPage(total);
  });
  $('#resetBtn').addEventListener('click', () => {
    SLOTS.forEach((k) => (state.selected[k] = null));
    updateSlots();
    $('#result').innerHTML = '<div class="placeholder"><span>结果会显示在这里</span></div>';
    $('#resultMeta').innerHTML = '';
  });
  $('#genBtn').addEventListener('click', generate);

  // 通道切换
  $('#engine').addEventListener('change', (e) => {
    state.engine = e.target.value;
    state.engineTouched = true;
    paintModelPanel();
    renderEngineBadge();
    updateSlots();
    if (state.engine === 'custom' && !state.custom.configured) openModelDrawer();
  });
  $('#openModelCfg').addEventListener('click', openModelDrawer);
  $('#model').addEventListener('change', paintModelQuota);
  $('#cfgClose').addEventListener('click', () => ($('#modelDrawer').hidden = true));
  $('#modelDrawer').addEventListener('click', (e) => {
    if (e.target.id === 'modelDrawer') $('#modelDrawer').hidden = true;
  });

  $$('.slot-upload').forEach((b) => {
    b.addEventListener('click', () => {
      uploadTarget = b.dataset.upload;
      $('#fileInput').value = '';
      $('#fileInput').click();
    });
  });
  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || !uploadTarget) return;
    const url = URL.createObjectURL(file);
    try {
      const { dataUrl } = await toReference(url);
      state.selected[uploadTarget] = {
        id: `upload-${Date.now()}`,
        title: file.name,
        thumb: dataUrl,
        full: dataUrl,
        origin: 'upload',
      };
      updateSlots();
    } catch (err) {
      $('#hint').textContent = err.message;
      $('#hint').classList.add('error');
    } finally {
      URL.revokeObjectURL(url);
      uploadTarget = null;
    }
  });

  // 大图：先预览，确认后才选中
  $('#lbConfirm').addEventListener('click', () => {
    const it = state.lbItem;
    if (!it) return;
    selectItem(it);
    closeLightbox();
  });
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#lightbox').hidden) closeLightbox();
    // 预览状态下回车 = 确认选择，方向键可快速切换
    if (e.key === 'Enter' && !$('#lightbox').hidden && state.lbItem) {
      e.preventDefault();
      selectItem(state.lbItem);
      closeLightbox();
    }
  });
}

/** 卡片标题：姿势显示「编号 · 视角」；其余显示名称。名称过长由 CSS 截断。 */
function captionOf(it) {
  if (it.code) {
    const name = zh(it.title || '', 'title');
    const parts = [el('b', {}, it.code)];
    if (it.angle) parts.push(el('i', { class: 'cap-angle' }, it.angle));
    parts.push(document.createTextNode(name));
    return parts;
  }
  return [document.createTextNode(zh(it.title || it.id, 'title'))];
}

function openLightbox(it) {
  state.lbItem = it;
  const img = $('#lbImg');

  // 大图只用于「看」，不参与 canvas 取像素，所以直接用外链：
  // 这样与网格缩略图同 URL，浏览器缓存能立刻命中，不必经代理重新下载一遍。
  const thumb = it.thumb;
  const full = it.full || it.thumb;

  // 关键：先清空 src。否则浏览器会一直显示上一张，直到新图解码完成才切换，
  // 体感就是「点了没反应，两秒后才跳过去」。
  img.classList.add('loading');
  img.onload = null;
  img.onerror = null;
  img.removeAttribute('src');

  // 丢弃上一张仍在下载的原图，避免它晚到覆盖当前这张
  if (state.lbBig) {
    state.lbBig.onload = null;
    state.lbBig.onerror = null;
    state.lbBig.src = '';
    state.lbBig = null;
  }

  // 缩略图与网格同源同 URL，通常已在缓存里，基本瞬时可见
  const showThumb = () => {
    img.src = thumb;
    img.onload = () => img.classList.remove('loading');
    img.onerror = () => img.classList.remove('loading');
  };
  showThumb();

  if (full !== thumb) {
    const big = new Image();
    state.lbBig = big;
    big.onload = () => {
      if (state.lbItem !== it) return; // 已切到别的素材，别再改
      img.src = full;
    };
    big.onerror = () => {
      /* 原图失败就保持缩略图，不打断浏览 */
    };
    big.src = full;
  }

  $('#lbCaption').textContent = it.code
    ? `${it.code} · ${zh(it.title || '', 'title')}`
    : zh(it.title || it.id, 'title');
  $('#lbOpen').href = it.full || it.thumb;
  const btn = $('#lbConfirm');
  const isSel = state.selected[state.tab]?.id === it.id;
  btn.textContent = isSel ? '取消选择' : '确认选择';
  btn.classList.toggle('is-selected', isSel);
  $('#lightbox').hidden = false;
  btn.focus();
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  state.lbItem = null;
  // 停掉还在下载的原图，别让它占着连接
  if (state.lbBig) {
    state.lbBig.onload = null;
    state.lbBig.onerror = null;
    state.lbBig.src = '';
    state.lbBig = null;
  }
}

function setDefaultPrompt() {
  $('#promptOverride').placeholder = '留空使用内置模板：图1=服装，图2=脸，图3=姿势。';
}

boot().catch((e) => {
  console.error(e);
  $('#hint').textContent = `初始化失败：${e.message}`;
  $('#hint').classList.add('error');
});

/* ─────────────── 自定义模型配置抽屉 ─────────────── */

function openModelDrawer() {
  $('#cfgMsg').textContent = '';
  $('#cfgMsg').className = 'cfg-msg';
  $('#cfgSample').hidden = true;
  $('#modelDrawer').hidden = false;
  paintModelPanel();
  $('#cfgBaseUrl').focus();
}

function cfgMsg(text, ok) {
  const m = $('#cfgMsg');
  m.textContent = text;
  m.className = `cfg-msg ${ok ? 'ok' : 'err'}`;
}

const readCfg = () => ({
  baseUrl: $('#cfgBaseUrl').value.trim(),
  apiKey: $('#cfgApiKey').value.trim(),
  model: $('#cfgModel').value.trim(),
  sendMode: $('#cfgSendMode').value,
  extraJson: $('#cfgExtra').value.trim(),
});

async function saveCfg() {
  cfgMsg('保存中…', true);
  try {
    const r = await fetch('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(readCfg()),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `保存失败（HTTP ${r.status}）`);
    cfgMsg(`已保存：${j.model} @ ${j.baseUrl}`, true);
    $('#cfgApiKey').value = '';
    await refreshModelPanel();
    state.engine = 'custom';
    state.engineTouched = true;
    paintModelPanel();
    renderEngineBadge();
    updateSlots();
  } catch (e) {
    cfgMsg(e.message, false);
  }
}

async function testCfg() {
  const c = readCfg();
  cfgMsg('正在请求一次极小的文生图…（最长 2 分钟）', true);
  $('#cfgSample').hidden = true;
  try {
    const r = await fetch('/api/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '测试失败');
    cfgMsg(`连通成功，耗时 ${(j.ms / 1000).toFixed(1)}s。下方为返回样例（用于确认是真实出图接口）。`, true);
    $('#cfgSample').src = j.sample;
    $('#cfgSample').hidden = false;
  } catch (e) {
    cfgMsg(`测试失败：${e.message}`, false);
  }
}

async function clearCfg() {
  if (!confirm('确定清除已保存的自定义模型配置？')) return;
  try {
    const r = await fetch('/api/model', { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || '清除失败');
    $('#cfgApiKey').value = '';
    cfgMsg('已清除。', true);
    await refreshModelPanel();
    renderEngineBadge();
  } catch (e) {
    cfgMsg(e.message, false);
  }
}

$('#cfgSave')?.addEventListener('click', saveCfg);
$('#cfgTest')?.addEventListener('click', testCfg);
$('#cfgClear')?.addEventListener('click', clearCfg);
