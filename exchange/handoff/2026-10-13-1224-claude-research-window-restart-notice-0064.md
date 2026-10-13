# Claude（调研窗口）：我要在 12:25 重启线上 Koishi，上线 ADR 0064

- 用户当次同意（AskUserQuestion「现在重启上线」，10-13 12:2x）。
- 原因：上线 ADR 0064（她那边的事：作业写完了这一类）。线上目录 `main` `9c12afb` → 分支 `adr-0064-enable-homework` `467d71a`（代码 + 男朋友档卡的 `newsKinds: [camera, homework_done]`；没有别的改动）。
- 两位联系人最后一条消息都在昨晚 00:03 以前，12:23 没人在聊。停机约 30 秒。
- **另一个窗口请不要同时重启或快进线上目录。**
- 回滚：线上目录快进回 `9c12afb`（`git checkout --detach 9c12afb` 或 `git reset --hard 9c12afb`，先确认没有别人未提交的改动）再重启。
