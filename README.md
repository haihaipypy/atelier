# Atelier · 角色服装合成工坊

**服装、脸型、姿势三个模块各选一张，合成出一张完整的角色效果图。**

这是本项目的全部功能：拆开来看，上游素材每个都只有一个维度——服装是穿在无头人台上的，
脸是正面大头照，姿势是黑白线稿；合起来看，就是「穿着这件衣服、长这张脸、摆这个姿势」的成品。

选三张、点一次生成，10–30 秒拿到结果。不用开 PS，不用手动换脸、重绘、调姿势。

**原生 HTML + CSS + ES Module，零前端框架，无构建步骤。** 克隆 → `wrangler deploy` → 上线。

---

## 目录

- [功能](#功能)
- [部署](#部署)
- [用法](#用法)
- [免费额度与模型设置](#免费额度与模型设置)
- [图库同步](#图库同步)
- [上游图库与版权](#上游图库与版权)
- [目录结构](#目录结构)
- [已知限制](#已知限制)
- [许可](#许可)

---

## 功能

### 素材库

| 板块 | 数量 | 说明 |
|---|---|---|
| 服装 | 1,267 套 | 覆盖春夏秋冬、内衣、泳装、派对等场景 |
| 脸型 | 893 张 | 含发长、发型、发色标签 |
| 姿势 | 440 个 | 含编号、动作描述、机位角度 |

- **搜索**：支持编号、颜色、品类。空格分隔表示「同时满足」，例如 `AUT 酒红 裙`
- **分类筛选**：下拉即时过滤
- **分页浏览**：每页 60 条，页码智能省略，底部实时显示当前区间
- **全中文**：上游是日文元数据，已内置词表统一翻译，界面无日文残留
- **大图预览**：点卡片先弹大图，看清细节后「确认选择」才填入槽位，避免误点覆盖

### 合成

三张参考图在 prompt 里**职责严格分离**，这是多图合成能否成功的关键：

| 位置 | 参考图 | 模型要做的 | 模型必须忽略的 |
|---|---|---|---|
| `input_image_0` | 服装 | 复制衣服、配色、材质、配饰、鞋 | 里面那只空人体、正立站姿 |
| `input_image_1` | 脸 | 复制五官、发型、发色 | 肩膀以下 |
| `input_image_2` | 姿势 | 复制体态、四肢位置、视角 | 线稿风格、空白脸、简化比例 |

prompt 里用 `Reference image 1/2/3` 显式引用。模板在 [`shared/generate.js`](shared/generate.js) 的 `buildPrompt()`，
页面上「生成设置 → 自定义提示词」可以覆盖。

其他能力：

- **画幅选择**：3:4 / 1:1 / 9:16 / 4:3
- **风格切换**：写实摄影 / 二次元插画
- **手动上传**：任一槽位可上传自己的图片，替代图库素材
- **自动跳过**：选完一个板块自动切到下一个未选板块

### 双模型通道

| 通道 | 说明 |
|---|---|
| **Cloudflare Workers AI** | 平台原生，走你自己的账号额度，无需任何 API Key |
| **自定义模型** | 任意 OpenAI 兼容的 `/v1/images/generations` 接口，如中转站、自建服务、官方 API |

两个通道在页面上随时切换，自定义模型的密钥存在服务端，前端只能看到尾号。

### 演示模式

未绑定 AI 时自动进入演示模式：页面功能完整，生成返回一张「三格参考 + 成品区」的 SVG 布局预览图，
并在界面上明确标注**这不是真实生成结果**。用于验收交互链路，不会伪装成成品。

---

## 部署

### 前置条件

- [Node.js](https://nodejs.org/) 18+
- 一个 [Cloudflare](https://dash.cloudflare.com/sign-up) 账号（免费版即可）

### 三步上线

```bash
git clone https://github.com/haihaipypy/atelier.git
cd atelier
npm install
npx wrangler login      # 浏览器授权
npx wrangler deploy     # 静态资源 + API 一起上线
```

输出会给出 `https://atelier-compose.<你的子域>.workers.dev`，直接可访问。

`wrangler.jsonc` 里 `assets.directory` 指向 `web/public`，**没有构建步骤**，
克隆下来就是可运行的完整应用。

### 绑定模型额度

`wrangler.jsonc` 已包含 AI 绑定，不需要额外配置：

```jsonc
"ai": { "binding": "AI" }
```

这是 Workers AI **直连绑定**，不经过任何第三方网关，消耗你自己账号的 Neurons 额度，
不存在 API Key 泄露问题。

### 可选：开启页面内保存自定义模型

想把自定义模型的 Base URL / Key 存在服务端（而不是用环境变量），需要绑定一个 KV：

```bash
npx wrangler kv namespace create CONFIG
```

把返回的 `id` 填进 `wrangler.jsonc`：

```jsonc
"kv_namespaces": [{ "binding": "CONFIG", "id": "<你的 namespace id>" }]
```

没有绑 KV 也能用自定义模型，只是配置得走环境变量（见下一节），
页面弹窗底部会直接说明这一点，不会让你白填。

### 改用环境变量配置自定义模型

```bash
npx wrangler secret put CUSTOM_BASE_URL   # 例：https://your-gateway.com/v1
npx wrangler secret put CUSTOM_API_KEY
npx wrangler secret put CUSTOM_MODEL      # 例：gpt-image-1
```

### 本地开发

```bash
npm run sync              # 同步最新图库索引
npm run dryrun            # 46 项自检，不需要任何密钥
npm run dev               # wrangler dev，本地 Cloudflare 环境
```

想用纯 Node 环境（不启动 wrangler）预览静态页 + API：

```bash
node scripts/preview-server.mjs   # 默认 http://localhost:8099
```

本地配置写在 `.dev.vars`（参考 `.dev.vars.example`），该文件已在 `.gitignore` 中。

### 自动同步图库

`.github/workflows/sync-catalogs.yml` 每天 03:17 UTC 拉取上游最新索引，**有变化才提交**。
如果不需要自动更新，删掉这个文件即可。

---

## 用法

### 1. 选素材

左侧三个标签切换图库。点任意卡片会弹出大图：

- 看清了 → 点「确认选择」（或按 `Enter`）
- 不合适 → 点 ✕ 或按 `Esc` 关闭
- 已选中的素材再点开，按钮变成「取消选择」

选齐三项后，右侧三个槽位都会显示缩略图。

### 2. 调参数（可选）

展开「生成设置」：

| 项目 | 作用 |
|---|---|
| 画幅 | 3:4 适合人物全身，9:16 适合手机壁纸 |
| 生成通道 | Cloudflare 原生 / 自定义模型 |
| 生成模型 | 三个 FLUX 模型任选，见下节 |
| 渲染风格 | 写实摄影 / 二次元插画 |
| 自定义提示词 | 留空用内置模板；填了会完全替换 |

### 3. 生成

点「生成合成图」。真实生成通常 10–30 秒，完成前按钮会显示进度。

结果出来后可以：

- 「下载」保存图片
- 底部会显示所用模型和耗时，方便对比不同模型
- 换一组素材再生成
- 点右上角「清空」重置全部槽位

### 4. 换用你自己的模型

点「去配置自定义模型 →」：

| 配置项 | 说明 |
|---|---|
| Base URL | 填到 `/v1` 即可，程序自动拼 `/images/generations` |
| API Key | 存服务端 KV，前端只能看到尾号 |
| 模型名称 | 如 `agnes-image-2.5-flash`、`gpt-image-1`、`flux-pro` |
| 参考图传递方式 | `data URI`（最通用）或公网 URL |
| 额外参数 | 任意 JSON，会合并进请求体 |

填完可以点「测试连通」发一次极小的文生图请求，验证配置是否正确。
三张参考图通过 `extra_body.image` 以数组传入，`response_format` 固定 `b64_json`，
返回兼容 `data[0].b64_json`、`data[0].url`、`images[0]` 三种结构。

---

## 免费额度与模型设置

### 为什么只做 Cloudflare

先把话说清楚：**EdgeOne 有免费额度，但免费的是「运行环境」，不是模型。**

| 项目 | Cloudflare Workers AI | 腾讯云 EdgeOne |
|---|---|---|
| 函数运行 | Workers 免费版 | Cloud Functions 免费版，100 万次调用、120s 超时 |
| **模型推理** | **含在每天 10,000 Neurons 内** | 内置 `@makers/*` **只有文本模型**，出图必须绑自己的混元 API Key |
| 出图成本 | 免费额度内 **¥0** | 混元按 token 计费，无免费出图层 |
| 超额行为 | 免费版直接报错，**不会偷偷扣费** | 按量扣费 |

结论：想「不花钱把站跑起来」，只有 Cloudflare 这一条路。
要接 EdgeOne，改动点很小：`shared/generate.js` 的 `generate()` 加一个分支，
`/api/config` 多返回一个能力项，前端无需改动。

### 免费额度

**每天 10,000 Neurons，UTC 0 点重置（北京时间早上 8 点）。**

| 模型 | 每张 1024² 消耗 | 免费额度约能出 |
|---|---|---|
| `flux-2-klein-9b`（默认） | ≈1,363 Neurons | **约 7 张/天** |
| `flux-2-klein-4b` | ≈1,024 Neurons | 约 9 张/天 |
| `flux-2-dev` | 按步计费，最高 | 2–3 张/天 |

超出额度后请求直接报错，**不会产生费用**。付费价格约 $0.011 / 1000 Neurons。

个人玩、做作品集、给客户看 demo 都够用。

> ⚠️ **对外公开前必须加限流。** 否则第一天额度就会被陌生人打空，站点变成一团 429。
> 建议用 KV 按 IP 计数，或前置 Cloudflare Rate Limiting 规则。

### 三个模型怎么选

| 模型 | 输入图限制 | 什么时候用 |
|---|---|---|
| `@cf/black-forest-labs/flux-2-klein-9b` **默认** | 每张 < 512×512 | 日常。质量与成本平衡 |
| `@cf/black-forest-labs/flux-2-klein-4b` | 每张 < 512×512 | 调 prompt、压成本 |
| `@cf/black-forest-labs/flux-2-dev` | **无 512 限制** | 服装纹理要看清、要出正式图 |

三者都支持**最多 4 张参考图**，字段固定为 `input_image_0..3`。

切换方式：页面上「生成设置 → 生成模型」，或改环境变量 `FLUX_MODEL`：

```jsonc
// wrangler.jsonc
"vars": {
  "FLUX_MODEL": "@cf/black-forest-labs/flux-2-dev"
}
```

服务端对模型名做白名单校验，乱传会回落到默认模型，不会报错到用户面前。

### 输入图为什么被压到 480px

klein 系列要求每张输入图 **< 512×512**，超限直接报错。
前端用 Canvas 把参考图等比缩放到最长边 480px 再上传，既满足限制，请求体也小、传得快。
`flux-2-dev` 虽然没这个限制，但仍走同一条路径，保证行为一致。

---

## 图库同步

`scripts/sync-catalogs.mjs` 直连上游三个库的真实数据源：

- **服装 / 姿势**：页面内嵌的 `const D=[…]` JSON 数组
- **脸型**：独立的 `data/images.js`，读 `window.GALLERY_IMAGES`

```bash
npm run sync              # 全量同步
npm run sync:offline      # 离线：写入内置样例，不发网络请求
node scripts/sync-catalogs.mjs --only pose   # 只同步一个板块
```

产出 `web/public/data/{outfit,face,pose}.json`，**只含 ID、分类、标签、图片地址，共约 1MB**。

**不同步图片本体**，原因有两个：

1. 上游图片版权归原作者，转载需要授权
2. 4,000+ 张图会把仓库撑到几个 GB，Clone 体验直接崩

素材图在前端通过 `GET /api/proxy?url=…` 由服务端转发，带**域名白名单**，
只允许三个图库域名，不会变成任意 URL 的开放代理。

---

## 上游图库与版权

**本仓库代码采用 MIT 许可。图片、元数据等素材版权归各原作者所有，不适用 MIT 许可。**

### 素材来源

| 板块 | 上游图库 | 原作者 | 本仓库的使用方式 |
|---|---|---|---|
| 服装 | [衣装集 COSTUME-DB-01](https://ai-costume-gallery.pages.dev/) | ギア（[@giaaibusi](https://x.com/giaaibusi)） | 仅同步条目 ID、分类、标签；图片通过上游公开地址引用 |
| 脸型 | [AIモデル顔データベース](https://ai-portrait-gallery.pages.dev/) | あぎ（[@agi_aibusi](https://x.com/agi_aibusi)） | 同上 |
| 姿势 | [ポーズ集 POSE-DB-01](https://ai-pose-gallery.pages.dev/) | ギア（[@giaaibusi](https://x.com/giaaibusi)） | 同上 |

### 使用边界

- 本仓库**不存储、不再分发**上游图片文件，只保存元数据索引
- 商用、二次分发、训练用途请自行确认上游授权；**上游站点的使用条款优先于本项目说明**
- 上游内容含成人向素材，同步脚本已过滤 **1,139 条**（服装 140 条 + 姿势 999 条），
  让站点可以公开展示。过滤规则在 `scripts/sync-catalogs.mjs` 的 `BLOCKED_*` 常量里，可自行调整
- 要完全摆脱第三方依赖：把 `SOURCES` 指向自有图库即可，前端与生成链路无需改动

### 模型服务条款

- **Cloudflare Workers AI**：受 [Cloudflare 服务条款](https://www.cloudflare.com/terms/) 与
  Black Forest Labs 模型许可约束
- **自定义模型**：受对应服务商的条款约束
- 生成结果的使用权以对应平台条款为准，本仓库不对生成内容的合规性作担保

完整说明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

### 关于灵感来源

本项目的需求起点是 [ai-costume-gallery-zh](https://github.com/Deeyu/ai-costume-gallery-zh) 这类
「三板块选图合成」的交互形态。**代码为完全独立重写**：没有复用其源码，
架构（Cloudflare Worker + 静态资源）、prompt 设计、模型调用链路均为自行实现。
交互范式的相似属于常见 UI 模式，不构成代码层面的派生。

---

## 目录结构

```
atelier/
├── shared/                 # 运行时核心（Worker 与本地预览共用）
│   ├── generate.js         #   合成 prompt 模板 + Workers AI 调用 + 输入校验
│   ├── custom-model.js     #   自定义 OpenAI 兼容接口（配置存取 + 调用）
│   ├── router.js           #   API 路由、通道探测、素材图代理
│   └── demo-image.js       #   演示模式拼版图（纯 SVG，无需 Canvas）
├── worker/index.js         # Cloudflare Worker 入口（静态资源 + API）
├── web/public/             # 纯静态前端
│   ├── index.html
│   ├── styles.css
│   ├── app.js              #   交互逻辑
│   ├── i18n.js             #   日文元数据 → 中文
│   ├── data/*.json         #   图库索引（同步产出）
│   └── samples/            #   演示占位图
├── scripts/
│   ├── sync-catalogs.mjs   #   图库同步（支持 --offline / --only）
│   ├── preview-server.mjs  #   本地预览（静态 + API 单端口）
│   └── dry-run.mjs         #   端到端自检（46 项断言，无需密钥）
├── .github/workflows/
│   └── sync-catalogs.yml   #   每日自动同步
├── wrangler.jsonc          # 部署配置
├── THIRD-PARTY-NOTICES.md  # 第三方素材与许可
└── LICENSE                 # MIT
```

### API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/config` | 能力探测：有无 AI、可用通道、模型列表 |
| `GET` | `/api/prompt` | 取当前风格的 prompt 模板 |
| `POST` | `/api/generate` | 合成三图 |
| `GET` | `/api/proxy?url=` | 素材图代理（域名白名单） |
| `GET` | `/api/model` | 自定义模型配置（脱敏） |
| `POST` | `/api/model` | 保存自定义模型配置 |
| `DELETE` | `/api/model` | 清除配置 |
| `POST` | `/api/model/test` | 连通性测试 |

---

## 已知限制

1. **服装纹理细节会掉**：klein 要求输入图 < 512px，细节必然有损。要保真就换 `flux-2-dev`。
2. **身份相似度有限**：脸会「像」，但不会 100% 一致。这是这类模型的通病，
   强一致需求需要专门的 ID 保持方案（如 InstantID、PuLID）。
3. **免费额度约 7 张/天**：产品化必须先做限流。
4. **未实测真实出图**：本仓库没有你的账号凭据，只验证了完整调用链（请求体形状、返回值解析、错误分类）。
   真图需要你 `wrangler deploy` 后自测。

## 验证状态

- `dry-run.mjs`：**46 项断言全绿**，覆盖能力探测、演示生成、素材校验、multipart 字段名、
  未绑定快速失败、假 binding 走通真实调用链、非法模型回落、配额耗尽转 429、
  自定义接口端到端、代理白名单
- 浏览器端完整交互（1080×675 / 1280×800 / 1440×900）：预览 → 确认 → 三板块选齐 → 生成 → 渲染，
  控制台零报错
- 图库同步实测：1,267 + 893 + 440 条，日文残留 0

## 许可

代码 [MIT](LICENSE)。素材与生成内容的授权见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
