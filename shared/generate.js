/**
 * 角色服装合成：prompt 构造 + Cloudflare Workers AI 适配
 *
 * 设计原则
 * 1. 固定用「一句英文 prompt + 三张参考图的固定顺序」调用，
 *    顺序为：0=服装 1=脸 2=姿势。模型对 image index 的引用依赖顺序。
 * 2. 适配器只负责「三张图 + prompt → Workers AI 的 multipart 请求体」，
 *    不掺业务逻辑，换模型只改 MODEL 常量。
 * 3. 是否可用由 AI binding 是否存在决定，前端 /api/config 据此降级为演示模式。
 */

export const SLOTS = ['outfit', 'face', 'pose'];

/**
 * 默认模型。可换的候选（都在 Workers AI 目录内，均支持多参考图）。
 * 张数按官方价目表实算：klein-9b 首张 1024² 为 1,363.64 Neurons，
 * 每张输入图另按 181.82 Neurons/MP 计——三张 480px 参考图只占约 0.7MP，
 * 即每出图约 1,490 Neurons，10,000 额度≈6 张，别写成 7 张。klein-4b 按
 * 5.37/26.05 Neurons 每个 512² 分块计，一进一出约 850 Neurons，≈11 张。
 */
export const MODELS = {
  'flux-2-klein-9b': {
    label: 'FLUX.2 klein 9B',
    modelId: '@cf/black-forest-labs/flux-2-klein-9b',
    note: '默认。质量与成本平衡，输入图需 <512',
    quota: '6 张',
  },
  'flux-2-klein-4b': {
    label: 'FLUX.2 klein 4B',
    modelId: '@cf/black-forest-labs/flux-2-klein-4b',
    note: '最省额度，适合调试',
    quota: '10 张左右',
  },
  'flux-2-dev': {
    label: 'FLUX.2 dev',
    modelId: '@cf/black-forest-labs/flux-2-dev',
    note: '保真最好，输入图无 512 限制，费用最高',
    quota: '2–3 张',
  },
};
export const DEFAULT_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';

/**
 * 姿态要点清洗：前端从图库条目里带一段「坐姿｜后仰坐・单膝竖起；sitting on the floor…」这类要点。
 *
 * 截断到 200 字符是为了不喧宾夺主——多图合成里文字太长会盖掉「图1只给衣服」的约束。
 *
 * 「英文收尾」必须整句丢弃：图库的要点只存前 60 个字符，中英混排时英文大概率被
 * 截在半句（…leaning back with the figur），半句话塞进提示词会和「照图3」打架，
 * 模型只好丢掉姿势、回到正面站姿——这正是「姿势不生效」最隐蔽的一个来源。
 */
