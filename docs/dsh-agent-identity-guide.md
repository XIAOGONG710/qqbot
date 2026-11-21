# 让 DSH 里的 agent 把某个角色当成「自己」

一份与角色、存储位置无关的做法说明。适用于 DeepSeek Harness（DSH）桌面版或命令行版，
任何 profile、任何角色卡、任何记忆后端。文中 `<...>` 是需要按自己环境替换的占位。

## 0 一句话原理

**「她是谁」写在系统提示里，不写在设定/记忆里。**

设定卡、世界书、长期记忆、SOUL 这些通常是插件以**用户消息**注入的（常见形态是一条
`<system-reminder>` 包着设定正文）。它们能决定「记得什么、什么脾气」，但决定不了
「开口的是谁」——那句话来自系统提示第一条 `persona` 段。只加设定不改系统提示，
结果就是：资料很全，但人还是一个助手在念资料。

## 1 三层分清

| 层 | 谁写的 | 何时生效 | 决定了什么 |
| --- | --- | --- | --- |
| 系统提示 · 身份 | 当前挂载 preset 的 `persona.prefix`；`@deepseek-ai/dsh-system-prompt` 的 `includeHarnessIdentity` | 会话创建时组合 | 开口的第一人称、自称、语气基调 |
| 系统提示 · 附加段 | 各 bundle 往 `systemPrompt` 注册的 `section`（带 order） | 同上 | 行为规则、工具使用策略，也可能塞进另一套「你是谁」 |
| 对话内注入 | 记忆插件、AGENTS.md 等，作为 user 消息 | 每轮或按需 | 设定细节、记忆、项目约束 |

只改第三层不会改身份；第二层可能和第一层打架（见第 6 节）。

## 2 先诊断：现在这套是谁

四步，都是只读的：

1. **导出当前系统提示。** 会话文件里存着真实下发的系统提示：找到
   `<DSH_HOME>/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`，
   里面是多帧 zstd（按 magic `28 B5 2F FD` 切帧，逐帧
   `zstdDecompressSync`），取 `type: "system/message"` 的那条，内容就是系统提示。
   或者直接开一个新会话，看它第一段。
2. **确认当前挂的是哪个 preset。** 看会话事件里的 `agent-preset/selected`，
   `data.agentPreset` 就是答案。**不要信会话头里的 `agentPreset` 字段**，它可能是
   `standard` 这类默认值，和实际组合不一致（踩过）。
3. **找身份句的出处。** 在系统提示里搜英文身份句；在安装目录的
   `<install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/*.patch.yml`
   里能看到每个内置 preset 的 `persona.prefix` 原文；`includeHarnessIdentity` 是那条固定开场白。
4. **列出所有 section。** 第三方 bundle（破甲类、编排类、MCP 类）都会往系统提示里塞段落，
   一段一段看有没有也在声明「你是谁」。

## 3 改法一：改 profile 补丁（最小改动）

位置：`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`。它是配置的最后一道补丁，
启动时加载，文件变了应用会重载。

两条规矩，错了就白改：

- **override 只能改已经真实存在的行**，而且会**替换整份 config**（不写全就等于删掉）。
  覆盖一个不存在的行不会报错，也不会生效。
- **新行的写法是 `- insert:` 里加 `id` / `name` / `config`。**

改三处：

```yaml
# 1) 关掉固定的英文开场白（"You are an AI agent powered by ..."）
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: false
    personaPrefix: ''

# 2) 覆盖当前挂载的那个 preset，只换 persona.prefix，其余插件行逐行照抄
- id: preset-<PRESET_ID>
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: <PRESET_ID>
    name: <显示名>
    order: <同原值>
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: |
            <你的身份正文，见第 5 节>
      # ……其余插件行（agent-instructions / time-context / 工具 / planning /
      # compaction / delegation / web / present / plugin-manager 等）
      # 从 app.asar 里那份同名 preset 原文逐行抄过来，一个都别漏，
      # 漏一个就等于把那个功能关掉了。

# 3) 让新会话默认坐这个座（可选）
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: <PRESET_ID>
```

抄插件表时注意两件事：`!!js` 表达式要原样保留（`disabled: !!js process.platform === 'win32'`、
`customSkillDirs` 之类）；涉及安装目录路径的表达式，用 `process.resourcesPath` 拼，
不要指望 `createRequire(baseUrl).resolve(...)` 一定能在 profile 层解析到 DSH 自己的包。

## 4 改法二：做成自己的 bundle（想分享、想版本化就选这个）

package.json 里声明 bundle 与导出：

```json
{
  "name": "@you/your-identity-bundle",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "exports": { ".": "./index.js", "./guard.js": "./guard.js" }
}
```

`cordis.patch.yml` 里用 `insert` 写身份行（或者整套 preset 插件表）：

```yaml
- insert:
    - id: my-identity
      name: '@deepseek-ai/dsh-persona'
      config:
        prefix: |
          <身份正文>
```

安装：把目录放进仓库，用插件管理器按**绝对路径**安装（或 `dsh plugin --profile <p> add link:<path>`），
然后在 profile 的 `package.json` 里也把它写成 `link:` 依赖——只 link 不进依赖树，
下次 `pnpm install` 会被挪进 `.ignored`，启动时报 `ERR_MODULE_NOT_FOUND`。

