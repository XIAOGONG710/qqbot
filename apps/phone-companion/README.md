# 手机端伴侣 app（Android）——把手机屏幕推给她

目标（用户 2026-10-30）：**让她能看你的手机屏幕，跟你一起看。**

这个 app 只做一件事：按你设的频率截一张手机屏幕，推到她那台机器上的设备取件中心
（`POST http://<机器>:7789/frame`，带令牌）。其它什么都不做：不读通知、不读文件、不开任何入站端口。

## 它和 PC 那条的区别

| | 电脑（已有） | 手机（这个 app） |
|---|---|---|
| 谁发起 | 你发 `/屏幕` | app 自己定时推（或你按一下） |
| 通道 | 电脑上的 PowerShell agent 来取件 | app 主动 POST `/frame` |
| 谁能看 | 只有电脑端 agent 能取到 | 只有知道令牌的 app 能推 |

## 怎么建

需要 Android SDK（`ANDROID_HOME`）和 JDK 17+。

```bash
cd apps/phone-companion
# 没有 gradle wrapper 时用本机 gradle：gradle assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

装到手机：`adb install -r app/build/outputs/apk/debug/app-debug.apk`（或直接把 apk 传过去点安装）。

## 怎么配

打开 app，填三样：

- **取件中心**：`http://<她那台机器的局域网 IP>:7789`（手机和电脑同一个 Wi-Fi）；
- **令牌**：`runtime/bot-shadow/secrets/devices.json` 里的 `token`；
- **间隔秒数**：默认 60，最短 5。屏幕不常变的时候可以设大一点。

然后点「开始投屏」，系统会弹一次「是否允许截取屏幕」，同意即可。**锁屏、重启、系统回收之后要重新点一次**——这是 Android 的规定，绕不过去。

## 隐私边界（写死的行为）

- 每次截图都会在设备审计里留痕（`/设备` 能看到）；
- app 不后台偷录视频，只按间隔截 JPEG（默认压缩到 720p、质量 60）；
- 断网就丢这一帧，不攒、不重传；
- 令牌只存在 app 本地，日志里不打印。

## 现在的状态

- 服务端 `/frame` 入口：**已实现**（`packages/bot/src/platform/device-hub.ts`，11 项测试）；
- 这个 app：**源码在建**，还没编译出 APK（本机没有 Android SDK，见 `docs/devices.md`）。