export function clipPoseHint(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  // 中英交界处如果还留着没结束的英文尾，直接砍掉：宁可少一句描述，也不给模型半句指令。
  // 只对含中文的要点生效——纯英文要点（男性库改用 pose.en）若走这条规则，
  // 末尾的最后一个单词会被当成「截断残句」一并砍掉。
  const cut = /[\u4e00-\u9fa5]/.test(t) ? t.replace(/\s*[A-Za-z][A-Za-z',\-\s]*$/, '').trim() : t;
  const head = cut || t;
  if (head.length <= 200) return head;
  // 超长按词边界截，别把单词劈两半
  const slice = head.slice(0, 200);
  const at = slice.lastIndexOf(' ');
  return `${(at > 150 ? slice.slice(0, at) : slice).trim()}…`;
}

/**
 * 构造合成指令。要点：
 * - 明确每张参考图的职责（角色分工是 prompt 结构里最关键的一环）
 * - 明确「必须保留什么」「必须替换什么」，避免模型照抄服装图的空白人体
 * - 姿势线稿要显式说明「只取骨架与角度，不要线稿风格」
 *
 * @param {object} p
 * @param {string} [p.poseHint] 用户所选姿势的姿态要点（来自图库条目），
 *        用来把「大约什么姿势」写成文字。参考图给的是画面，文字补的是语义：
 *        两者一起给，模型在这类多图合成里才更容易听懂。
 * @param {boolean} [p.halfBody] 所选姿势是否「上半身」类（线稿只画到胸下缘）。
 *        这类条目自己没有 pose.zh 要点，也撑不起全身构图：让它出全身，
 *        模型只能自己编下半身，编的过程中会把胸前手势一起丢掉。
 * @param {[number, number]} [p.frame] 画幅 [宽, 高]，用来在提示词里描述画幅比例。
 *        只作描述，不参与尺寸校验——尺寸仍然是 width/height 参数说了算。
 */
export function buildPrompt({
  style = 'photorealistic',
  extra = '',
  gender = 'female',
  poseHint = '',
  halfBody = false,
  frame = null,
} = {}) {
  // ────────────────────────────────────────────────────────────────────────────
  // 只有一条提示词路径。2026-11-18 之前这里挂过「详细 / 极简 / 本地对齐」三个模式，
  // 是用来做 A/B 对照的调试开关；对照结论已经拿到，开关只会把界面搞复杂、违背
  // 「选三张图就能出图」这个初衷，所以全部拆掉，只留下唯一一套写法。
  //
  // 这套写法照本地用 agnes-image-2.5-flash 一次跑通的那版配置来，四个要点缺一不可：
  //   ① 参考图顺序 姿势 → 脸 → 服装（姿势永远排第 1，权重最高）；
  //   ② 姿势图送原图（不压成 300px 缩略图 + JPEG，否则线稿细线全糊）；
  //   ③ size 用 2K 档位 + 单独 ratio（精确像素会被官方静默标准化，画幅跟着跑偏）；
  //   ④ 提示词逐图正面描述：先给**具体动作文字**，再声明权威。
  //
  // ④ 是最关键的一条。agnes 的多图合成按「每张参考图扮演什么角色」理解，
  // 它不会自己从线稿里读出动作。所以姿势条目必须带 pose.en（动作描述），
  // 否则模型就用「服装展示照」的先验把空白填成正面站直、双臂下垂 ——
  // 这正是「姿势不生效」最直接的来源。440 条没描述的条目已由
  // scripts/fill-pose-en.mjs 补齐。
  //
  // 还有一条踩过坑的经验：**否定句会被读成肯定动作**。
  // do not drop the arms / do not square the body 这类写法，T5 对否定不敏感，
  // 反而把 "drop the arms"、"square the body" 当成要画的内容。所以整段一个否定词都不留。
  //
  // 第五条（2026-11-18 晚补）：**动作文字只能说显著特征，不能说满**。
  // 文字完全压得住线稿——写错一句「另一只手垂在身侧」，成品就真的垂在身侧；
  // 写「reproduce this exact pose — X」时模型还会把 X 当成姿势的完整定义。
  // 所以要点用破折号夹成插入语，并逐项点名要照抄的部位（见下面 POSE 段）。
  // ────────────────────────────────────────────────────────────────────────────
  const lines = [
    'Photorealistic full-body fashion portrait of one person, head-to-toe, centered, feet fully visible.',
    'Three reference images are given in this order: 1 = pose line-art, 2 = face, 3 = outfit.',
  ];

  // 男性库的 pose.en 来自上游、与线稿不严格对应（SP-P021 线稿单臂高举、文字写扶颈贴腿），
  // 照旧不注入，避免文字与线稿打架。
  const poseText = poseHint && gender !== 'male'
    ? String(poseHint).replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
    : '';

  // 姿势段的三条经验（都是成品教出来的）：
  //   ① 文字只补「显著特征」，**绝不说满**。写成「reproduce this exact pose — X」时，
  //      模型把 X 当成整段姿势的完整定义：P020 线稿是「一手扶头 + 一手叉腰 + 双脚分开」，
  //      而条目文字被写成「…另一只手垂在身侧」，成品就真的垂在身侧、双腿并拢。
  //      改成「signature feature 只是其中一部分」之后，文字才回到「提示」的位置；
  //   ② 把需要照抄的部位逐项点名（手落点、重心、双脚间距、脚尖方向）——不点名，
  //      模型就用「服装展示照」的先验补成并腿站直，线稿上的站姿根本进不了画面；
  //   ③ 一个否定词都不留（T5 会把 don't drop the arms 读成 drop the arms）。
  const poseChecklist = 'which arm is raised and how that elbow bends, where each hand touches '
    + '(head, hip, waist, thigh or knee), the shoulder tilt, the hip shift, the spacing between '
    + 'the feet, the toe direction and the weight-bearing leg';

  lines.push(
    'POSE — HIGHEST PRIORITY (reference image 1): copy this exact pose;'
    // 用破折号把要点夹成插入语：让它读起来是「特征之一」，而不是整段姿势的定义
    + (poseText
      ? ` its signature feature — ${poseText} — is one part of it, and the rest of the body also comes from image 1: `
      : ' the whole body comes from image 1: ')
    + `${poseChecklist}.`
    + ' Both hands and both feet land exactly where the line-art figure has them.'
    + ' Reference image 1 is the absolute authority for body posture and camera angle.',
  );

  lines.push(
    'FACE and HAIR (reference image 2): take only the facial identity and hairstyle from it, and '
    + 'turn that head the way image 1 turns it.',
  );

  // 服装段收尾那句是「整个人体连贯」的正面声明。
  // 之前这里挂过一句 The bare legs of the line-art mannequin are not a styling choice ——
  // 既是否定句、又点名了 bare legs / mannequin，模型把服装图里假人的空白腿抄了进来，
  // 成品出现「裙子下摆到过膝袜之间整段空白、袜子浮空」外加一条图里没有的珍珠项链。
  // 换成正面声明后对全部素材都成立。
  lines.push(
    'OUTFIT (reference image 3): copy every garment head to toe exactly as shown — same type, '
    + 'same length, same colors, fabric, pattern and accessories. Render one continuous, '
    + 'anatomically connected body from head to feet, every garment worn on it; the torso, hips, '
    + 'legs and feet are all present and connected.',
  );

  if (gender === 'male') lines.push('The person is an adult man with a male body, keeping the pose of image 1.');

  // 上半身姿势：线稿只画到胸下缘，按全身出图模型会自己编腿，编的过程中手势全丢。
  // 这套措辞针对女性库（upper80v2 系列裁到胸下缘）；男性库裁到胯，用略松的一版。
  if (halfBody) {
    lines.push(
      gender === 'male'
        ? 'FRAMING — image 1 is an upper-body reference that stops at the hip: render a medium shot '
          + 'cropped around mid-thigh, slightly looser than image 1, and fill the frame with the body '
          + 'instead of zooming out. Everything image 1 shows — both hands, the forearms, the waist '
          + 'and the tilt of the hips — stays inside the frame, so no hand is cut off at the edge. '
          + 'Do not invent legs, feet, shoes or a standing full-length stance. Every hand gesture '
          + 'from image 1 must be reproduced and clearly readable.'
        : 'FRAMING — image 1 is an upper-body reference that stops below the chest: render a medium '
          + 'close-up cropped at mid-thigh, exactly like the crop of image 1, and fill the frame with '
          + 'the upper body instead of zooming out. Do not invent legs, feet, shoes or a standing '
          + 'full-length stance. The arms, hands and head are fully visible in this crop, so every '
          + 'hand gesture from image 1 must be reproduced and clearly readable.',
    );
  }

  lines.push(
    'STYLE: clean seamless studio backdrop, soft even lighting, natural skin texture, sharp '
    + 'focus, editorial fashion photography, vertical composition, hands and fingers clearly '
    + 'defined, no text, no watermark.',
  );
  if (style === 'anime') lines.push('Anime illustration style.');
  // 补充描述放最后：这是全文权重最高的位置，用户亲眼看过成品后写的纠正应该落在这里。
  if (extra) lines.push(extra);
  return lines.join(' ');
}

/**
 * 把 Workers AI 的失败原因归类成「HTTP 状态 + 人话文案」。
 *
 * 抽成纯函数是因为这里踩过坑：早先只用 /neuron|quota|limit|exceed/ 一条正则判断配额，
 * 结果上游的「Memory limit exceeded」「image size limit exceeded」全被吞成
 * 「今日免费额度可能已用完」——用户第二天配额明明已重置，看到的还是同一句话。
 *
 * 判定顺序很关键：先排除尺寸/内存/容量类，再判配额。
 */
export function classifyAiFailure({ msg = '', code = null } = {}) {
  const text = String(msg || '');
  const info = { raw: text, code };

  // ① 输入侧问题：这类报错里同样常带 limit / exceed，必须先拦
  if (/512|image size|dimension|too large|payload|context length|batch size|invalid image/i.test(text)) {
    return {
      status: 400,
      message: /512|image size|dimension|too large/i.test(text)
        ? '参考图尺寸超限：FLUX.2 klein 要求每张输入图小于 512×512（前端已自动缩放，可换一张图再试）'
        : `Workers AI 拒绝了输入内容：${clip(text)}`,
      info,
    };
  }
  // ② 上游内存不足：是服务端资源问题，不是配额，也不是输入格式错
  if (/memory|out of memory|oom/i.test(text)) {
    return {
      status: 502,
      message: `Workers AI 上游资源不足（${clip(text, 100)}），换个模型或稍后重试；这不是额度用完`,
      info,
    };
  }

  // ③ 配额：按「上游原文」判定，不看错误码。
  // 官方错误码表把额度耗尽记作 3036 "Account limited"，但自由额度耗尽实际上抛的是
  // 4006，两条文案完全一样；用文案判定才不会因为码对不上而漏判。
  const quotaish =
    /used up your daily free allocation|daily free allocation|out of neurons|daily neuron limit/i.test(text)
    || /neuron|quota|allocation|insufficient (?:credit|balance)|out of credit/i.test(text);
  // ④ 容量/限流：不是配额，等几秒重试就好，别让用户以为额度没了
  const capacityish = /rate.?limit|too many requests|capacity|overload|concurren|temporar|busy/i.test(text);

  if (quotaish && !capacityish) {
    return {
      status: 429,
      message: buildQuotaMessage(text),
      info,
    };
  }
  if (capacityish) {
    return {
      status: 503,
      message: `Workers AI 当前繁忙或触发限流，稍等几秒再点一次（并非额度用完）。上游原文：${clip(text, 120)}`,
      info,
    };
  }

  return {
    status: 502,
    message: code === 3043
      ? 'Workers AI 内部错误（3043）已自动重试一次仍失败，通常是上游瞬时故障。可换个模型或画幅再试。'
      : `Workers AI 调用失败：${clip(text)}`,
    info,
  };
}

/**
 * 额度耗尽的提示。
 *
 * 控制台显示「今日 0/10k」却照样报 4006 是社区里反复出现的既定行为：
 * 超额之后，封锁要到**当天首次使用满 24 小时**才解除，而不是 UTC 0 点；
 * 而用量面板在新的一天从 0 开始记，于是面板与拦截计数对不上。
 * 所以文案不要写死「UTC 0 点重置」——那句话会让人以为等到点就好了。
 */
function buildQuotaMessage(text) {
  return 'Workers AI 免费额度已用尽（10,000 Neurons/日，账号级共享）。'
    + '注意：超额后的封锁通常要到「当日首次使用起满 24 小时」才解除，'
    + '而控制台的「今日用量」在新的一天会从 0 开始记，所以显示 0/10k 也可能仍在封锁中。'
    + `上游原文：${clip(text, 120)}`;
}

/** 错误原文可能很长且带换行，截断后再拼进提示 */
function clip(s, n = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 把 Workers AI 抛出的错误整理成可读、可定位的结构 */
export function describeAiError(e) {
  const msg = String(e?.message || e);
  const code = e?.internalCode ?? e?.code ?? null;
  // 报错文本里常带一长串十六进制 Ray ID，是找 Cloudflare 排查的唯一凭据，务必带出来
  const ray = e?.rayId || e?.ray || (msg.match(/\(([0-9a-f]{16,})\)/i)?.[1] ?? null);
  return { msg, code, ray, name: e?.name || 'Error' };
}

/** 把 dataURL 解析成 { mime, bytes } */
export function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new HttpError(400, '图片格式无效，需要 data:image/...;base64 形式');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1], bytes };
}

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * 参考图归一化：把「看起来像图」的东西收敛成 data URI 字符串。
 *
 * 这条防线是踩过坑才加的：`toReference()` 返回的是 `{ dataUrl, w, h }`，
 * 中途有人把 `return ref.dataUrl` 改回 `return ref`，于是 `extra_body.image`
 * 里塞进三个对象。上游读不到图，只回一句「image 必须包含图片值」，
 * 而界面上的三张缩略图都在——从现象完全看不出是格式问题。
 *
 * 现在无论谁传对象、传 URL、传字符串，都先在这里收敛；拿不到图就明确报错，
 * 不再把结构错误留给上游去猜。
 */
