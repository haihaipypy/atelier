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

### 6. 「image 必须包含图片值」怎么读

这句报错很容易被误认为「图没传上去」，其实多半是**传了、但上游读不懂这个结构**。为了不再靠猜，
生成失败时提示末尾会附一行**本次实际送出的参考图摘要**：

```
自定义模型返回 400：上游不接受这组参数（size / model / response_format 可能不支持）
（上游：extra_body.image 必须包含图片值 · invalid_request）｜本次送出 参考图 3 张（jpeg×3），约 84KB
```

按摘要分两种情况：

| 摘要 | 含义 | 下一步 |
|---|---|---|
| `参考图 0 张` / `参考图 2 张` | 图真的没带上 | 回到左侧把服装 / 脸 / 姿势都选齐再生成 |
| `参考图 3 张（jpeg×3），约 xxKB` | 图带了，是上游不认这种送法或格式 | 问题在字段名或图片格式，不在选图 |

本站的送法是 `extra_body.image: [data URI, data URI, data URI]`（与 Agnes 等聚合网关一致）。
摘要里出现 `unknown` 或体积接近 0，说明某张图在浏览器里就已经坏了，重选一张即可。

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

1. **姿势段和女性版同构**，只有一句话：`Reference image 3 defines the POSE AND CAMERA ANGLE
   ONLY: …`，男性版在后面补三个肢体例子（举起的胳膊仍然举着、肘角保持原样、手在头边就留在头边）；
2. **「换身体」挪到性别声明里**，不再挤在姿势段：`Reference image 3 is drawn on a female artist
   mannequin: give its skeleton a male body and ignore only the mannequin's bust and hip curve`；
3. 页面上说明这是借用库，避免用户以为选错了。

顺序很关键。之前「换身体」的说明占了姿势段的大半，等模型读到「照搬骨架」时，那句话的
分量已经被摊薄了。现在姿势段和女性版几乎一样长，模型对待它的方式和对待女性版一致。

#### 文字比线稿更有说服力

这是三轮返工里最反直觉的一条：**同一张图给文字描述和线稿，模型听文字的。**

男性库的文字来自上游 Shisei 的姿态描述，和线稿并**不是**严格一一对应。实测到的例子：

| 条目 | 线稿画的 | 上游文字写的 | 成品 |
|---|---|---|---|
| `SP-P021` | 单臂高举过头、手掌张开 | 一手扶颈侧、一手贴大腿 | 手摸脖子 + 手贴大腿 |

用户看的是举手的线稿，拿到的是摸脖子的成品，只能说「姿势还是不对」。

所以男性版**不再把要点写进提示词**（`poseHint` 对 `gender: 'male'` 直接丢弃），姿势只认图 3。
女性版继续注入，但注入的是 `pose.en`——见下一节。要点仍保留在页面上（卡片标题、悬停提示），
那是给人看的。

已发现的错位条目按图修正，并写进 `scripts/sync-shisei.mjs` 的 `POSE_TEXT_FIX`，
重新同步也不会被覆盖。这类修正只在「对着原图看过」的条目上做，不做批量猜测——
改错文字比不改更糟。

#### 女性版一直在发中文

女性库的 `pose.zh` 只存 60 个字符，中英混排时英文会截在半句：

```
站立｜站立・双手扶颈后；standing with both hands raised behind the figur
```

清洗掉半句英文后只剩中文小标题「站立・双手扶颈后」，被拼进一句英文提示词里。
**提示词是英文的，模型读不懂中文**——这一段等于没写，姿势全凭图 3；
图 3 一旦不够清楚，模型就滑回它最爱的正面站直、双手贴身
（图 3 双手在脑后 → 成品双手垂在身侧，就是这个现象）。

同一库的 `pose.en` 是完整一句，而且和 `zh` 同源（`zh` 就是 `en` 的截断版）：

```
standing with both hands raised behind her head, resting on the nape of her neck, elbows out
```

所以前端两个库统一优先取 `pose.en`（`poseHintFor()`），取不到才退回 `pose.zh`。
127 条 std 条目受益；440 条「可爱系」没有 `en`，行为不变。抽检 127 条的英文要点与
标题动作，只有一处措辞差异（`toward the front-left` 对「双腿前伸」），语义一致。

配套两处改写在 `shared/generate.js`：

