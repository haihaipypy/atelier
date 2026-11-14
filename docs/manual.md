# AI角色合成工坊 · 详细说明

README 只保留介绍、演示、部署、使用这些必要内容；参数细节、错误码、额度来源、图库同步、
API、版权与验证状态都收在这里，需要时再查。

- 图文教程：[blog.1day.vip/post/ai-character-atelier](https://blog.1day.vip/post/ai-character-atelier)
- 源码：[github.com/haihaipypy/atelier](https://github.com/haihaipypy/atelier)

**目录**

- [部署细节](#部署细节)
- [功能与素材](#功能与素材)
- [用法与参数](#用法与参数)
- [免费额度与模型](#免费额度与模型)
- [图库同步](#图库同步)
- [上游图库与版权](#上游图库与版权)
- [目录结构与 API](#目录结构与-api)
- [已知限制与验证状态](#已知限制与验证状态)

---

## 部署细节

### 方式一：控制台连仓库

**仓库里代码和配置文件都是现成的，不需要新建文件、不需要装任何环境。** 全在浏览器里完成。

#### 1. 先把仓库放到自己账号下

打开 [github.com/haihaipypy/atelier](https://github.com/haihaipypy/atelier)，点右上角 **Fork**。
（仓库已经在你自己的账号下就跳过这步。）

Cloudflare 只能连你自己账号里的仓库，所以这一步不能省。

#### 2. 连仓库，建 Worker

Dashboard → **Workers & Pages → Create application** → 选 **GitHub**（不要选 Hello World 模板）：

1. 授权 GitHub，从列表里选中 `atelier`
2. **Project name** 填 `atelier-compose`
   —— 必须和仓库里 `wrangler.jsonc` 的 `name` 字段一致，**不一致构建会直接失败**
3. 构建设置（没自动带出来的话手动填）：

   | 字段 | 填什么 |
   |---|---|
   | Build command | 留空 |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | 留空（仓库根目录） |

4. 点 **Save and Deploy**，等 1–2 分钟

`wrangler.jsonc` 就在仓库根目录，Cloudflare 会自己读里面的三项配置：`main`（Worker 入口）、
`assets`（静态资源目录 `web/public`）、`ai`（模型绑定）。**这些都不用你在界面上填。**

部署成功后，Worker 的代码页里能看到 `worker/`、`shared/`、`web/public/` 这些目录——
它们是构建时从仓库拉下来的，不是你粘贴进去的。以后要改，改仓库、提交，再自动部署一次。

#### 3. 构建失败了怎么查

| 报错 | 原因 |
|---|---|
| `Could not find a Wrangler configuration file` | Root directory 填错了，清空即可 |
| `The name in the Wrangler configuration file does not match` | Project name 与 `name` 不一致，改成 `atelier-compose` |
| `Missing entry-point` | 没找到 `main` 指向的 `worker/index.js`，一般是 Root directory 填错或分支没同步 |

顺手说明：如果仓库里**没有** `wrangler.jsonc`，Cloudflare 会自动识别框架并给你开一个 PR 补配置。
本项目已经带好，不会走这条路。

#### 4. KV：不用管，部署时自动建

KV 只服务一个功能：**在页面里保存自定义模型配置**（Base URL / API Key / 模型名）。
它已经写在 `wrangler.jsonc` 里，但**故意只写了绑定名、没写资源 ID**：

```jsonc
"kv_namespaces": [{ "binding": "CONFIG" }]
```

这是 Cloudflare 的**自动资源供给**（automatic provisioning）：部署时发现这个绑定没有指向
任何已存在的 namespace，就自动建一个并绑上去，名字形如 `atelier-compose-CONFIG`。
建好后在 Dashboard → **Storage & databases → Workers KV** 里能看到，**你不用手动创建、也不用复制 ID**。

> **为什么绑定必须写进配置，不能只在控制台点？**
> Cloudflare 把 `wrangler.jsonc` 当作唯一事实来源。每次构建都按它重建绑定，
> 控制台里手动加的绑定会在下次部署时被覆盖（`keep_vars` 只保护变量和密钥，不保护绑定）。
> 好在有了自动资源供给，配置里只写绑定名、不写 ID，所以「不改文件」也能用上 KV。

#### 5. 确认绑定

进 Worker → **Settings → Bindings**，应该看到：

| 绑定名 | 类型 | 作用 | 什么时候有 |
|---|---|---|---|
| `ASSETS` | Static Assets | 托管 `web/public` | 部署后自动 |
| `AI` | Workers AI | 原生出图，无需 API Key | 部署后自动 |
| `CONFIG` | KV Namespace | 自定义模型配置 | 部署后自动（自动建档） |

`AI` 就是模型接入本身：Workers AI **直连绑定**，不经过第三方网关，密钥就是你的账号，
不存在 Key 泄露；消耗账号自带的 Neurons 免费额度，**不用绑卡**，首次调用即生效。
（若首次生成报 *must agree to the Workers AI terms*，去 Dashboard 的 **AI** 页面确认一次条款即可。）

#### 6. 访问与域名

域名形如 `https://atelier-compose.<你的子域>.workers.dev`，直接可用。

- 之后仓库有提交就自动构建部署，日志在 Worker 的 **Deployments → View build history**
- 想绑自有域名：Worker → **Settings → Domains & Routes → Add custom domain**

### 变量和绑定不是一回事

这是最容易混的一点——**KV 是绑定，不是变量，没法用「添加变量」代替**：

| | 写在哪 | 用来干什么 |
|---|---|---|
| **变量 / 密钥**（`vars` / `secret`） | `wrangler.jsonc` 的 `vars`、控制台 Settings → Variables and Secrets、或 `wrangler secret put` | 存字符串配置，如 `FLUX_MODEL`、`CUSTOM_API_KEY` |
| **绑定**（`AI` / `KV` / `R2` / `D1`…） | 只能在 `wrangler.jsonc` 里声明 | 连接到一个 Cloudflare 资源对象本身 |

变量里装不下一个 namespace，所以这两者不能互换。不过你**不需要为此改文件**：

- 想页面里能保存自定义模型配置 → 什么都不用做，KV 自动建好
- 想连 KV 都不用 → 自定义模型改用 Secret 配置（见下），模型本身照常出图

> 唯一需要动配置的情况：想让它指向你**自己已有的** namespace，那才要在 `wrangler.jsonc` 里补
> `"id": "<你的 namespace id>"`。用自动建的就没这个必要。

### 方式二：本地 wrangler CLI

```bash
git clone https://github.com/haihaipypy/atelier.git
cd atelier
npm install
npx wrangler login     # 浏览器授权
npx wrangler deploy    # 静态资源 + 模型绑定 + KV 一起上线
```

`ASSETS`（静态资源）、`AI`（模型）、`CONFIG`（KV）都会在 `deploy` 时按 `wrangler.jsonc` 建好。
KV 那项同样不写 ID，由 Cloudflare 自动建 namespace；CLI 部署会把生成的 ID 写回本地 `wrangler.jsonc`，
提交与否都行（提交了只是把 ID 固化下来）。

> 两种方式**别混用**：Worker 已经连了 Git 再用 CLI 部署，会顶掉控制台那套构建设置。
> 想反过来挂仓库，进 Worker → **Settings → Builds → Connect**，构建设置同方式一第 2 步。

### 可选：不建 KV，用 Secret 配自定义模型

不想建 KV 也能用自定义模型通道，配置改走 Secret：

```bash
npx wrangler secret put CUSTOM_BASE_URL   # 例：https://your-gateway.com/v1
npx wrangler secret put CUSTOM_API_KEY
npx wrangler secret put CUSTOM_MODEL      # 例：gpt-image-1
```

页面弹窗底部会直接说明当前是哪种模式，不会让你白填。

### 本地开发

```bash
npm run sync              # 同步最新图库索引
npm run dryrun            # 自检，不需要任何密钥
npm run dev               # wrangler dev，本地 Cloudflare 环境
```

想用纯 Node 环境（不启动 wrangler）预览静态页 + API：

```bash
node scripts/preview-server.mjs   # 默认 http://localhost:8099
```

本地配置写在 `.dev.vars`（参考 `.dev.vars.example`），该文件已在 `.gitignore` 中。

---

## 功能与素材

### 两个版本：女性 / 男性

顶部一键切换，默认女性版。切换会同时换掉**整套配色**与**三库素材**：

| | 女性版（默认） | 男性版 |
|---|---|---|
| 配色 | 玫瑰粉 `#c05579` + 米白 | 钢蓝 `#3a6ea5` + 冷白 |
| 服装 | 1,542 套 | 254 套 |
| 脸型 | 893 张 | 48 张 |
| 姿势 | 567 个 | 181 个 |

两套配色都各有一份深色模式，切换只改 `html[data-gender]`，结构完全一致。

### 素材库

| 板块 | 女性版 | 男性版 | 说明 |
|---|---|---|---|
| 服装 | 1,542 套 | 254 套 | 女装来自上游图库 + Shisei 的女装与中性装；男装全部来自 Shisei |
| 脸型 | 893 张 | 48 张 | 女性为上游发型库；男性为本站生成并随仓库分发 |
| 姿势 | 567 个 | 181 个 | 男性用 Shisei 的中性人偶线稿，每套取正面与斜侧两个机位 |

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

两个通道在页面上随时切换。自定义模型默认**浏览器直连**，密钥只存本机 `localStorage`；
切回服务端中转时才存 KV，前端只能看到尾号。

### 演示模式

未绑定 AI 时自动进入演示模式：页面功能完整，生成返回一张「三格参考 + 成品区」的 SVG 布局预览图，
并在界面上明确标注**这不是真实生成结果**。用于验收交互链路，不会伪装成成品。

## 用法与参数

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

点「去配置自定义模型 →」，第一项先选**请求发起位置**：

| 发起位置 | 请求从哪发出 | 密钥存哪 | 适合 |
|---|---|---|---|
| **浏览器直连**（默认） | 你这台浏览器，不经过本站 | 浏览器 `localStorage` | 服务商屏蔽了云厂商出口 IP（Cloudflare 首当其冲），中转必 403 时用这个 |
| 服务端中转 | 本站 Worker | 服务端 KV，前端只见尾号 | 对方不支持跨域，或想多设备共用一份配置 |

两者都支持这几个配置项：

| 配置项 | 说明 |
|---|---|
| Base URL | 填到 `/v1` 即可，程序自动拼 `/images/generations` |
| API Key | 按发起位置决定存本机还是服务端 KV |
| 模型名称 | 如 `agnes-image-2.5-flash`、`gpt-image-1`、`flux-pro` |
| 参考图传递方式 | `data URI`（最通用）或公网 URL |
| 额外参数 | 任意 JSON，会合并进请求体 |

填完点「测试连通」发一次极小的文生图请求，验证配置是否正确。
三张参考图通过 `extra_body.image` 以数组传入，`response_format` 固定 `b64_json`，
返回兼容 `data[0].b64_json`、`data[0].url`、`images[0]` 三种结构。

#### 浏览器直连的代价：CORS

直连是**绕过 IP 封禁**最直接的办法，但它的前提是对方接口允许跨域。如果浏览器控制台报
`blocked by CORS policy`、页面上显示「浏览器直连被拦」，说明对方没开
`Access-Control-Allow-Origin`——这是浏览器强制的安全策略，**前端无法绕过**。

此时两条路：

1. 问服务商能否开启 CORS（多数聚合网关支持）；
2. 切回「服务端中转」，同时让服务商放行 Cloudflare 出口 IP。

> 直连模式下密钥只存在你自己的浏览器里，**不会上传到本站服务器**；
> 代价是换设备、换浏览器或清缓存后要重填。适合自己用，不适合分享给别人用你的额度。

### 5. 报错怎么读

自定义模型的失败提示会带上**上游原文**和**实际请求地址**，形如：

```
测试失败：自定义模型返回 403：密钥无权访问该模型，或服务商拦截了来源地区/IP
（上游：Country, region, or territory not supported · unsupported_country_region_territory）
｜请求地址：https://api.example.com/v1/images/generations
```

| 上游状态 | 面板提示的判断 | 常见真实原因 |
|---|---|---|
| 401 | API Key 无效或已过期 | Key 复制错、被撤销、前后带空格 |
| 402 | 账户余额不足 | 没充值 |
| 403 | 密钥无权访问该模型，或服务商拦截了来源地区/IP | 未开通该模型；OpenAI 类服务对**云函数出口 IP** 常直接 403（`unsupported_country_region_territory`），换网关或自建中转 |
| 404 | 接口路径不存在 | Base URL 多了或少了 `/v1`，看提示里的请求地址 |
| 422 / 400 | 上游不接受这组参数 | `size`、`model`、`response_format` 不被支持，用「额外参数」覆盖 |
| 429 | 触发限流或额度用尽 | 免费额度用尽或并发超限 |
| 5xx | 原样透传上游状态 | 服务商故障，稍后重试 |

> 403 是最容易被误判成「代码有问题」的一类：它几乎总是**凭据权限**或**出口 IP 被拦**，
> 而不是本站请求格式错误。原文里出现 `unsupported_country_region_territory`
> 就是后者——请求从 Cloudflare 的节点发出，被对方按地区拒了。

## 免费额度与模型

### 模型从哪来

出图走 **Workers AI 直连绑定**（`@cf/black-forest-labs/flux-2-*`），不经过任何第三方网关：

- 不需要 API Key，凭证就是账号本身，不存在泄露问题
- 消耗账号自带的 Neurons 免费额度，不需要额外开通或绑卡
- 额度用完直接报错，**不会产生账单**

### 免费额度

**每天 10,000 Neurons，账号级共享**（同一账号下所有 Worker、测试、Playground 共用一份）。
未超额时按 00:00 UTC（北京时间 08:00）计新的一天；**一旦超额，封锁要满 24 小时才解除**，见下节。

| 模型 | 每张 1024² 消耗（含三张参考图） | 免费额度约能出 |
|---|---|---|
| `flux-2-klein-9b`（默认） | 1,363.64 + 3×181.82 ≈ **1,490 Neurons** | **约 6 张/天** |
| `flux-2-klein-4b` | 约 **850 Neurons**（按 512² 分块计） | 约 10 张/天 |
| `flux-2-dev` | 按步计费，最高 | 2–3 张/天 |

> 数字来自官方价目表：klein-9b 首张 1024² 收 1,363.64 Neurons，之后每 MP、每张输入图再收 181.82。
> 以前写的「约 7 张」漏算了三张参考图的开销，实际每出一次图约 1,500 Neurons，只够 6 张。

超出额度后请求直接报错，**不会产生费用**。付费价格约 $0.011 / 1000 Neurons。

个人玩、做作品集、给客户看 demo 都够用。

> ⚠️ **对外公开前必须加限流。** 否则第一天额度就会被陌生人打空，站点变成一团 429。
> 建议用 KV 按 IP 计数，或前置 Cloudflare Rate Limiting 规则。

#### 额度已重置、面板显示 0/10k，为什么还是报 4006

这是 Workers AI 的既定行为，不是本站的 bug：

- 超额后的封锁要到**当天首次使用满 24 小时**才解除，而不是 UTC 0 点整；
- 控制台「今日用量」在新的一天从 0 开始记，于是**面板 0/10k 与拦截计数对不上**；
- 额度是**账号级**的，同一账号下别的 Worker、测试脚本、Playground 都吃同一份额度。

社区里反复报告同一现象（面板清零、API 仍返回 4006，持续十几小时），Cloudflare 没有提前解除的开关。

| 原文里出现 | 真实原因 | 怎么办 |
|---|---|---|
| `daily free allocation of 10,000 neurons`（码可能是 4006，官方错误表里写的是 3036） | 额度确实超额，封锁未解除 | 等满 24 小时；或升 Workers Paid；或改用自备 API |
| `Rate limit` / `Too many requests` | 短时间请求太密（免费档约每分钟 300 次），不是额度 | 等 10–30 秒再点 |
| `Capacity temporarily exceeded` / `3040` | 上游暂时没卡位 | 稍后重试 |
| `Memory limit` / `out of memory` | 上游这次分配不到资源 | 换 klein-4b 或稍后重试 |
| `image size` / `dimension` | 参考图超过 512×512 | 前端本会自动缩到 480，换一张图试试 |
| 只有 `Internal server error` / `3043` | 上游瞬时故障，已自动重试一次 | 换模型或画幅再来一次 |

> 早期版本用一条 `/limit|exceed/` 正则就断定「额度用完」，把内存不足、尺寸超限、
> 限流全吞成同一句提示；后来又写死「UTC 0 点重置」，让人误以为等到点就好。
> 现在按「输入问题 → 上游资源 → 配额 → 限流 → 其他」的顺序判定，配额按**上游文案**认
> （不依赖错误码——实测抛 4006，官方文档写的是 3036），并强制附上原文。

**想马上继续出图**，两条路：

1. 页面「配置自定义模型」，填自己的 OpenAI 兼容接口，密钥只存本机浏览器；
2. 升级 Workers Paid：每月 $5 起，每天 10,000 Neurons 照旧免费，超出按 $0.011/1,000 Neurons 计，
   一张 klein-9b 约 $0.016，不会再被硬拦。

注意控制台里看到的 Neurons 用量常是**计费周期累计**，不是当日用量，别拿它对照「今天还能出几张」。

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

### 输入图为什么被压到 480px，还统一转成 JPEG

klein 系列要求每张输入图 **< 512×512**，超限直接报错。
前端用 Canvas 把参考图等比缩放到最长边 480px 再上传，既满足限制，请求体也小、传得快。
`flux-2-dev` 虽然没这个限制，但仍走同一条路径，保证行为一致。

统一输出 JPEG 而不是 PNG，是因为踩过坑：

- Canvas 导出的 PNG 是 **RGBA**（带 alpha 通道），部分推理后端拿到会报 `3043`
- 480px 照片的 PNG 约 400–700KB，**三张加起来 1–2MB**，请求体过大同样会触发 `3043`
- 换成 JPEG（质量 0.9）后，三张合计只有 **60–90KB**，肉眼几乎无损

遇到 `3043` 不用慌：服务端会**自动重试一次**（这类错误多为上游瞬时故障），
仍失败时会提示换模型或画幅，并把错误码与 Ray ID 一并显示出来，方便排查。

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

## 上游图库与版权

**本仓库代码采用 MIT 许可。图片、元数据等素材版权归各原作者所有，不适用 MIT 许可。**

### 素材来源

| 板块 | 上游图库 | 原作者 | 本仓库的使用方式 |
|---|---|---|---|
| 服装 | [衣装集 COSTUME-DB-01](https://ai-costume-gallery.pages.dev/) | ギア（[@giaaibusi](https://x.com/giaaibusi)） | 仅同步条目 ID、分类、标签；图片通过上游公开地址引用 |
| 脸型 | [AIモデル顔データベース](https://ai-portrait-gallery.pages.dev/) | あぎ（[@agi_aibusi](https://x.com/agi_aibusi)） | 同上 |
| 姿势 | [ポーズ集 POSE-DB-01](https://ai-pose-gallery.pages.dev/) | ギア（[@giaaibusi](https://x.com/giaaibusi)） | 同上 |
| 男装 / 中性装 / 男性姿势 | [Shisei 姿勢](https://github.com/wquguru/shisei) | wquguru | 图片为 **CC0 1.0**，可再分发：下载 w300 缩略图进 `web/public/library/`，大图走 jsDelivr |
| 女性姿势补充 | 同上（Shisei `std` 系列） | wquguru | 全身女性素体，127 条并入女性姿势库 |
| 男性脸型 | 本站自建 | 本项目 | 用图像模型生成后人工挑选，随仓库分发，不对应任何真实人物 |

### 男性版的姿势为什么借女性素体

Shisei 目前**没有男性姿势**：`std` 系列是女性全身素体（线稿上画了胸部曲线），`upper` 系列只画到腰胯。
所以男性版的姿势库是「借用库」——骨架可用，轮廓不可用。

这里踩过一个坑：早期只写「照搬图 3 的姿势」，模型遇到「女性素体轮廓 + 成年男性」这对矛盾时，
最常见的处理不是融合，而是**直接丢掉姿势、输出一张正面站姿**，表现就是「选了姿势不生效」。

现在按三层处理：

1. 提示词里先声明「图 3 是女性人台线稿」，再要求**只取骨架与机位**（肢体位置、关节角度、
   重心、头部朝向、取景范围），明确「轮廓不要照搬」「不许替换成站姿」；
2. 把所选姿势的动作要点写成文字一起送进去（`poseHint`，来自图库条目的 `pose.zh`），
   图给画面、字给语义，两者互补；措辞限定为「用来确认图 3，不得覆盖服装与脸」；
3. 页面上直接说明这是借用库，避免用户以为选错了。

这条经验同样适用于任何「参考图性别 ≠ 目标性别」的合成场景。

### 使用边界

- **上游三家（服装/脸型/姿势）**：不存储、不再分发图片，只保存元数据索引
- **Shisei 的男装与中性姿势**：图片是 CC0 1.0，允许再分发，因此缩略图随仓库分发（710 张 / 4.3 MB），
  大图仍走 jsDelivr。姿势的**编号与名称**沿用 ai-pose-gallery 的公开目录，Shisei 未获授权、只注明出处，
  本项目同样只引用名称，不引用对方图片
- **男性脸型**：本站生成，版权归本项目，按 CC0 1.0 随仓库分发
- **为什么不抓 generated.photos**：其条款明确禁止 parse / stockpile 素材、禁止以可下载形式分发、
  禁止用于机器学习或数据集，免费额度仅限 500×500 的个人非商用用途 —— 做图库并再分发属于明确禁止项
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

## 目录结构与 API

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
│   ├── favicon.svg         #   站点图标（人形：头/躯干/双臂三色 = 三个素材库）
│   ├── apple-touch-icon.png
│   ├── data/*.json         #   图库索引（同步产出）：女性 = outfit/face/pose，男性 = *-male
│   ├── library/            #   随仓库分发的素材：Shisei 缩略图 + 本站男性脸型（CC0）
│   └── samples/            #   演示占位图
├── scripts/
│   ├── sync-catalogs.mjs   #   图库同步（支持 --offline / --only）
│   ├── preview-server.mjs  #   本地预览（静态 + API 单端口）
│   └── dry-run.mjs         #   端到端自检（119 项断言，无需密钥）
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

## 已知限制与验证状态

1. **服装纹理细节会掉**：klein 要求输入图 < 512px，细节必然有损。要保真就换 `flux-2-dev`。
2. **身份相似度有限**：脸会「像」，但不会 100% 一致。这是这类模型的通病，
   强一致需求需要专门的 ID 保持方案（如 InstantID、PuLID）。
3. **免费额度约 6 张/天**：产品化必须先做限流。
4. **未实测真实出图**：本仓库没有你的账号凭据，只验证了完整调用链（请求体形状、返回值解析、错误分类）。
   真图需要你 `wrangler deploy` 后自测。

### 验证状态

- `dry-run.mjs`：**131 项断言全绿**，覆盖能力探测、演示生成、素材校验、multipart 字段名、3043 重试、
  未绑定快速失败、假 binding 走通真实调用链、非法模型回落、配额耗尽转 429、
  非配额报错不被误判为额度用完（内存/尺寸/限流分类回归）、
  额度错误码 4006/3036 均能识别、男性姿势只取骨架不取轮廓、
  自定义接口端到端、403/429/422 错误分类、浏览器直连通道、双版本素材完整性、代理白名单、文档拆分、README 配图存在性、顶栏窄屏折行
- 浏览器端完整交互（1080×675 / 1280×800 / 1440×900）：预览 → 确认 → 三板块选齐 → 生成 → 渲染，
  控制台零报错
- 图库同步实测：1,542 + 893 + 567 条，日文残留 0
