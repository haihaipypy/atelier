/**
 * AI角色合成工坊 前端：图库浏览（女性/男性） → 三选一 → 合成
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
  gender: 'female',          // female | male：决定素材库与整套配色
  data: { outfit: null, face: null, pose: null },
  selected: { outfit: null, face: null, pose: null },
  q: '', cat: '', page: 1, lbItem: null, lbBig: null,
  config: { ready: false, demo: true, engine: null, engines: [], model: null },
  custom: { configured: false },
  engine: 'cloudflare',
  relay: 'browser',   // 自定义模型由谁发请求：browser 直连 / server 中转
  busy: false,
};

/* ─── 自定义模型的本机配置 ───
 * 直连模式下请求由浏览器发出，密钥必须留在浏览器手里，因此只写 localStorage，
 * 不上传服务器（服务端 KV 那套只服务「中转模式」）。
 */
const LS_RELAY = 'atelier.relay';
const LS_CUSTOM = 'atelier.custom.v1';

function readLocalCfg() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_CUSTOM) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function localCustomReady() {
  const v = readLocalCfg();
  return !!(v?.baseUrl && v?.apiKey && v?.model);
}

/** 自定义通道是否可用：直连看本机配置，中转看服务端状态 */
function customChannelReady() {
  return state.relay === 'server' ? !!state.custom.configured : localCustomReady();
}

const maskLocal = (k) => (!k ? '' : k.length <= 8 ? '••••' : `${k.slice(0, 3)}••••${k.slice(-4)}`);

/** 与 shared/custom-model.js 的 normalizeBaseUrl 保持一致：补协议、去尾斜杠、缺 /v1 时补上 */
function normBase(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  if (/\/images\/generations$/.test(u)) return u.replace(/\/images\/generations$/, '');
  if (!/\/v\d+$/i.test(u)) u += '/v1';
  return u;
}

const endpointOf = (baseUrl) => `${normBase(baseUrl)}/images/generations`;