| 位置 | 改前 | 改后 |
|---|---|---|
| 要点措辞 | `use it to confirm image 3` | `matching image 3 exactly` |
| 站姿反例 | 只说「别垂手」 | 补一句「图3 把手放哪儿就留在哪儿」 |

`confirm`（核对）等于告诉模型这段可以不信，改成陈述「这是同一姿势的另一种说法」。
反例之后还必须给正例：只写「别把手贴在身侧」时，模型会改挑手插兜、手扶胯，
仍然不是图 3 的动作。

#### 同一句「忽略」说四遍的代价

再上一版男性段落里，「忽略这张人台」被说了四遍：`ignore that mannequin`、`do NOT carry any
feminine body shape`、`never its bust or waist-hip contour`、`Do not replace the pose with a
standing or walking pose`——而「照搬」只有一句。

指示词的总量有限，四比一的配比下，模型最省事的做法是**整张图都不用**，直接给一张正面站姿。
表现就是：图 3 明明单手高举过头，成品却是双手垂在身侧。

于是改成全部正向描述 + 一处例外：「举起的胳膊仍然举着」比「不要放下胳膊」更难被曲解。
最后那句否定句里还带着 `standing` / `walking` 两个词，等于把站姿当候选动作递到模型面前——
这句直接删掉了。

这条经验同样适用于任何「参考图性别 ≠ 目标性别」的合成场景。

### 为什么成品总爱变成正面站直

这是一个和性别无关的独立问题，男性版、女性版都会遇到。典型表现：图 3 明明是双腿分开、
重心偏一侧、一条手臂略弯垂在身前的线稿，成品却变成并腿站直、双手贴身的正面照。

根源在于**模型对「标准陈列站姿」有很强的默认偏好**，有三种情况会把它勾出来：

| 诱因 | 为什么会勾出站姿 | 现在的处理 |
|---|---|---|
| 风格句写死 `full-body shot` | 要「全身」，就得找一个能装下整套衣服的姿势，最省事的是站直 | 景别交给图 3，风格句只描述质感与光线 |
| 服装图里的人是正面站直 | `do not copy its standing front view` 这句本身就在提「站姿」，等于给了一个候选动作 | 改成「图 1 的姿态完全无效，不要从它取任何肢体位置或机位」 |
| 姿态要点用「确认」口吻 | 「用来确认图 3」读起来像参考意见，模型宁可信文字 | 改成命令句，并点名四个具体反例 |

那条点名反例的句子是这样的：

```
The stance must follow image 3, not a default catalogue pose. Do not straighten the legs,
do not close the gap between the feet, do not square the hips and shoulders to the camera,
and do not drop the arms flat against the sides, unless image 3 itself shows exactly that.
```

> 反例比正例管用。只说「照图 3 摆姿势」是给方向，说「别并腿、别收肩跨、别把手贴死」
> 是堵住模型最可能走的那条捷径。若某个具体姿势仍不稳定，把它写到「补充描述」里最有效——
> 那段文字在提示词最末尾，权重最高。

### 上半身姿势为什么单独一套取景

女性库里的「可爱系 · 上半身·单人」有 125 条（男性库 54 条），线稿**只画到胸下缘**，
通常还带明确的手势：胸前比心、头上双臂心形、颊横比心、下巴下双剪刀手……

如果按全身出图，就会撞上一组无法同时满足的约束：

- 图 3 只给了上半身，没有腿；
- 图 1 却是一整套服装（长裙、连体衣）；
- 提示词要求「把服装完整展示出来」。

模型要满足最后一条，就必须自己编一个下半身，而编的过程中最省事的做法是让手臂自然垂下——
**手势在这一步被丢掉**。典型症状：选了「胸前双手心形」，成品是双手垂在身侧，
还额外补了腿和鞋，人物缩在画面里。

现在这类姿势走独立分支：

| 维度 | 全身姿势 | 上半身姿势 |
|---|---|---|
| 取景 | 跟随图 3，不写景别 | 裁到大腿中部，人物占满画面 |
| 下半身 | 照图 3 | 明确禁止凭空补腿、脚、鞋 |
| 手势 | 照图 3 | 逐条点名：必须可辨认，不许把手放下或藏到身后 |
| 画幅 | 默认 3:4 竖版 | 选姿势时自动切 1:1 方图 |
| 站姿反例 | 有（别并腿、别贴手臂） | 无（半身看不到腿，说了反而会逼模型画腿） |