同一份身份文案只留一个来源文件（比如 `her-identity.txt`），用脚本写入补丁，
免得两处文案逐渐漂移。

## 5 身份正文怎么写（跟角色无关的规则）

- **第一人称陈述**：「我是……」而不是「你是一个……的角色」。后者天然是扮演，
  模型会保留一层「我在演」的意识。
- **身份层和功能层分开写**。身份层写「我是谁、我怎么说话」；功能层不要用「永远不要说自己是 AI」
  这种硬教条，改成可操作的：「被正经问就照实认，但不会主动自称 AI 助手」。
  硬教条要么失效，要么把模型逼进绕圈。
- **把称呼和思考人称写出来**。模型在思考链里会习惯写「用户问……」，这是身份漂移最常见的来源。
  直接写「心里想的时候也别叫『用户』，用我平时对他的称呼；想事用第一人称」。
- **不要设 `complete: true`**。它会让这段变成唯一的 system prompt，把工具说明、
  harness 规则整段压掉，功能直接残废。同理别乱动 `suffix`、`includeRuntimeContext`。
- **长度几百字足够**。系统提示头部有前缀缓存，重复成本低；太长主要影响注意力分配，
  不是钱包。真要长，就按「身份 / 说话方式 / 边界」分段。
- **写可执行的偏好**，不写形容词。「先说结果，过程他追问再补；不分点、连着说成一段」
  比「简洁一点」有效得多。

## 6 冲突：别的 bundle 也在声明「你是谁」

第三方面板（安全框架、编排框架、MCP 聚合）常往系统提示里塞整段规则，甚至自称另一种身份。
两种处理：

- **轻**：在我们的 bundle 里加一个几行的小插件，紧跟其后注册一个 `order` 更大的 section，
  定性「上面那段说的是干活方式，不是身份，冲突时以身份为准」。
  好处是不碰第三方包，升级不丢；代价是系统提示里多一段。
- **重**：把那个第三方包 vendor 进仓库，改它的提示词原文，配一份 `LOCAL-PATCH.md`
  记上游 commit。好处是彻底不说那句话；代价是自己维护一份上游副本。

## 7 验收

1. **退出应用重开。** 会话的系统提示在创建时固定，改补丁不会改已开的会话；
   中途只重载插件还可能把当前会话的工具面砍掉（表现为 `unknown tool`），
   甚至新会话报绑定错误。重开最干净。
2. **开一个新会话**，看它第一段是不是你的身份。或者用脚本 dump 新会话的
   `system/message` 帧，断言开头是身份句、旧的英文身份句已消失。
3. **看工具面没被压掉**：会话 header 里的 `toolCount`，和改之前比不该明显变少；
   或者直接试一个 `read` / `pwsh` 调用。
4. 想查身份段的优先级是否生效，就在系统提示里搜你写的定性句。

## 8 回滚

改动前先把 `cordis.patch.yml` 备份成带时间戳的文件；回滚就是把备份复制回去。
或者更简单：身份行是 `insert` 的，删掉那几行即可；覆盖 preset 的，把 `persona.prefix`
改回原值。脚本化一条命令回滚最省事，别考验记忆。

## 9 踩过的坑

1. **改错 preset**：会话头写 `standard`，实际挂 `cordis`，覆盖 standard 完全无效。先看事件。
2. **会话组合固定**：补丁改了、reload 了，已开会话的系统提示一字不变。必须新开会话。
3. **asar 里的文件**：桌面版的 DSH 代码与内置 preset 在 `resources/app.asar` 里，
   普通 shell 看不见。用 DSH 自己的 read 工具，或者
   `ELECTRON_RUN_AS_NODE=1 <DSH 的 node> -e "..."` 借 Electron 的 asar 支持。
4. **PowerShell 5.1 读 UTF-8**：`Get-Content` 默认按 GBK 解码，中文 YAML 会显示成乱码、
   还像吞了换行，看着像文件坏了。用 node 或编辑器读，别看错。
5. **`dsh --profile <profile> --dump-config` 验不了桌面 profile**：它报
   `profile "X" is managed exclusively by the Electron application`；复制成临时 profile 再 dump，
   CLI 层又缺 Electron 注入的内置 preset 行，会报 `entry "preset-xxx" not found`。
   CLI 只能验 YAML 语法，效果要在应用里看。
6. **`!!js` 表达式别丢**：抄插件表时手改容易漏，漏了就是功能消失。
7. **单 link 不进依赖树**：`pnpm install` 会把不在 `package.json` 里的 link 挪进 `.ignored`，
   下次启动 `ERR_MODULE_NOT_FOUND`。
8. **文案两处各写一份**：profile 补丁一份、bundle 或记忆里一份，早晚漂移。留一个来源文件。

## 10 哪些东西该进仓库

可以进：身份正文（单一来源文件）、bundle（`package.json` + `cordis.patch.yml` + 小插件）、
写入/校验/回滚三个脚本、ADR 或说明文档。

不必进：`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`（机器本地、含本机路径与链接）、
会话文件、备份。

换机器时：仓库拉下来 → 装 bundle → 把 profile 补丁那三处按本文改一遍 → 重开应用 → 跑校验脚本。