/** 上游 4xx/5xx 的提示文案（与后端保持一致，前端直连时自己拼） */
function upstreamMsg(status, json, raw, endpoint) {
  const upstream = String(json?.error?.message || json?.message || raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const code = String(json?.error?.code || json?.error?.type || '').trim();
  const hint =
    status === 401
      ? 'API Key 无效或已过期'
      : status === 402
        ? '账户余额不足'
        : status === 403
          ? '密钥无权访问该模型，或服务商拦截了来源地区/IP'
          : status === 404
            ? `接口路径不存在，当前请求 ${endpoint}`
            : status === 429
              ? '触发限流或额度用尽'
              : status === 400 || status === 422
                ? '上游不接受这组参数（size / model / response_format 可能不支持）'
                : '';
  const detail = upstream ? `（上游：${upstream}${code ? ` · ${code}` : ''}）` : '';
  return `自定义模型返回 ${status}${hint ? `：${hint}` : ''}${detail}`;
}

/**
 * 送出给模型的姿态要点。
 *
 * 男性版用的是女性素体线稿（Shisei 没出男版姿势），线稿上的胸部曲线、腰胯比例
 * 会和「成年男性」打架。两者冲突时模型最常见的处理是**直接丢掉姿势**、输出一张
 * 正面站姿——也就是「选了姿势却不生效」。所以这里不删要点，而是明确说：
 * 骨架照搬、轮廓别照搬。
 */
function poseHintFor(gender) {
  const raw = state.selected.pose?.pose?.zh || '';
  if (!raw) return '';
  if (gender !== 'male') return raw;
  return `${raw} (the reference is a female artist mannequin: copy only its skeleton and camera, `
    + 'not its bust or waist-hip contour)';
}

/**
 * 直连模式下提示词要自己拼：/api/prompt 只是读模板，走本站域名不会被任何服务商拦截。
 * 失败时用一段等价的内置描述兜底，保证「不填提示词也能出图」。
 */
async function buildPromptOnServer() {
  const poseHint = poseHintFor(state.gender);
  const q = new URLSearchParams({
    style: $('#style').value || 'photorealistic',
    extra: $('#extra').value.trim(),
    gender: state.gender,
    poseHint,
  });
  try {
    const r = await fetch(`/api/prompt?${q}`);
    if (r.ok) {
      const j = await r.json();
      if (j?.prompt) return j.prompt;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  const who = state.gender === 'male' ? '成年男性' : '成年女性';
  const poseLine = poseHint ? `（${poseHint}）` : '';
  return `图1是服装（忽略人台与背景），图2是${who}的脸与发型，图3是姿势${poseLine}。`
    + `把三者合成到同一个${who}身上：服装材质与垂感照图1，五官与发色照图2，姿态与镜头角度照图3。`
    + (state.gender === 'male'
      ? '注意图3是女性素体线稿：只取它的骨架与机位，不要把它胸部与腰胯轮廓搬到男性身上，也不要替换成站姿。'
      : '')
    + '输出一张真实感强的全身人物照，光影自然。';
}

/**
 * 浏览器直连：请求从用户的网络发出，不经过 Worker。
 * 之所以需要它：不少模型服务商会整段屏蔽云厂商出口 IP（Cloudflare 首当其冲），
 * 服务端中转会直接被 403。代价是要求对方允许跨域（CORS），否则浏览器会拦下。
 */
async function generateDirect({ images, prompt, size }) {
  const cfg = readLocalCfg();
  if (!cfg?.baseUrl || !cfg?.apiKey || !cfg?.model) throw new Error('直连模式还没有在本机保存配置');
  const endpoint = endpointOf(cfg.baseUrl);

  let extra = {};
  if (cfg.extraJson) {
    try {
      extra = JSON.parse(cfg.extraJson);
    } catch {
      throw new Error('额外参数不是合法 JSON');
    }
  }
  const body = { model: cfg.model, prompt, n: 1, size, ...extra };
  if (images?.length) body.extra_body = { ...(body.extra_body || {}), image: images };
  body.extra_body = { ...(body.extra_body || {}), response_format: 'b64_json' };

  const started = Date.now();
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // fetch 对 CORS 失败只会抛 TypeError，没有任何细节可读
    throw new Error(
      `浏览器直连失败：${e.message}。最常见原因是该服务未开放跨域（CORS），` +
        `可切到「服务端中转」再试；若服务端被 403，则需服务商放行云厂商出口 IP。`,
    );
  }

  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* 非 JSON 交给下面报错 */
  }
  if (!res.ok) throw new Error(upstreamMsg(res.status, json, raw, endpoint));

  const item = json?.data?.[0] || json?.images?.[0] || json?.output?.[0] || null;
  const b64 = item?.b64_json || item?.base64 || (typeof item === 'string' ? null : null);
  const url = item?.url || (typeof item === 'string' ? item : null);
  let image = '';
  if (b64) image = `data:image/png;base64,${String(b64).replace(/^data:[^;]+;base64,/, '')}`;
  else if (url) image = url;
  if (!image) throw new Error(`自定义模型返回里没找到图片字段（字段：${Object.keys(json || {}).join(', ')}）`);

  return { image, model: cfg.model, ms: Date.now() - started, prompt, engine: 'custom' };
}

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
  const savedGender = localStorage.getItem('atelier.gender');
  state.gender = savedGender === 'male' ? 'male' : 'female';
  applyGenderTheme();
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
  // 没存过偏好时按现状推断：本机有 Key 走直连，否则若服务端有配置则走中转
  const saved = localStorage.getItem(LS_RELAY);
  state.relay =
    saved === 'server' || saved === 'browser'
      ? saved
      : localCustomReady()
        ? 'browser'
        : state.custom.configured
          ? 'server'
          : 'browser';
  paintModelPanel();
}

/** Cloudflare 模型下方的额度提示：张数按官方价目实算（9b 约 6 张、4b 约 10 张、dev 2–3 张） */
function paintModelQuota() {
  const el = $('#modelQuota');
  if (!el) return;
  const cur = (state.config.models || []).find((m) => m.modelId === $('#model').value);
  const q = cur?.quota || '6 张';
  el.textContent = `每天免费额度约 ${q}（10,000 Neurons/日，账号级共享）；用完要到次日才恢复，产出不够建议点下方按钮，接自己的 API。`;
}

