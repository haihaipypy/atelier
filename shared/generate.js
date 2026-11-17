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
  // 中英交界处如果还留着没结束的英文尾，直接砍掉：宁可少一句描述，也不给模型半句指令
  const cut = t.replace(/\s*[A-Za-z][A-Za-z',\-\s]*$/, '').trim();
  const head = cut || t;
  return head.length > 200 ? `${head.slice(0, 200)}…` : head;
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
  // 镜头信息里绝不能出现 "full-body" 这类景别词。
  // 原因：图3 是姿势参考，图1 的服装常常是连衣裙/半身裙，两样一起给的时候模型
  // 会去找一个"能把整套衣服完整展示"的安全站姿——最省事的就是正面站直、双手贴身。
  // 景别交给图3（它自己裁到哪就是哪），这里只描述质感与光线。
  const styleLine = {
    photorealistic:
      'Photorealistic editorial fashion photography, realistic skin texture, natural light, ' +
      'clean seamless studio background, 85mm lens, sharp focus.',
    anime:
      'High-quality anime illustration, clean cel shading with soft gradients, ' +
      'simple gradient background.',
  }[style] || 'Photorealistic editorial photography.';

  // 画幅描述：不写景别，只写形状，避免又把模型往「站直展示全身」上推
  let frameLine = '';
  if (Array.isArray(frame) && frame[0] > 0 && frame[1] > 0) {
    const r = frame[0] / frame[1];
    frameLine = Math.abs(r - 1) < 0.04
      ? 'The output canvas is square; frame the figure to fill it, not to fit it.'
      : r < 1
        ? 'The output canvas is taller than wide; frame the figure to fill its width as well as its height.'
        : 'The output canvas is wider than tall; frame the figure to fill its height as well as its width.';
  }


  // 男性版的参考图没有男性特征（中性人台 + 女性素体人偶），必须显式说明，
  // 否则模型会按默认女性渲染，或者干脆丢掉姿势、退回站姿
  const subject =
    gender === 'male'
      ? 'The person is an adult man: male facial structure, male body proportions, flat chest, no makeup.'
      : 'The person is an adult woman: female facial structure, female body proportions.';

  // 姿势参考图是女性素体线稿：轮廓里的胸部曲线、腰胯比例会跟「成年男性」打架。
  // 实测这两条提示互斥时，模型最常见的处理方式是直接忽略姿势、输出一张正面站姿——
  // 也就是「姿势不生效」。所以要分两段写清楚：轮廓可以无视，骨架必须照搬。
  const poseRef =
    gender === 'male'
      ? 'Reference image 3 defines the POSE AND CAMERA ANGLE ONLY. It is drawn on a female artist mannequin: ' +
        'ignore that mannequin\'s female body shape (its bust curve, waist-to-hip ratio and overall silhouette) ' +
        'entirely, and do NOT carry any feminine body shape over to the man. Keep only its skeleton: ' +
        'which limb is where, joint angles, weight distribution, head direction, cropped view and camera height. ' +
        'The man in the final image must be posed exactly like that skeleton, with a male body. ' +
        'Do not replace the pose with a standing or walking pose.'
      : 'Reference image 3 defines the POSE AND CAMERA ANGLE ONLY: reproduce its body posture, limb ' +
        'placement, leg crossing, hand positions and viewpoint exactly.';
  // 姿态要点的措辞分性别：男性版多一句「只取骨架」——参考图是女性素体线稿，
  // 轮廓和「成年男性」冲突时模型会连姿势一起丢掉；女性版只做「确认」，多说反而添乱
  const hint = clipPoseHint(poseHint);
  const hintLine = hint
    ? gender === 'male'
      ? `The intended pose in words — the reference is a female artist mannequin, so take only its ` +
        `skeleton and camera from these words, never its bust or waist-hip contour: ${hint}.`
      : `The intended pose in words (use it to confirm image 3, never to override the outfit or the face): ${hint}.`
    : '';

  // 上半身姿势是另一套取景规则。
  //
  // 这类线稿只画到胸下缘（upper 系列连双腿都不画），而图1 往往是长裙或整套造型。
  // 一旦要求「把服装完整展示出来」，模型就必须自己编一个下半身——编的过程中
  // 最省事的做法是让手臂自然垂下，胸前的手势（比心、剪刀手、托腮）全部丢失。
  // 实测症状：选了「胸前双手心形」，成品是双手垂在身侧、还额外补了腿和鞋。
  //
  // 所以这里改成正向要求：按线稿裁到大腿中部，手要比划出来，衣服能露多少露多少。
  const framing = halfBody
    ? 'FRAMING — image 3 is an upper-body reference: it stops below the chest and has no legs. ' +
      'Render a medium close-up cropped at mid-thigh, exactly like the crop of image 3, and fill the ' +
      'frame with the upper body instead of zooming out. Do not invent legs, feet, shoes or a ' +
      'standing full-length stance, and do not show the hem of the garment if it falls outside that crop. ' +
      'The arms, hands and head are fully visible in this crop, so every hand gesture from image 3 ' +
      'must be reproduced and clearly readable — do not lower the arms, and do not hide the hands ' +
      'behind the body, under the hair or outside the frame. When image 3 shows the hands doing ' +
      'something (heart shape, peace sign, hands on cheeks, finger heart), that gesture is the ' +
      'subject of the picture and the face must stay visible behind or between the hands.'
    : '';

  // 站姿反例只对全身取景有意义。半身像里「别并腿」既不可见，又会把模型
  // 往「画出腿」上拽——那样正好丢掉手势，与半身的要求相反。
  const stanceGuard = halfBody
    ? ''
    : 'The stance must follow image 3, not a default catalogue pose. Do not straighten the legs, ' +
      'do not close the gap between the feet, do not square the hips and shoulders to the camera, ' +
      'and do not drop the arms flat against the sides, unless image 3 itself shows exactly that.';

  const parts = [
    'Compose ONE single new image of one person, using the three reference images below.',
    subject,
    'Reference image 1 defines the OUTFIT ONLY: copy its garments, colors, fabric, patterns, ' +
      'accessories and footwear exactly as shown. Ignore whatever body is inside it — do not render ' +
      'a mannequin and do not leave the torso hollow. Its pose means nothing: take NO body posture, ' +
      'leg position or camera from image 1, even when image 1 shows a person standing straight.',
    'Reference image 2 defines the FACE ONLY: use this exact face identity, facial features, ' +
      'hairstyle and hair color for the person.',
    poseRef,
    'Ignore the line-art style, the blank featureless head and the simplified proportions of ' +
      'reference image 3 — the result must be a finished rendered image.',
    'The person is dressed in the outfit from image 1, has the face from image 2, and holds the ' +
      'pose from image 3. Keep anatomy correct and proportions natural in the new pose.',
    // 姿态要点放在职责说明之后，避免抢掉「图1只给衣服、图2只给脸」的强约束
    hintLine,
    framing,
    // 反例比正例管用：模型对「站直、双手贴身」的默认偏好极强，不点名的话，
    // 只要服装是长裙就会自己滑回正面站姿。这一句放在姿势段之后、风格之前，
    // 让它落在模型最后读到的位置附近。
    stanceGuard,
    frameLine,
    styleLine,
    extra,
  ];
  return parts.filter(Boolean).join(' ');
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
export async function generate({ images, prompt, model, env = {}, aiRun, width, height, seed, style, gender, poseHint, halfBody }) {
  assertThreeImages(images);

  if (typeof aiRun !== 'function') {
    throw new HttpError(501, '未绑定 Workers AI（缺少 [ai] binding）', {
      hint: 'wrangler.jsonc 中加入 "ai": { "binding": "AI" }',
    });
  }

  const finalPrompt = prompt || buildPrompt({ style, gender, poseHint, halfBody, frame: [width, height] });
  // 优先级：请求里显式指定（白名单校验）→ 环境变量 → 默认
  const allowed = new Set(Object.values(MODELS).map((m) => m.modelId));
  const wanted = model || env.FLUX_MODEL || DEFAULT_MODEL;
  const modelId = allowed.has(wanted) ? wanted : DEFAULT_MODEL;

  const started = Date.now();

  // body 是流，只能消费一次，重试必须重新构造 FormData
  let res;

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { form } = buildCloudflareForm({ images, prompt: finalPrompt, modelId, width, height, seed });
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
      images: images.length,
    });
  }

  // 官方返回 { image: base64 }；不同封装可能给 Uint8Array 或 data: URI，统一收口
  const raw = res?.image ?? res?.result?.image ?? res;
  const meta = { model: modelId, prompt: finalPrompt, ms: Date.now() - started };

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