export function normalizeRefImages(images) {
  const list = Array.isArray(images) ? images : [];
  const out = [];
  for (const it of list) {
    if (typeof it === 'string') {
      const s = it.trim();
      if (s) out.push(s);
      continue;
    }
    // 兼容 { dataUrl } / { url } 这类包装对象
    const s = typeof it?.dataUrl === 'string' ? it.dataUrl
      : typeof it?.url === 'string' ? it.url
        : '';
    if (s.trim()) out.push(s.trim());
  }
  return out;
}

/**
 * 参考图摘要：拼进错误文案，让「带没带图、什么格式、多大」一眼可见。
 * 上游 400 只说「image 必须包含图片值」时，靠这行就能分清
 * 「压根没传」和「传了但它不认这个格式」——两种情况改法完全不同。
 */
export function describeRefImages(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return '参考图 0 张';
  const kinds = {};
  let bytes = 0;
  for (const it of list) {
    const s = typeof it === 'string' ? it : '';
    const m = /^data:image\/([a-z0-9.+-]+)/i.exec(s);
    const kind = m ? m[1].toLowerCase() : /^https?:\/\//i.test(s) ? 'url' : 'unknown';
    kinds[kind] = (kinds[kind] || 0) + 1;
    bytes += s.length;
  }
  const detail = Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(' ');
  return `参考图 ${list.length} 张（${detail}），约 ${Math.round(bytes / 1024)}KB`;
}

