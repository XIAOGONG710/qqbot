# Android 手机伴侣壳

这是现有 PWA 的最小原生宿主，不内置 DSH/QQ 密钥、不提供 JavaScript 桥，也不提供 shell。

构建时用 Gradle 属性指定唯一允许访问的 HTTPS 地址：

```powershell
gradle assembleDebug -PCOMPANION_URL=https://你的手机伴侣地址/
```

也可以直接用 Android Studio 打开此目录并在 Gradle 参数中配置该属性。WebView 禁止明文流量、文件访问、混合内容和跨站导航；麦克风同时需要 Android 运行时授权和同源页面请求。配对、动作白名单、人工确认和审计仍由现有手机伴侣网关负责。真机安装、推送通知渠道和商店签名需要在目标设备与正式域名准备好后验收。