function paintModelPanel() {
  const cfg = state.config;
  const engineSel = $('#engine');
  const customReady = customChannelReady();
  const local = readLocalCfg();

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
    t: customReady
      ? `自定义模型 · ${state.relay === 'browser' ? local?.model : state.custom.model}`
      : '自定义模型（未配置）',
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
  // 原生 select 的 option title 提示不稳定，地址同时挂在 select 上
  const customBase = customReady ? (state.relay === 'browser' ? local?.baseUrl : state.custom.baseUrl) : '';
  cm.title = customBase || '';
  cm.innerHTML = '';
  // 只放模型名：把 Base URL 拼进选项会把窄屏下拉撑破，地址改挂 title 悬停可见
  cm.append(
    el(
      'option',
      {
        value: 'custom',
        title: customBase || '',
      },
      customReady ? (state.relay === 'browser' ? local?.model : state.custom.model) : '尚未配置',
    ),
  );

  /* ── 抽屉里与「请求发起位置」相关的文案 ── */
  const relaySel = $('#cfgRelay');
  if (relaySel) relaySel.value = state.relay;

  const isBrowser = state.relay === 'browser';
  const desc = $('#cfgDesc');
  if (desc) {
    desc.innerHTML = isBrowser
      ? '填写任何 <b>OpenAI 兼容</b> 的图像接口即可。请求由<b>这台浏览器</b>直接发出，不经过本站服务器，不会被云厂商出口 IP 封禁牵连；前提是对方允许跨域（CORS）。'
      : '填写任何 <b>OpenAI 兼容</b> 的图像接口即可。请求由<b>本站 Worker</b> 转发，密钥存服务端 KV、前端只见尾号；若服务商封了 Cloudflare 出口 IP，会返回 403。';
  }

  const relayHint = $('#cfgRelayHint');
  if (relayHint) {
    relayHint.textContent = isBrowser
      ? '密钥只存这台浏览器（localStorage），不上传服务器；换设备或清缓存要重填。服务端被 403 时改用这个。'
      : '密钥存服务端 KV，前端看不到；不需要对方支持跨域，但要求对方不封 Cloudflare。';
  }

  // 持久化提示
  const note = $('#cfgPersistNote');
  if (note) {
    if (isBrowser) {
      note.textContent = '直连模式：点「保存」只写入本机浏览器，不产生服务端请求，也不依赖 KV 绑定。';
    } else {
      note.textContent = state.custom.canPersist
        ? '中转模式：密钥仅存于服务端 KV，前端只能看到尾号。'
        : '中转模式需要 KV 才能保存。当前部署没有绑定 KV，请改用环境变量，或把「请求发起位置」切到浏览器直连（不需要 KV）。';
    }
  }

  const keyHint = $('#cfgKeyHint');
  if (keyHint) {
    if (isBrowser) {
      const mine = local?.apiKey;
      keyHint.textContent = mine
        ? `已存本机：${maskLocal(mine)}（留空则保持不变）`
        : '只存本机浏览器，不上传服务器';
    } else if (state.custom.apiKeyMasked) {
      keyHint.textContent = `已保存：${state.custom.apiKeyMasked}（留空则保持不变）`;
    } else {
      keyHint.textContent = '仅存服务端，不下发浏览器';
    }
  }

  // 表单回填：直连填本机那份，中转填服务端那份
  const src = isBrowser ? local : state.custom;
  if (src?.baseUrl && !$('#cfgBaseUrl').value) $('#cfgBaseUrl').value = src.baseUrl;
  if (src?.model && !$('#cfgModel').value) $('#cfgModel').value = src.model;
  if (isBrowser && local?.extraJson && !$('#cfgExtra').value) $('#cfgExtra').value = local.extraJson;
}