export function assertThreeImages(images) {
  if (!Array.isArray(images) || images.length !== 3) {
    throw new HttpError(400, '需要恰好三张参考图：服装、脸、姿势');
  }
  for (const [i, img] of images.entries()) {
    if (!img || typeof img !== 'string' || !img.startsWith('data:image/')) {
      throw new HttpError(400, `第 ${i + 1} 张参考图缺失或格式错误`);
    }
    // 单张 base64 限制，避免有人塞原图把请求体撑爆
    if (img.length > 2_400_000) {
      throw new HttpError(413, `第 ${i + 1} 张参考图过大，请压缩到 1.8MB 以内`);
    }
  }
}

/* ────────────────────────────── Cloudflare ────────────────────────────── */

/**
 * FLUX.2 klein / dev 走 multipart：prompt + input_image_0..3。
 * 官方要求所有输入图 < 512x512，超出会被拒；前端已经按此缩放。
 */
export function buildCloudflareForm({ images, prompt, modelId, width = 1024, height = 1024, seed }) {
  const out = new FormData();
  out.append('prompt', prompt);
  out.append('width', String(width));
  out.append('height', String(height));
  if (seed != null) out.append('seed', String(seed));
  images.forEach((dataUrl, i) => {
    const { mime, bytes } = parseDataUrl(dataUrl);
    // 文件名扩展名必须与实际 MIME 一致：曾经统一叫 ref-N.png 却塞 JPEG 数据，
    // 后端按扩展名解析时容易判成坏图（表现为 3043）。
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    out.append(`input_image_${i}`, new Blob([bytes], { type: mime }), `ref-${i}.${ext}`);
  });
  return { modelId, form: out };
}

