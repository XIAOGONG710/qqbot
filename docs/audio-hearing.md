# 声音（耳朵）：接口留好了，实现没接

2026-11-01 用户：「我想让她真正听到声音」→ 之后说「留好接口，之后再做吧」。

## 现在的状态

- 接口：`packages/bot/src/vision/hearing.ts`（`AudioHearing.listen` + `createHearing()`）
- 接入点：`vision/media.ts` 的 `hear()`——收到语音时，转出的文字后面会跟一段
  `[声音：语速偏慢，声音低，背景像在下雨]`
- 开关：**没有开关**；`createHearing()` 现在返回 `undefined`，所以线上行为一点没变
- 测试：`test/media.test.ts`（接上时多一段、没接时原样、听不出来不编）

## 之后要接的时候（改一个函数）

`hearing.ts` 里的 `createHearing()` 返回一个对象即可，别处不用动：

```ts
export function createHearing(): AudioHearing | undefined {
    return {
        async listen({ path, seconds, text, signal }) {
            const description = await describeSound(path!, signal); // 你的实现
            return description; // 一句话；听不出来返回 undefined
        },
    };
}
```

## 三条实现路线（按成本）

| 路线 | 拿到什么 | 成本 | 代价 |
| --- | --- | --- | --- |
| **特征描述**（librosa / ffmpeg） | 音高、响度、语速、背景音、有没有鼓点 | 2–3 小时 | 说不出“这是什么曲子” |
| **云端音频大模型**（Qwen2-Audio 等） | 真的听懂：音乐、环境、情绪 | 半天 | 声音要上传云端；按量计费 |
| **本地音频大模型**（Qwen2-Audio-7B） | 同上，全本地 | 1–2 天 | 模型十几 GB；这台 5060 只有 8GB 显存，要量化、慢 |

## 顺带说明

- 现在她听到的是 **QQ 服务器转的文字**（NapCat 的 `fetch_ptt_text`），5 秒超时、只认 QQ 语音；
- 发 mp3 / 视频她是收不到的——那要另走一条「抽音轨 → 转写/描述」的路，和这个接口共用 `listen()`。
