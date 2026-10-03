# packages/

本项目自有代码放在这里，**不直接改 `vendor/` 下的上游源码**。

计划中的形态（尚未创建，按需落地）：

| 目录 | 类型 | 挂载到 SillyTavern 的位置 |
| --- | --- | --- |
| `st-server-plugin/` | ST 服务端插件（Node，`index.js`/`index.mjs` 或 `package.json` 的 `main`） | `vendor/SillyTavern/plugins/<name>/` |
| `st-extension/` | ST 前端扩展（`manifest.json` + JS） | `vendor/SillyTavern/public/scripts/extensions/third-party/<name>/` |

挂载方式：用目录联接（junction，无需管理员权限）把 `packages/<x>` 链接到上表位置。
这两个位置都被 SillyTavern 自己的 `.gitignore` 忽略，所以链接后子模块工作区仍保持干净。

服务端插件需要在 SillyTavern 的 `config.yaml` 中设置 `enableServerPlugins: true`（默认 `false`）。