> 画幅只做**默认**切换：只要你手动改过画幅，之后就不再替你动。

两个库的 upper 线稿**裁切高度不一样**，所以取景措辞也不能共用一句：

| 库 | 线稿画到 | 提示词怎么写 |
|---|---|---|
| 女性库 | 胸下缘 | 「裁到大腿中部，和图 3 的裁切完全一致」 |
| 男性库 | 胯（大腿根） | 「比图 3 略松一点，裁到大腿中部」+「图 3 出现的手、前臂、腰、胯都留在画面内」 |

共用一句的代价很具体：女性库说「和图 3 一样」= 到胸口，男性库照说就变成「到胯」，
而下一句又写着 `cropped at mid-thigh`，前后矛盾，模型只能自己挑一个。

男性版多出的那半句「没有手被切在画面边缘」是补另一个常见问题：上半身姿势里常有一只手
垂在身侧，按胸口取景正好把它切掉，模型索性把这只手也省了。

### 腿上的服装为什么会被丢掉

坐姿、蹲姿、躺姿这类姿势有个共同的坑：姿势完全正确、裙子上半身也对，
唯独**腿是光的**——图 1 里的黑丝袜、长袜、短靴集体消失。

这是两条约束打起来的结果，而且两条单独看都对：

1. 姿势线稿（图 3）画的是**裸体素体**，腿本来就是光的；
2. 为了防「服装图里的站姿污染姿势」，提示词写了一句「图 1 的姿态一律不要，连腿的位置也不要」。

第二句本意是只否掉姿态，但模型把它理解成**整条腿都不要参考图 1**——连腿上的衣服一起否掉。
于是它照抄图 3 的裸腿，丝袜和靴子就没了。

现在的写法是把腿脚单独拎出来，并且只限定腿脚：

```
Image 3 is an unclothed mannequin: its bare legs are not a styling choice. Seated or standing,
dress them from image 1 — trousers, jeans, wide-leg pants, skirt, shorts, tights, stockings,
socks, boots, shoes — same type, same length: a full-length trouser stays full length, two
separate legs, never shorts or a skirt. Legs keep the stance of image 3, feet as far apart as
drawn. No legwear in image 1 means bare legs; no footwear means plain flat shoes.
```

最后一句很重要：图 1 本来就是光腿时（短裙配凉鞋、泳装），不能凭空加上丝袜。

> 这条约束**故意不写成「全身都按图 1 覆盖」**。那样写，露肩、露背、单肩这类剪裁会被模型
> 好心补上布料——修好腿的同时毁掉领口。所以覆盖范围只提到腿脚，上身交给图 1 的原始剪裁。

#### 长裤为什么会变成短裙

上面那版修好「腿光着」之后，紧接着出了第二种错：腿上有衣服了，**但类型不对**。

| 图 1 | 成品 |
|---|---|
| 黑色蕾丝吊带 + 棕色阔腿长裤（挂拍，裤脚遮住脚） | 同一件吊带 + 棕色**百褶短裙** + 露腿 + 银色高跟 |

上半身一模一样，说明服装约束是生效的；错的是下半身。原因还是那张清单：

```
— tights, stockings, socks, boots, shoes —     ← 全在脚上，没有一件是裤子
```

模型按字面理解成「腿上只有袜子和鞋」，于是拿上衣的棕色配了一条短裙，顺手把腿画成细长
交叉、脚尖点地的杂志站姿，再补一双图 1 里根本不存在的高跟鞋（裤脚遮住了脚，它自己编的）。

三处补救，都在同一句里：

1. **清单里加进下装**：`trousers, jeans, wide-leg pants, skirt, shorts`。
2. **锁定类型与长度**：`same type, same length: a full-length trouser stays full length, … never shorts or a skirt`。
   加「两条裤腿分开」（`two separate legs`）是为了把裤子和裙摆在语义上隔开——只说 `wide-leg` 时，
   模型很容易理解成宽摆的裙子，这也是「阔腿裤 → 百褶裙」最直接的原因。
3. **没看到鞋就穿平底**：`no footwear means plain flat shoes`。高跟鞋会让腿绷直、踮脚，
   腿的姿态跟着一起跑偏；而图 1 是挂拍，脚常常被裤脚挡住。

