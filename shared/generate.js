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
 * 默认模型。可换的候选（都在 Workers AI 目录内，均支持多参考图）：
 *   @cf/black-forest-labs/flux-2-klein-9b   4 步蒸馏，输入图须 < 512，约 1,363 Neurons/张
 *   @cf/black-forest-labs/flux-2-klein-4b   更便宜更快，约 1,024 Neurons/张
 *   @cf/black-forest-labs/flux-2-dev        质量最好、输入图无 512 限制，但步数多、最贵
 * 改环境变量 FLUX_MODEL 即可切换，无需改代码。
 */
export const MODELS = {
  'flux-2-klein-9b': {
    label: 'FLUX.2 klein 9B',
    modelId: '@cf/black-forest-labs/flux-2-klein-9b',
    note: '默认。质量与成本平衡，输入图需 <512',
    quota: '7 张',
  },
  'flux-2-klein-4b': {
    label: 'FLUX.2 klein 4B',
    modelId: '@cf/black-forest-labs/flux-2-klein-4b',
    note: '最省额度，适合调试',
    quota: '9 张',
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
 * 构造合成指令。要点：
 * - 明确每张参考图的职责（角色分工是 prompt 结构里最关键的一环）
 * - 明确「必须保留什么」「必须替换什么」，避免模型照抄服装图的空白人体
 * - 姿势线稿要显式说明「只取骨架与角度，不要线稿风格」
 */
export function buildPrompt({ style = 'photorealistic', extra = '', gender = 'female' } = {}) {
  const styleLine = {
    photorealistic:
      'Photorealistic editorial fashion photography, realistic skin texture, natural light, ' +
      'clean seamless studio background, full-body shot, 85mm lens, sharp focus.',
    anime:
      'High-quality anime illustration, clean cel shading with soft gradients, ' +
      'full-body character illustration, simple gradient background.',
  }[style] || 'Photorealistic editorial photography.';

  // 男性版的参考图（中性人台、中性人偶）不带性别信息，必须显式说明，否则模型会按默认女性渲染
  const subject =
    gender === 'male'
      ? 'The person is an adult man: male facial structure, male body proportions, flat chest, no makeup.'
      : 'The person is an adult woman: female facial structure, female body proportions.';

  const parts = [
    'Compose ONE single new image of one person, using the three reference images below.',
    subject,
    'Reference image 1 defines the OUTFIT ONLY: copy its garments, colors, fabric, patterns, ' +
      'accessories and footwear exactly as shown. Ignore the empty body inside it — do not render ' +
      'a mannequin, do not leave the torso hollow, and do not copy its standing front view.',
    'Reference image 2 defines the FACE ONLY: use this exact face identity, facial features, ' +
      'hairstyle and hair color for the person.',
    'Reference image 3 defines the POSE AND CAMERA ANGLE ONLY: reproduce its body posture, limb ' +
      'placement, leg crossing, hand positions and viewpoint exactly. Ignore its line-art style, ' +
      'its blank face and its simplified proportions — the result must be a finished rendered image.',
    'The person is dressed in the outfit from image 1, has the face from image 2, and holds the ' +
      'pose from image 3. Keep anatomy correct and proportions natural in the new pose.',
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

  // ② 配额：必须点到 neuron / quota / allocation 这类明确词
  const quotaish = /neuron|quota|allocation|daily (?:free|limit)|insufficient (?:credit|balance)|out of credit/i.test(text);
  // ③ 容量/限流：不是配额，等几秒重试就好，别让用户以为额度没了
  const capacityish = /rate.?limit|too many requests|capacity|overload|concurren|temporar|busy/i.test(text);

  if (quotaish && !capacityish) {
    return {
      status: 429,
      message: `今日 Workers AI 免费额度可能已用完（10,000 Neurons/日，UTC 0 点重置）。上游原文：${clip(text, 120)}`,
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
export async function generate({ images, prompt, model, env = {}, aiRun, width, height, seed, style }) {
  assertThreeImages(images);

  if (typeof aiRun !== 'function') {
    throw new HttpError(501, '未绑定 Workers AI（缺少 [ai] binding）', {
      hint: 'wrangler.jsonc 中加入 "ai": { "binding": "AI" }',
    });
  }

  const finalPrompt = prompt || buildPrompt({ style });
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
