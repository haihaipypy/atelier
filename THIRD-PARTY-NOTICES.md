# 第三方素材与许可说明

本仓库代码采用 MIT 许可，版权归 **无辣**（[www.1day.vip](https://www.1day.vip)）所有。
**图片、元数据等素材版权归各原作者所有，不适用 MIT 许可。**

## 图库来源

| 板块 | 上游图库 | 原作者 | 本仓库的使用方式 |
|---|---|---|---|
| 服装 | [衣装集 COSTUME-DB-01](https://ai-costume-gallery.pages.dev/) | ギア（[@giaaibusi](https://x.com/giaaibusi)） | 仅同步条目 ID、分类、标签；图片通过上游公开地址引用 |
| 脸型 | [AIモデル顔データベース](https://ai-portrait-gallery.pages.dev/) | あぎ（[@agi_aibusi](https://x.com/agi_aibusi)） | 同上 |
| 姿势 | [ポーズ集 POSE-DB-01](https://ai-pose-gallery.pages.dev/) | ギア（[@giaaibusi](https://x.com/giaaibusi)） | 同上 |

## 使用边界

- 本仓库**不存储、不再分发**上游图片文件，`scripts/sync-catalogs.mjs` 只产出元数据索引（`web/public/data/*.json`）。
- 商用、二次分发、训练用途请自行确认上游授权；上游站点的使用条款优先于本文件。
- 若要完全移除第三方依赖，把 `SOURCES` 指向自有图库即可，前端与生成链路无需改动。
- `web/public/samples/` 中的示例图仅用于演示占位，随仓库以 MIT 发布，可自由替换。

## 模型服务条款

- Cloudflare Workers AI：受 [Cloudflare 服务条款](https://www.cloudflare.com/terms/) 与 Black Forest Labs 模型许可约束。
- 自定义模型（OpenAI 兼容接口）：受对应服务商的条款约束，与本仓库无关。
- 生成结果的使用权以对应平台条款为准；本仓库不对生成内容的合规性作担保。