另外补了一句 `Legs keep the stance of image 3, feet as far apart as drawn`：只说「别并腿」太抽象，
给一个可执行的量——**两脚的距离按线稿画的那样**。

男性版这一段换一份清单（`trousers, jeans, chinos, shorts, socks, boots, shoes`），原因是原句的字面歧义：
男性套装是长裤，而原清单里只有「丝袜、长袜、袜子」，还跟着一句「图 1 没有腿袜就光腿」。
按字面理解，长裤不算 legwear，于是坐姿/躺姿真的会出一条光腿。

#### 别把「不想要」的动作写进否定句

`v2026.11.18.5` 把姿势约束移到末尾之后，**腿分开了**（原来并拢），手却还是垂在身侧。
同一段提示词里一半生效一半没生效，说明不是权重问题，是那半句自己写反了。

原来的站姿兜底结尾是：

```
… and the arms not hanging flat against the sides when image 3 puts them somewhere else.
```

CLIP/T5 对否定词的权重极低，它读进去的是后半截那个**具体画面**：
`arms hanging flat against the sides`。于是手真的垂在身侧。这在男性版很早就踩过一次——
「不要替换成站姿」写进否定句，成品就出站姿——当时修好了，回滚时又带了回来。

现在这一句**整个删掉**，只留可执行的正面量：

```
The stance must follow image 3, not a default catalogue pose: legs as wide as drawn,
feet where drawn, hips and shoulders not squared to the camera.
```

规则：想让手去哪儿，就在末尾正面说「She is … both hands on her hips」；
不要写「别把手放下」。想否定的东西，用「别摆成目录照」这种**不含具体动作名**的说法。

顺带把要点句从元描述改成画面描述：

```
（旧）Exact pose, matching image 3: standing in a wide stance with legs apart, both hands on her hips.
（新）She is standing in a wide stance with legs apart, both hands on her hips.
```

前者在**谈论一张图**，模型当备注；后者在**描述要画的东西**，是图像模型熟悉的句式。
女性库 127 条英文要点全部能接在 `She is` 之后（121 条 `-ing` 开头，6 条 `in a …` 开头）；
中文小标题和半身库里的名词短语（如 `peace sign at the cheek`）接不上，仍走标签式。

#### 「好像和刚才一样」先查提示词

结果区现在多了一个可展开的「本次实际提示词」，里面是服务端**这次请求实际送出**的全文。
版本 tag 只能证明代码上线，证明不了这次请求真的用了新文案（缓存、旧实例、
自定义 Prompt 框里残留了内容，都会让改动看起来没生效）。

排查顺序：右下角 tag → 展开提示词看末尾那句姿势描述 → 再判断是不是模型能力问题。

#### 姿势为什么非要在最后一句

回滚到 1380 字符之后，服装回来了，姿势又不行了：线稿双手叉腰、双腿分开，成品双手垂在
身侧、双腿并拢。要点文本明明写着 `hands on her hips, elbows out`——字是对的，位置不对。

同一句话放在不同位置，效果差一个量级：

| 位置 | 写法 | 结果 |
|---|---|---|
| 中段（紧接「图3 只给姿势」） | `The pose is also given in words, matching image 3 exactly: …` | 被当背景描述，手照样放下 |
| 末尾（风格段之后） | `Exact pose, matching image 3: …` | 目前最好的一版 |

两个变化同时起作用，而且都**不增加长度**：

1. **挪位置。** 提示词末尾是权重最高的位置。这句话原来排在服装说明（四句、300 字符）
   后面，模型读完那一大段之后已经进入「商品图」模式，再读到这句只会当成备注。
2. **改口吻。** `also given in words` 明确把它降级成「补充信息」，`matching image 3
   exactly` 又像是在说「这是一句待核对的描述」。改成标签式（`Exact pose, matching
   image 3: X`）才是约束的口吻。

站姿反例（`The stance must follow image 3…`）也一起挪到了末尾，紧挨在要点之前。
理由：这两句说的是一件事的两面（反面「别并腿、别贴身」+ 正面「双手叉腰」），
分开摆时模型各听一半；连读才收得住。

另外把反例结尾的逃生口收窄了：