/* ───────────────────────────── 统一入口 ───────────────────────────── */

/**
 * 调 Workers AI 生成合成图。
 *
 * @param {object} p
 * @param {string[]} p.images  顺序固定：服装 / 脸 / 姿势
 * @param {object}   p.env     Worker 的 env（读 AI binding 与 FLUX_MODEL）
 * @param {Function} p.aiRun   env.AI.run 的绑定版本（丢失 this 会报错，必须 bind）
 */
export async function generate({ images, prompt, model, env = {}, aiRun, width, height, seed, style, extra = '', gender, poseHint, halfBody, probe = false }) {
  // probe：只发 prompt + 尺寸，不带任何参考图。
  //
  // 诊断用。报 3043 / 500 时，最常见的三种原因是「模型不支持多图」「输入图太大/格式不认」
  // 「上游瞬时就挂了」。光看报错分不出是哪一种，但把它们拆开就很容易：
  // 探针成功 → 模型和尺寸没问题，问题在多图输入（或某一张图）；探针也失败 → 上游/额度，
  // 跟图无关，别再去改提示词。
  if (!probe) assertThreeImages(images);
  const imgs = probe ? [] : images;

  if (typeof aiRun !== 'function') {
    throw new HttpError(501, '未绑定 Workers AI（缺少 [ai] binding）', {
      hint: 'wrangler.jsonc 中加入 "ai": { "binding": "AI" }',
    });
  }

  const finalPrompt = prompt || buildPrompt({ style, extra, gender, poseHint, halfBody, frame: [width, height] });
  // 优先级：请求里显式指定（白名单校验）→ 环境变量 → 默认
  const allowed = new Set(Object.values(MODELS).map((m) => m.modelId));
  const wanted = model || env.FLUX_MODEL || DEFAULT_MODEL;
  const modelId = allowed.has(wanted) ? wanted : DEFAULT_MODEL;

  const started = Date.now();

  // body 是流，只能消费一次，重试必须重新构造 FormData
  let res;

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { form } = buildCloudflareForm({ images: imgs, prompt: finalPrompt, modelId, width, height, seed });
    const serialized = new Response(form);
    try {
      res = await aiRun(modelId, {
        multipart: { body: serialized.body, contentType: serialized.headers.get('content-type') },
      });
      break;
    } catch (e) {
      lastErr = describeAiError(e);
      // 3043 / 5xx / 超时基本是上游瞬时故障，同一请求重发通常就成了；4xx 类不重试
      const transient =
        lastErr.code === 3043 || /internal server error|internal error|timed? ?out|50[023]|overloaded/i.test(lastErr.msg);
      if (!transient || attempt === 1) break;
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  if (!res) {
    const { msg, code, ray } = lastErr || { msg: '未知错误' };
    const { status, message, info } = classifyAiFailure({ msg, code });
    throw new HttpError(status, message, {
      ...info,
      ray,
      model: modelId,
      size: `${width}×${height}`,
      images: imgs.length,
      probe,
    });
  }

  // 官方返回 { image: base64 }；不同封装可能给 Uint8Array 或 data: URI，统一收口
  const raw = res?.image ?? res?.result?.image ?? res;
  const meta = { model: modelId, prompt: finalPrompt, ms: Date.now() - started, images: imgs.length, probe };

  if (typeof raw === 'string') {
    const b64 = raw.startsWith('data:') ? raw.split(',')[1] : raw;
    const mime = raw.startsWith('data:') ? raw.slice(5, raw.indexOf(';')) : 'image/png';
    return { b64, mime, ...meta };
  }
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { b64: btoa(bin), mime: 'image/png', ...meta };
  }
  throw new HttpError(502, 'Workers AI 返回结构无法识别', res);
}
