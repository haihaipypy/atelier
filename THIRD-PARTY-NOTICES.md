# 第三方素材与许可说明

本仓库代码采用 MIT 许可，版权归 **无辣**（[www.1day.vip](https://www.1day.vip)）所有。
**图片、元数据等素材版权归各原作者所有，不适用 MIT 许可。**

## 图库来源

| 板块 | 上游图库 | 原作者 | 本仓库的使用方式 |
|---|---|---|---|
| 服装 | [衣装集 COSTUME-DB-01](https://ai-costume-gallery.pages.dev/) | ギア（[@giaaibusi](https://x.com/giaaibusi)） | 仅同步条目 ID、分类、标签；图片通过上游公开地址引用 |
| 脸型 | [AIモデル顔データベース](https://ai-portrait-gallery.pages.dev/) | あぎ（[@agi_aibusi](https://x.com/agi_aibusi)） | 同上 |
| 姿势 | [ポーズ集 POSE-DB-01](https://ai-pose-gallery.pages.dev/) | ギア（[@giaaibusi](https://x.com/giaaibusi)） | 同上 |
| 男装 / 中性装 / 男性姿势 | [Shisei 姿勢](https://github.com/wquguru/shisei) v0.4.1 | wquguru | 图片 **CC0 1.0**，允许再分发；w300 缩略图随仓库分发，w900 大图走 jsDelivr |
| 男性脸型（48 张） | 本站自建 | 本项目 | 图像模型生成后人工挑选，以 CC0 1.0 随仓库分发，不对应任何真实人物 |

### Shisei 授权细节

- **图片**（`images/`、Release zip）：CC0 1.0，放弃著作权，商用、修改、再分发均免费且不要求署名。
  本项目仍在此署名。文件：`LICENSE-images`。
- **代码与文档**：Apache License 2.0。本项目只参考其目录结构，未复用其代码。
- **姿势目录**（选题、编号、名称、分类）：沿用 ai-pose-gallery 的公开目录，Shisei 未获授权、仅注明出处。
  本项目同样只引用名称与编号，**不引用对方的图片**，与既有姿势库（POSE-DB-01）的处理方式一致。
- 收录范围：仅 `rating=general`，排除 `suggestive` 系列（sexy / duo）与内衣类（`cat=LG`），
  与本站「可公开展示」的定位一致。
- 版本锁定：目录与图片统一取自 tag `v0.4.1`，`scripts/sync-shisei.mjs` 顶部 `TAG` 常量可改。

### 未采用的来源：generated.photos

其 [Terms and Conditions](https://static.generated.photos/terms-and-conditions) 明确禁止：
「parse Materials, or stockpile Materials beyond a reasonable amount」「distribute, export, post,
or upload Materials online in a downloadable format」「machine learning purposes / compiling datasets」。
免费额度仅限 500×500 的个人非商用用途且需逐图署名。
**把其人像抓取成图库并再分发属于明确禁止项，因此未采用**；男性脸型改为本站自建生成。

## 使用边界

- **上游三家（服装/脸型/姿势）**：不存储、不再分发图片，`scripts/sync-catalogs.mjs` 只产出元数据索引（`web/public/data/*.json`）。
- **Shisei**：CC0 允许再分发，`web/public/library/` 下的 710 张缩略图（约 4.3 MB）随仓库发布，来源与版本见上表。
- **男性脸型**：本站生成，`web/public/library/face/` 下 48 张（约 1 MB），版权归本项目。
- 商用、二次分发、训练用途请自行确认上游授权；上游站点的使用条款优先于本文件。
- 若要完全移除第三方依赖，把 `SOURCES` 指向自有图库即可，前端与生成链路无需改动。
- `web/public/samples/` 中的示例图仅用于演示占位，随仓库以 MIT 发布，可自由替换。

## 模型服务条款

- Cloudflare Workers AI：受 [Cloudflare 服务条款](https://www.cloudflare.com/terms/) 与 Black Forest Labs 模型许可约束。
- 自定义模型（OpenAI 兼容接口）：受对应服务商的条款约束，与本仓库无关。
- 生成结果的使用权以对应平台条款为准；本仓库不对生成内容的合规性作担保。