```
（旧）… and arms not hanging flat against the sides unless image 3 shows exactly that.
（新）… and the arms not hanging flat against the sides when image 3 puts them somewhere else.
```

旧的写法是给模型留了「我觉得图 3 就是这样」的借口，而它恰恰最擅长这么想。

#### 为什么最后只剩一句话

这一节的标题是整份文档里最沉的一条教训。

2026-11 连着修了七轮姿势，前四轮都在**加句子**：补肢体例子、补手数、补头部朝向、
补「手放哪儿就留在哪儿」。每一句单独看都对，每一句都有具体案子支撑。加着加着，
成品反而从「姿势不太准」变成「两只手都抬到颈边、还给她换了条牛仔裤」。

原因不复杂：**T5 的有效窗口只有 512 token，而提示词是有预算的**。

| 版本 | 女性全身提示词 | 指令句数 | 结果 |
|---|---|---|---|
| 58fff40 | 1355 字符 | 12 | 姿势大致对，偶发站直 |
| f524c5b | 2170 | 15 | 姿势对，腿光 / 长裤变短裙 |
| 02a62a6 | 2195 | 18 | 手多、头正、短裙变牛仔裤 |

每加一句，都是在同一份预算里挤掉别人。最先被挤掉的是**服装**——因为服装是最早写的、
离末尾最远的。于是出现「修姿势把衣服修坏了」这种看起来毫无因果的故障。

所以现在的规则写死在这里：

1. **姿势段只有一句话。** 不复述、不举例、不列肢体。短句被当硬约束，长段被当背景描述。
2. **服装段只说「照抄图1」。** 不枚举清单（清单会变成选项菜单：写了 trousers / jeans
   在前，模型就从第一项挑，把短裙换成牛仔裤），也不再补「图1 的姿态一律不要」——
   说完「图1 只给衣服」再说「它的姿态不要」是自我抵消。
3. **站姿兜底只放反例。** 全身取景一段，半身取景没有（半身的取景段已经在管这件事）。
4. **细则进 extra，不进正文。** 头部角度、某只手的位置、要不要戴帽子这类「这一张才有」的
   要求，写在「补充描述」里——那是末尾，权重最高，而且是用户自己写的，原本就该说了算。

#### 第二只手为什么总会跑出来


线稿是「一手扶着颈侧、另一只手垂在体侧」，成品却是两只手都抬到颈边。姿势整体对了，
偏偏多了一只手。

这不是「听错」，是「补齐」。图 3 是女性素体线稿，被躯干挡住的那只手常常只露出一小截，
模型不去判断「它其实是垂下来的」，而是把两只手理解成「都在这儿」。而提示词里
「手的位置照搬图 3」这句话，对「一只手在画面里、另一只在画面外」这种情况没有约束力。

试过在正文里加一句手数约束（`Count the arms in image 3…`），姿势是对的，但整体崩了——
见上一节。**这条现在不写在正文里**：遇到某张图的手数不对，直接在「补充描述」里写
「右手扶在颈侧，左手自然垂在身体左侧」，比往正文里加一句更有效，也不会伤到别处。

#### 补充描述为什么排在最前面（不，是最后面）

提示词末尾的 `补充描述` 是全文权重最高的位置，也是**唯一一处用户亲眼看过成品之后**
写下的纠正。它原样放在最后，不追加任何东西。

试过在它后面自动补一句姿势要点（`Pose details, straight from the reference: …`），
结果是用户写的话被挤成半句，两个信息都没进去。所以：用户的话就是最后一句。

#### 头为什么总是摆回正面

现象：姿势整体对了——双脚的方向、手落的位置、身体的重心都对，唯独**头**是证件照式的正面，
线稿里那个明显的转头/低头不见了。用户会说「动作差不多，但原姿势头部动作和侧转都没有」。

原因是三张图里有一组天然冲突：

| 图 | 头是什么样 |
|---|---|
| 图 2（脸） | 正面、平视、看镜头 |
| 图 3（姿势线稿） | 空白蛋形，**没有五官可以对齐** |

模型要同时满足「脸必须是图 2 这个人」和「姿势照玩图 3」。脸那张是正对镜头的，
蛋形头又没给任何五官信息，最省事的解法就是把**整个人转到正面**——脸对上了，
身体和头的侧转一起消失。

所以提示词里必须把「头」从「脸」里拆出来单独说：

