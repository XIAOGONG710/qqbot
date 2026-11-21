# 本地改动（相对 aowind/dsh-super-agent 0.2.0）

上游：<https://github.com/aowind/dsh-super-agent>，MIT，0.2.0，commit `668151217b7a94e6638b2b2d3000db3d838916f1`（clone 于 2026-11-21）。
本目录是上游原样拷贝 + 下面这一处补丁；升级时重下上游再重放补丁，别手工改出一堆分叉。

## 补丁：worker 会话真的拿到 preset 的工具

**症状**：派出去的 worker 只有 host 层工具（`read`/`write`/`pwsh`/`grep`/`web_fetch` 全没有，共 49 个），读不了文件、改不了代码，工单只能回 `no-change`。

**根因**：`index.js` 里 worker 走 `agents.create({ meta: { agentPreset: 'standard' } })`。`meta.agentPreset` 只是写进 Session 头部的元数据，**不组装插件**；DSH 里组装 preset 的入口是 `ctx.agentPresets.select(agent, id)`（`docs/subsystems/core.md` 的 `AgentPresetRegistry`）。于是 worker 会话头写着 `agentPreset: 'standard'`，实际只有 host 层那批行。

**改法**（`index.js`）：
- `OPTIONAL` 里加 `agentPresets`；
- 新增配置 `workerPreset`（默认 `'standard'`），三处 `'standard'` 字面量改用它（nested 创建、fallback 创建、`sa-manager`）；
- nested 创建成功后调 `ctx.agentPresets.select(agent, presetId)`，失败只记录到 `worker.presetError`，不影响派单。

**验证**：同一套只读工单，改前 worker 工具数 49（无 `read`），改后 80（有 `read`/`write`/`edit`/`pwsh`/`web_fetch`），并成功读出 `docs/roadmap.md` 头条。详见 `docs/adr/0345-her-seat-as-dsh-router.md`。

**给上游的话**：如果 aowind 愿意，这段可以提 PR——`agents.create` 的 `meta.agentPreset` 不组装插件这件事，光看 README 很容易踩。

## 注意

- 本目录通过 `link:` 挂在 `~/.dsh/profiles/desktop`；改完要重载 bundle（`plugin_manager set_plugin include:dsh-super-agent enabled=false` 再 `true`）才生效，`index.js` 本身的 ESM 缓存由 Node 决定，热更不覆盖它。
- `workerPreset` 默认 `standard`：worker 是「手」，不要她的语气；她本人的座位是 `preset-linmengyao`（同名 bundle `dsh-linmengyao-preset`）。
