# 2026-10-28 13:2x DSH：DSH 桌面人格探针（阶段结果）

用户去上课，回来继续。当前状态留在本文件，避免断片。

## 已完成

- 在 **用户补丁层** `C:\Users\22601\.dsh\profiles\desktop\cordis.patch.yml` 新增预设：
  - `preset-linmengyao`（id `linmengyao`）：persona 用**完整角色卡**（约 5113 字，`{{char}}`→林梦瑶、`{{user}}`→你，其余模板变量已清）；
  - `complete: true`、`includeHarnessIdentity: false`、`includeRuntimeContext: false`；
  - `agent-preset-registry.selectedDefault: linmengyao`（新会话默认是她）；
  - `dsh-engram` 暂时 **disabled**（切断“鲸鱼娘/鱼片/喵~”污染）。
- 旧会话仍走旧预设（助手），新会话是她。
- 重启方式：`restart-dsh2.ps1`；回滚：`restore-persona2.ps1`（恢复 `cordis.yml` 与 `cordis.patch.yml` 备份并重启）。

## 用户反馈

- ✅ 人格替换生效，新会话是林梦瑶；
- ⚠️ **语气有点冲**：卡里的“傲娇/嘴硬/损他”被放大，工作场景下显得冲。

## 回来后的下一步

1. 调语气（不加新机制，只改 persona 文本）：
   - 工作/初次对话时降低“损他、白眼、嘲讽”的权重；
   - 保留傲娇但限定在“他先闹/小事”时；
   - 加一句“对别人的事认真，不冲”；
2. 用 10 句对照：她（旧卡 QQ）vs DSH 新预设，盲评“像不像同一个人、冲不冲”；
3. 语气稳定后，再清 DSH 会话/engram 数据并导入她的记忆（两间房）。

## 备份

- `cordis.yml.bak-before-live-probe-*`
- `cordis.patch.yml.bak-probe-*`
- 脚本：`restore-persona2.ps1`、`restart-dsh2.ps1`
