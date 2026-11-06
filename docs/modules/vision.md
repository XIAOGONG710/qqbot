# 模块：看（视觉）

> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她怎么看图：照片货架、食物照片、图片安全检查、媒体（雪碧图/封面）与看图模型；只负责“看见”，不负责怎么说。

## 文件（`packages/bot/src/` 下）

- `vision/vision.ts`
- `vision/photos.ts`
- `vision/photo-index-lock.ts`
- `vision/photo-sources.ts`
- `vision/ai-photo-drafts.ts`
- `vision/ai-photo-provider.ts`
- `vision/ai-photo-quality.ts`
- `vision/ai-photo-quality-adapter.ts`
- `vision/ai-photo-references.ts`
- `vision/ai-photo-storage.ts`
- `vision/safe-image.ts`
- `vision/media.ts`
- `vision/hearing.ts`
- `vision/voice-out.ts`
- `vision/sticker-reads.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `biliStickers` | 表情包自己在 B 站找（顶替小黄脸） | [ADR 0132](../adr/0132-bili-stickers.md) |
| `readStickers` | 看懂他发的表情包（先抄图上的字、再说画面；要看图模型） | [ADR 0206](../adr/0206-read-his-stickers.md) |
| `foodPhotos` | 吃的照片（这一顿拍给他看） | [ADR 0128](../adr/0128-food-photos.md) |
| `photos` | 照片货架（网上找高清图） | [ADR 0109](../adr/0109-photo-shelf.md) |
| `aiPhotos` | AI 生活照草稿（人工审核后才可用） | [ADR 0240](../adr/0240-world-and-qq-ai-photo-requests.md) |
| `stickers` | 图片表情（模式） | [ADR 0063](../adr/0063-image-stickers.md) |
| `media` | 听语音、看图 | [ADR 0052](../adr/0052-voice-and-images.md) |

## 看它有没有变好

周报「图片」；vision 相关单测；图片不发外网的比例

## 最相关的 ADR

[ADR 0055](../adr/0055-deepseek-vision.md)、[ADR 0109](../adr/0109-photo-shelf.md)、[ADR 0128](../adr/0128-food-photos.md)、[ADR 0206](../adr/0206-read-his-stickers.md)、[ADR 0239](../adr/0239-ai-photo-drafts.md)、[ADR 0242](../adr/0242-ai-photo-quality-and-references.md)、[ADR 0244](../adr/0244-ai-photo-provider-budget.md)、[ADR 0246](../adr/0246-ai-photo-storage-audit.md)、[ADR 0306](../adr/0306-photo-index-process-coordination.md)、[ADR 0326](../adr/0326-vision-review-boundaries.md)
