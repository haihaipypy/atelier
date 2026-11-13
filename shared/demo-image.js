/**
 * 演示模式拼图：纯 JS 生成 SVG，不依赖 Canvas。
 * 用途有两个：
 *   1. 未配置密钥时，让「选三张 → 出图」的完整链路可被体验与测试；
 *   2. 作为对照基线 —— 它只做拼版，不做融合，能直观说明「为什么必须用模型」。
 * 输出是一张带三格参考图的编排预览（result 宽高比、留白、标注都按最终成品布局）。
 */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function makeDemoImage({ images = [], width = 1024, height = 1024 }) {
  const W = Math.min(width, 1280);
  const H = Math.min(height, 1600);
  const pad = Math.round(W * 0.045);
  const gap = Math.round(W * 0.02);

  // 三格横向排布在顶部，下方留出「成品区」示意
  const cellW = Math.floor((W - pad * 2 - gap * 2) / 3);
  const cellH = Math.round(cellW * 1.33);
  const labels = ['① 服装', '② 脸', '③ 姿势'];

  const cells = images.slice(0, 3).map((src, i) => {
    const x = pad + i * (cellW + gap);
    const y = pad + Math.round(W * 0.055);
    return `
    <g>
      <rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="${Math.round(cellW * 0.04)}" fill="#f1ece5" />
      <image href="${esc(src)}" x="${x}" y="${y}" width="${cellW}" height="${cellH}"
             preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round ${Math.round(cellW * 0.04)}px)" />
      <rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="${Math.round(cellW * 0.04)}"
            fill="none" stroke="#2f6f5e" stroke-opacity=".35" stroke-width="2" />
      <text x="${x + cellW / 2}" y="${y + cellH + Math.round(W * 0.032)}" text-anchor="middle"
            font-family="PingFang SC, Noto Sans SC, sans-serif" font-size="${Math.round(W * 0.024)}"
            fill="#5d564e">${labels[i] || ''}</text>
    </g>`;
  }).join('');

  const panelY = pad + Math.round(W * 0.055) + cellH + Math.round(W * 0.06);
  const panelH = H - panelY - pad;
  const cx = W / 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffdfa"/><stop offset="1" stop-color="#f6f0e8"/>
    </linearGradient>
    <pattern id="hatch" width="16" height="16" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="16" stroke="#b4553a" stroke-opacity=".12" stroke-width="7"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="${pad}" y="${Math.round(W * 0.042)}" font-family="Georgia, Songti SC, serif"
        font-size="${Math.round(W * 0.03)}" fill="#1d1a17" letter-spacing="1">AI角色合成工坊 · 合成预览</text>
  ${cells}
  <g>
    <rect x="${pad}" y="${panelY}" width="${W - pad * 2}" height="${panelH}" rx="${Math.round(W * 0.03)}"
          fill="url(#hatch)" stroke="#b4553a" stroke-opacity=".35" stroke-dasharray="10 8" stroke-width="2"/>
    <text x="${cx}" y="${panelY + panelH / 2 - Math.round(W * 0.012)}" text-anchor="middle"
          font-family="PingFang SC, Noto Sans SC, sans-serif" font-size="${Math.round(W * 0.03)}" fill="#b4553a">
      模型生成区（演示模式不产生真实图像）
    </text>
    <text x="${cx}" y="${panelY + panelH / 2 + Math.round(W * 0.035)}" text-anchor="middle"
          font-family="PingFang SC, Noto Sans SC, sans-serif" font-size="${Math.round(W * 0.021)}" fill="#938a80">
      绑定 Workers AI 后，这里会输出融合后的单人成品图
    </text>
  </g>
  <text x="${W - pad}" y="${H - Math.round(W * 0.016)}" text-anchor="end"
        font-family="PingFang SC, Noto Sans SC, sans-serif" font-size="${Math.round(W * 0.017)}" fill="#938a80">
  ${W} × ${H}
  </text>
</svg>`;

  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}