function renderEngineBadge() {
  const badge = $('#engineBadge');
  const cfg = state.config;
  if (state.engine === 'custom') {
    if (customChannelReady()) {
      const mine = readLocalCfg();
      const direct = state.relay === 'browser';
      const model = direct ? mine?.model : state.custom.model;
      const base = direct ? mine?.baseUrl : state.custom.baseUrl;
      badge.textContent = `自定义 · ${model}${direct ? '（直连）' : ''}`;
      badge.className = 'engine-badge ok';
      badge.title = `${base}｜${direct ? '请求由浏览器直接发出，不经过本站服务器' : '请求由服务端转发'}`;
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
    state.engine === 'custom' ? customChannelReady() : state.config.engines?.includes('cloudflare');
  const allowed = engineReady || state.config.demo;
  return allowed && SLOTS.every((k) => state.selected[k]) && !state.busy;
}

async function loadCatalog(kind) {
  // 女性版沿用原文件名，男性版加 -male 后缀，两套互不影响
  const file = state.gender === 'male' ? `${kind}-male` : kind;
  try {
    const r = await fetch(`/data/${file}.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data[kind] = await r.json();
  } catch {
    state.data[kind] = { items: [], count: 0, mode: 'missing', source: {} };
  }
  updateSlotThumb(kind);
}

/* ─────────────────────────── 性别切换 ─────────────────────────── */

/** 只改 html[data-gender]，配色全部由 CSS 变量接管 */
function applyGenderTheme() {
  document.documentElement.dataset.gender = state.gender;
  $$('.gender-switch button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.gender === state.gender));
  });
}

async function setGender(gender) {
  const next = gender === 'male' ? 'male' : 'female';
  if (next === state.gender) return;
  state.gender = next;
  localStorage.setItem('atelier.gender', next);
  applyGenderTheme();

  // 素材库整套换掉，已选的三张（哪怕是同编号）语义也可能不同，直接清空更稳妥
  SLOTS.forEach((k) => {
    state.selected[k] = null;
  });
  state.data = { outfit: null, face: null, pose: null };
  state.page = 1;
  state.q = '';
  state.cat = '';
  $('#search').value = '';
  $('#catFilter').dataset.sig = '';

  renderGrid();
  await Promise.all(SLOTS.map(loadCatalog));
  renderGrid();          // 数据到位后重画：上面那次只是先把旧列表清掉
  updateSlots();
  setDefaultPrompt();
  $('#hint').classList.remove('error');
  $('#hint').textContent =
    next === 'male'
      ? '已切到男性版：服装、姿势取自 Shisei（CC0），脸型为本站自建素材。'
      : '已切到女性版：服装、脸型、姿势取自上游图库，另补充 Shisei 的中性与女装。';
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
  const mode =
    d?.origin === 'local'
      ? '本站自建'
      : d?.origin === 'bundled'
        ? 'Shisei · CC0'
        : d?.mode === 'live'
          ? '上游同步'
          : d?.mode === 'fixture'
            ? '本地样例'
            : '样例';
  $('#libMeta').textContent = d ? `${d.count ?? d.items?.length ?? 0} 条 · ${mode}${d.generatedAt ? ' · ' + new Date(d.generatedAt).toLocaleDateString('zh-CN') : ''}` : '';

  // 男性版的姿势库借的是女性素体线稿：这件事不说清楚，用户会以为选错了库，
  // 或者以为「姿势没生效」是 bug（实际是女性轮廓和男性提示词互相打架，模型丢了姿势）
  const note = state.tab === 'pose' && state.gender === 'male'
    ? '此库是女性素体线稿，男性版只借用它的骨架与机位，成品性别由 ② 脸 与提示词决定。'
      + '若成图退回了站姿，把动作写进「额外要求」再生成一次；也可以直接换张服装图重试。'
    : '';
  const el2 = $('#libNote');
  if (el2) {
    el2.textContent = note;
    el2.hidden = !note;
  }
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
        // 姿势条目的 title 只有「后仰坐・单膝竖起」这种短名，悬停时把姿态要点补上，
        // 让用户在选之前就知道这个姿势到底怎么摆
        title: it.pose?.zh ? `${it.title || it.id}\n${it.pose.zh}` : undefined,
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
      state.engine === 'custom' ? customChannelReady() : !!state.config.engines?.includes('cloudflare');
    const direct = state.engine === 'custom' && state.relay === 'browser';
    setBusy(
      true,
      direct
        ? '正在从这台浏览器直接调用模型，通常 10–60 秒…'
        : engineReady
          ? '模型生成中，通常 10–30 秒…'
          : '演示模式：正在拼接预览…',
    );

    let j;
    if (direct) {
      j = await generateDirect({
        images,
        prompt: $('#promptOverride').value.trim() || (await buildPromptOnServer()),
        size: `${width}x${height}`,
      });
    } else {
      const payload = {
        images,
        width,
        height,
        style: $('#style').value,
        extra: $('#extra').value.trim(),
        prompt: $('#promptOverride').value.trim(),
        // 姿势参考图是女性素体线稿，光给图模型经常直接退回站姿；把「大约什么动作」也写成文字
        poseHint: poseHintFor(state.gender),
        model: state.engine === 'cloudflare' ? $('#model')?.value || undefined : undefined,
        engine: state.engine,
      };

      const r = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      j = await r.json();
      if (!r.ok || j.error) {
        // 把错误码与 Ray ID 一起显示：3043 这类内部错误只能靠 Ray 让 Cloudflare 定位
        // 自定义模型的错误已在上游 message 里自带原文，不重复拼
        const d = j.detail || {};
        const bits = [];
        if (d.code) bits.push(`错误码 ${d.code}`);
        // Ray ID 是提工单的唯一凭据，哪怕没有错误码也要露出来
        if (d.ray) bits.push(`Ray ${d.ray}`);
        const tag = !d.upstreamStatus && bits.length ? `（${bits.join(' · ')}）` : '';
        throw new Error(`${j.error || `生成失败（HTTP ${r.status}）`}${tag}`);
      }
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
    if (state.engine === 'custom' && !customChannelReady()) openModelDrawer();
  });
  $$('.gender-switch button').forEach((b) => {
    b.addEventListener('click', () => setGender(b.dataset.gender));
  });
  $('#openModelCfg').addEventListener('click', openModelDrawer);
  $('#model').addEventListener('change', paintModelQuota);
  $('#cfgClose').addEventListener('click', closeModelDrawer);
  $('#modelDrawer').addEventListener('click', (e) => {
    if (e.target.id === 'modelDrawer') closeModelDrawer();
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
  hideSample();
  $('#modelDrawer').hidden = false;
  paintModelPanel();
  $('#cfgBaseUrl').focus();
}

function closeModelDrawer() {
  $('#modelDrawer').hidden = true;
  hideSample();
}

function hideSample() {
  const wrap = $('#cfgSampleWrap');
  if (wrap) wrap.hidden = true;
  const img = $('#cfgSample');
  if (img) img.removeAttribute('src');
}

function showSample(src) {
  const img = $('#cfgSample');
  const wrap = $('#cfgSampleWrap');
  if (!img || !wrap) return;
  img.src = src;
  wrap.hidden = false;
  // 样例在滚动区末尾，不滚过去会被固定底栏压住一半
  requestAnimationFrame(() => wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
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

/* 切换「请求发起位置」：两种模式的密钥存在不同地方，切换后表单要重新回填 */
$('#cfgRelay')?.addEventListener('change', (e) => {
  state.relay = e.target.value === 'server' ? 'server' : 'browser';
  localStorage.setItem(LS_RELAY, state.relay);
  $('#cfgBaseUrl').value = '';
  $('#cfgModel').value = '';
  $('#cfgExtra').value = '';
  $('#cfgApiKey').value = '';
  cfgMsg('', true);
  paintModelPanel();
  renderEngineBadge();
  updateSlots();
});

async function saveCfg() {
  const cfg = readCfg();
  // 直连模式：只写本机浏览器，不产生任何服务端请求（也不要求绑定 KV）
  if (state.relay === 'browser') {
    const prev = readLocalCfg() || {};
    const baseUrl = normBase(cfg.baseUrl);
    const body = {
      baseUrl,
      apiKey: cfg.apiKey || prev.apiKey || '',
      model: cfg.model,
      extraJson: cfg.extraJson,
    };
    if (!baseUrl) return cfgMsg('请填写 Base URL', false);
    if (!/^https?:\/\//i.test(baseUrl)) return cfgMsg('Base URL 必须是 http/https 地址', false);
    if (!body.model) return cfgMsg('请填写模型名称', false);
    if (!body.apiKey) return cfgMsg('请填写 API Key', false);
    if (cfg.extraJson) {
      try {
        JSON.parse(cfg.extraJson);
      } catch {
        return cfgMsg('额外参数不是合法 JSON', false);
      }
    }
    localStorage.setItem(LS_CUSTOM, JSON.stringify(body));
    localStorage.setItem(LS_RELAY, 'browser');
    $('#cfgApiKey').value = '';
    state.engine = 'custom';
    state.engineTouched = true;
    paintModelPanel();
    renderEngineBadge();
    updateSlots();
    afterSaved(body.model, body.baseUrl);
    return;
  }

  cfgMsg('保存中…', true);
  try {
    const r = await fetch('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `保存失败（HTTP ${r.status}）`);
    $('#cfgApiKey').value = '';
    await refreshModelPanel();
    state.engine = 'custom';
    state.engineTouched = true;
    paintModelPanel();
    renderEngineBadge();
    updateSlots();
    afterSaved(j.model, j.baseUrl);
  } catch (e) {
    cfgMsg(e.message, false);
  }
}

/**
 * 保存成功的收尾：直接关掉抽屉（保存是终点，不必让用户再点一次关闭），
 * 反馈改由主界面的提示条承接，否则关窗后没有任何「已保存」的痕迹。
 */
function afterSaved(model, baseUrl) {
  const where = state.relay === 'browser' ? '浏览器直连' : '服务端中转';
  $('#hint').classList.remove('error');
  $('#hint').textContent = `已保存自定义模型：${model}（${where}）｜${baseUrl}`;
  closeModelDrawer();
}

async function testCfg() {
  const c = readCfg();
  const endpoint = endpointOf(c.baseUrl) || '(Base URL 未填)';
  cfgMsg(
    state.relay === 'browser'
      ? '正在从这台浏览器直连模型…（最长 2 分钟）'
      : '正在请求一次极小的文生图…（最长 2 分钟）',
    true,
  );
  hideSample();

  // 直连：不落库也能测，用当前表单值直接打一次文生图（不带参考图）
  if (state.relay === 'browser') {
    const prev = readLocalCfg() || {};
    const baseUrl = normBase(c.baseUrl);
    const apiKey = c.apiKey || prev.apiKey || '';
    if (!baseUrl || !apiKey || !c.model) {
      return cfgMsg('测试失败：请先填写 Base URL、API Key 与模型名', false);
    }
    let extra = {};
    if (c.extraJson) {
      try {
        extra = JSON.parse(c.extraJson);
      } catch {
        return cfgMsg('测试失败：额外参数不是合法 JSON', false);
      }
    }
    const started = Date.now();
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: c.model,
          prompt: 'a small red dot on a white background, minimal',
          n: 1,
          size: '1024x1024',
          ...extra,
          extra_body: { response_format: 'b64_json' },
        }),
      });
    } catch (e) {
      return cfgMsg(
        `测试失败：浏览器直连被拦（${e.message}）。两种可能：①对方未开放跨域 CORS，` +
          `②网络/代理阻断。可切到「服务端中转」验证是否为 CORS 问题｜请求地址：${endpoint}`,
        false,
      );
    }
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* 非 JSON */
    }
    if (!res.ok) {
      return cfgMsg(`测试失败：${upstreamMsg(res.status, json, raw, endpoint)}｜请求地址：${endpoint}`, false);
    }
    const item = json?.data?.[0] || json?.images?.[0] || json?.output?.[0] || null;
    const b64 = item?.b64_json || item?.base64 || null;
    const url = item?.url || (typeof item === 'string' ? item : null);
    const sample = b64 ? `data:image/png;base64,${String(b64).replace(/^data:[^;]+;base64,/, '')}` : url;
    if (!sample) {
      return cfgMsg(
        `测试失败：返回里没找到图片字段（字段：${Object.keys(json || {}).join(', ') || '空'}）｜请求地址：${endpoint}`,
        false,
      );
    }
    cfgMsg(`直连成功，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s。下方为返回样例。`, true);
    showSample(sample);
    return;
  }

  try {
    const r = await fetch('/api/model/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c),
    });
    const j = await r.json();
    if (!j.ok) {
      // 把请求地址一起显示：403/404 多半是 Base URL 拼错，没有地址没法排查
      const d = j.detail || {};
      const where = d.endpoint ? `｜请求地址：${d.endpoint}` : '';
      throw new Error(`${j.error || '测试失败'}${where}`);
    }
    cfgMsg(`连通成功，耗时 ${(j.ms / 1000).toFixed(1)}s。下方为返回样例（用于确认是真实出图接口）。`, true);
    showSample(j.sample);
  } catch (e) {
    cfgMsg(`测试失败：${e.message}`, false);
  }
}

async function clearCfg() {
  if (state.relay === 'browser') {
    if (!confirm('确定清除本机保存的自定义模型配置？')) return;
    localStorage.removeItem(LS_CUSTOM);
    $('#cfgApiKey').value = '';
    $('#cfgBaseUrl').value = '';
    $('#cfgModel').value = '';
    $('#cfgExtra').value = '';
    cfgMsg('已清除本机配置。', true);
    paintModelPanel();
    renderEngineBadge();
    updateSlots();
    return;
  }
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
