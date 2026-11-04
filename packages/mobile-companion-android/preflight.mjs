import { existsSync } from 'node:fs';

export function androidPreflight(options = {}) {
    const urlText = options.url ?? process.env.COMPANION_URL ?? '';
    const release = options.release ?? process.argv.includes('--release');
    const blockers = [];
    let url;
    try { url = new URL(urlText); } catch { blockers.push('没有提供合法的手机伴侣地址'); }
    if (url && (url.protocol !== 'https:' || url.username || url.password)) blockers.push('手机伴侣地址必须是无账号信息的 HTTPS 地址');
    if (url?.hostname === 'companion.invalid' || url?.hostname.endsWith('.invalid')) blockers.push('正式构建不能使用占位域名');
    if (release && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) blockers.push('正式构建找不到 Android SDK');
    const gradleReady = existsSync(new URL('./gradlew', import.meta.url)) || existsSync(new URL('./gradlew.bat', import.meta.url)) || Boolean(process.env.GRADLE_HOME);
    if (release && !gradleReady) blockers.push('正式构建找不到 Gradle Wrapper 或 GRADLE_HOME');
    return { ready: blockers.length === 0, release, origin: url ? url.origin : undefined, blockers };
}

if (import.meta.url === new URL(`file:///${process.argv[1]?.replace(/\\/g, '/')}`).href) {
    const report = androidPreflight();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
}
