// node src/ops/social-cli.ts status [--data-dir D]
// node src/ops/social-cli.ts login <xhs|douyin> [--visible] [--qr-only] [--data-dir D]   （--qr-only：只画二维码、不等扫码，检查这一段能不能走通）
// node src/ops/social-cli.ts probe <xhs|douyin> [--search 关键词] [--open] [--screens N] [--save-frame 文件] [--data-dir D]
// 小红书 / 抖音专号（ADR 0166）：看熔断和登录态、扫码登录、只读体检。
// 默认数据目录是仓库根目录下的 runtime/bot（工作树自己的那份）；线上那份要 --data-dir C:\Users\XG\Desktop\Project\qqbot\runtime\bot。
// 只读：不点赞、不关注、不评论、不私信。碰到验证码不去解——用 login --visible 自己点。

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BreakerOpen, createBreaker } from '../platform-breaker.ts';
import { isPlatform, PLATFORM_NAME, PLATFORMS, realPacing, type Platform, type SocialPost } from '../social.ts';
import { runSocialLogin } from '../social-login.ts';
import { openSocialSession, SessionRefused } from '../social-session.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = resolve(process.env.INIT_CWD ?? process.cwd(), flag('--data-dir') ?? resolve(import.meta.dirname, '../../../../runtime/bot'));
const [command, platformArg] = args;
const log = (message: string) => console.log(`  · ${message}`);
const usage = () => { console.error('用法：status | login <xhs|douyin> [--visible] | probe <xhs|douyin> [--search 词] [--open] [--screens N] [--save-frame 文件]   [--data-dir D]'); process.exit(2); };

const line = (post: SocialPost) => `${post.kind === 'video' ? '视频' : '图文'}｜${post.title.slice(0, 30)}｜${post.author || '?'}｜赞 ${post.likes ?? '?'}${post.durationS ? `｜${Math.round(post.durationS / 60 * 10) / 10} 分钟` : ''}`;

async function withSession(platform: Platform, body: (session: Awaited<ReturnType<typeof openSocialSession>>) => Promise<void>, extra: { visible?: boolean; images?: boolean } = {}): Promise<void> {
    try {
        const session = await openSocialSession({ platform, dataDir, log, ...extra });
        try { await body(session); } finally { await session.close(); }
    } catch (error) {
        if (error instanceof BreakerOpen) { console.error(`${PLATFORM_NAME[platform]}已熔断：${error.message}`); process.exit(3); }
        if (error instanceof SessionRefused) { console.error(error.message); process.exit(4); }
        console.error(`出错：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

console.log(`数据目录：${dataDir}`);
if (command === 'status') {
    for (const platform of PLATFORMS) {
        const state = createBreaker({ dataDir, platform }).state();
        if (state) { console.log(`${PLATFORM_NAME[platform]}：已熔断 ${new Date(state.trippedAt).toLocaleString('zh-CN')}，原因 ${state.reason}（platform resume ${platform} --acknowledge-account-risk 才恢复）`); continue; }
        await withSession(platform, async session => {
            const status = await session.reader.status();
            console.log(`${PLATFORM_NAME[platform]}：${status.loggedIn ? '已登录' : '没登录（访客）'}——${status.detail}`);
        });
    }
} else if (command === 'login' && isPlatform(platformArg)) {
    await withSession(platformArg, async session => {
        const result = await runSocialLogin(session, { out: text => console.log(text), pacing: realPacing, dataDir, qrOnly: args.includes('--qr-only') });
        console.log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
        if (!result.ok) process.exitCode = 1;
    }, { visible: args.includes('--visible'), images: true });
} else if (command === 'probe' && isPlatform(platformArg)) {
    await withSession(platformArg, async session => {
        const { reader } = session;
        const status = await reader.status();
        console.log(`登录态：${status.loggedIn ? '已登录' : '访客'}（${status.detail}）`);
        const screens = Number(flag('--screens') ?? 1);
        const feed = await reader.feed(Number.isFinite(screens) ? screens : 1);
        console.log(`首页刷到 ${feed.length} 条：`);
        for (const post of feed.slice(0, 8)) console.log(`  ${line(post)}`);
        let pool = feed;
        const keyword = flag('--search');
        if (keyword) {
            const found = await reader.search(keyword, 1);
            console.log(`搜「${keyword}」${found.length} 条：`);
            for (const post of found.slice(0, 8)) console.log(`  ${line(post)}`);
            if (found.length) pool = found;
        }
        if (args.includes('--open') && pool[0]) {
            const opened = await reader.open(pool[0], { watchMs: 6_000, frames: 1 });
            const post = opened.post;
            console.log(`点开：${line(post)}`);
            console.log(`  正文：${post.text.slice(0, 120) || '（没读到）'}`);
            console.log(`  标签：${post.tags.join('、') || '（没有）'}；热评 ${post.comments.length} 条：${post.comments.map(c => `「${c}」`).join('')}`);
            console.log(`  截帧 ${opened.frames.length} 张${opened.frames[0] ? `（${Math.round(opened.frames[0].length / 1024)} KB）` : ''}`);
            const save = flag('--save-frame');
            if (save && opened.frames[0]) { writeFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), save), opened.frames[0]); console.log(`  第一帧存到 ${save}`); }
        }
    });
} else usage();