```
Its blank head still shows where the face points: tilt and turn the head that way, keep any
downward or sideways gaze, and do not square the body to the camera to face the viewer front-on.
```

三点讲究：

1. **先说清空白头还有用**（`still shows where the face points`）。不解释，模型就把它当无信息的球体。
2. **给可执行的量**（`tilt and turn`、`downward or sideways gaze`），而不是「保持头部姿势」这种抽象话。
3. **给一个反面**（`do not square the body to the camera`）。只要求转头时，模型会**同时**把身体摆正，
   头和身体各转一半，看起来仍然不对。

这句话放在提示词最后一段（站姿反例那一段）。理由和前面几条一样：它和「别把胯肩摆正对镜头」
说的是同一件事，放同一段才收得住；分成两处说，模型各听一半。

#### 男性坐姿为什么要单独提「地面」

男性库的 181 条姿势里，坐姿 26、侧坐 15、跪姿 16、蹲姿 12、躺姿 13——**全是地面姿势**，
线稿里没有椅子。模型对「坐下」的默认联想偏偏是椅子，很容易给人补一张凳子，
或者干脆把人扶起来站着。所以男性全身分支多一句：

```
If image 3 is seated, kneeling, crouching or lying down, he stays on the floor in exactly that
position — do not lift him onto a chair or a stool, and do not stand him up.
```

半身像不带这句：裁到大腿中部，椅子本来就看不见，字数留给取景说明更值。

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
│   └── dry-run.mjs         #   端到端自检（250+ 项断言，无需密钥）
├── .github/workflows/
│   └── sync-catalogs.yml   #   每日自动同步
├── wrangler.jsonc          # 部署配置
├── THIRD-PARTY-NOTICES.md  # 第三方素材与许可
└── LICENSE                 # MIT
```

### 版本号怎么看

页面右下角有一行小字：`v2026.11.18.1`。它的唯一用途是回答一个问题——
**我刚推的那版，到底跑起来了没有？**

因为它写在代码里（`shared/version.js`），不在缓存里、也不来自任何外部服务：

| 现象 | 含义 |
|---|---|
| 刷新后 tag 变了 | 新版本已上线 |
| 刷新后 tag 没变，悬停里的「服务端时间」在变 | 请求到了旧实例，或部署还在进行 |
| tag 和「服务端时间」都不动 | 中间有缓存（接口本身是 `no-store`） |
| 角落里什么都没有 | `/api/version` 挂了，或前端 JS 没加载 |

悬停能看到三样东西：这一版改了什么（`note`）、服务端当前时间、Cloudflare 机房代码
（部署在 Cloudflare 且有绑定 `CF_VERSION_METADATA` 时才会出现部署 id）。

为什么是手写 tag 而不是 git hash：这个仓库没有构建步骤，Cloudflare 直接读仓库部署，
Worker 运行时拿不到 commit 号（要拿得开 version metadata 绑定，本地就失效了）。
手写一个 `YYYY.MM.DD.N` 反而最可靠，代价是**发布前要记得改**。

发布流程：

```bash
# 1. 改 shared/version.js 的 tag 和 note
# 2. 自检
npm run dryrun          # 250+ 项，全绿再推
# 3. 推上去，等 Cloudflare 构建完成，刷新页面看右下角
git push
```

### API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/config` | 能力探测：有无 AI、可用通道、模型列表 |
| `GET` | `/api/version` | 构建标记（页面右下角那行小字） |
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

- `dry-run.mjs`：**132 项断言全绿**，覆盖能力探测、演示生成、素材校验、multipart 字段名、3043 重试、
  未绑定快速失败、假 binding 走通真实调用链、非法模型回落、配额耗尽转 429、
  非配额报错不被误判为额度用完（内存/尺寸/限流分类回归）、
  额度错误码 4006/3036 均能识别、男性姿势只取骨架不取轮廓、
  自定义接口端到端、403/429/422 错误分类、浏览器直连通道、双版本素材完整性、代理白名单、文档拆分、README 配图存在性、顶栏窄屏折行
- 浏览器端完整交互（1080×675 / 1280×800 / 1440×900）：预览 → 确认 → 三板块选齐 → 生成 → 渲染，
  控制台零报错
- 图库同步实测：1,542 + 893 + 567 条，日文残留 0
