# 他一键标「这句像 AI」/「像真人」（ADR 0195）：真模型机制检查（2026-10-30）

结论写在 `docs/adr/0195-speech-feedback.md`；这里放脚本和结果。

## 复现

`QQBOT_CONFIG=<config.json> node speech-feedback-dry.mjs <仓库根> ../2026-10-29-framework-ab/ctx-cases-v0.json ../2026-10-29-framework-ab/hers-A-full.json --limit 16`（key 从环境变量 QQBOT_LLM_API_KEY 读）。
和 `../2026-10-30-learn-from-real-chat/speech-notes-dry.mjs` 的区别只有一处：`reflectIfDue` 多传了 `feedback`——**合成的**：她管线回复里最长的 3 次标「像 AI」（第一条带理由「太啰嗦了」）、最短的 2 次标「像真人」。结果见 `dry-run-1.txt` / `dry-run-2.txt`。

## 读法

两次都写了 3 条、全部通过防线。**这只能说明机制通、防线没误伤**：反馈是合成的，不是他的真实偏好；她同时看着那组数字（每条中位 15 字 vs 真人 6 字），笔记里「解释收不住」这类话归因不到反馈上。没有量过对真实对话的影响。

`mutate-feedback.mjs`：29 处变异检验，全红（第一遍有 5 处没红，补测试 / 删等价后重跑全红）。
