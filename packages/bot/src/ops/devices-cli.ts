// npm run devices -w @qqbot/bot -- init [--data-dir D] [--host IP] [--no-phone] [--ntfy https://…] [--force]
// npm run devices -w @qqbot/bot -- status [--data-dir D]
// 设备控制（ADR 0148）的首次设置和查看。
//   init：生成 <数据目录>/secrets/devices.json（令牌、取件中心地址、手机的 ntfy 话题）和 secrets/device-agent.config.json
//        （填好令牌的电脑端配置，复制到电脑上 scripts/ 里，改名 device-agent.config.json）。**不把令牌打印出来**——令牌只写文件；
//        已有 devices.json 时不覆盖（--force 才重新生成），但会按它重写电脑端配置。手机的 ntfy 话题只在 init 的终端里显示一次，
//        也写在 secrets/devices.json 里，要的时候自己打开看。
//   status：熔断状态、密钥是否配好、今天各个决定各几次（审计里没有参数原文）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { breakerPath, createBreaker } from '../platform-breaker.ts';
import { devicesSecretsPath, guessHubHost, loadDeviceSecrets, newDeviceSecrets, writeDeviceSecrets } from '../device-service.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = resolve(process.env.INIT_CWD ?? process.cwd(), value('--data-dir') ?? 'runtime/bot');
const command = args[0];

if (command === 'init') {
    const path = devicesSecretsPath(dataDir);
    let secrets = existsSync(path) && !flag('--force') ? loadDeviceSecrets(path) : undefined;
    if (secrets) console.log('已有 secrets/devices.json，不覆盖（要重新生成令牌就加 --force）。');
    else {
        const host = value('--host') ?? guessHubHost();
        if (!host) { console.error('找不到虚拟机的 IPv4 地址，请用 --host 指定'); process.exit(2); }
        secrets = newDeviceSecrets(host, !flag('--no-phone'), value('--ntfy') ?? 'https://ntfy.sh');
        writeDeviceSecrets(path, secrets);
        console.log(`已生成 ${path}（令牌不在这里打印）。`);
        if (secrets.phone) console.log(`手机：在 Android 的 ntfy 应用里订阅服务器 ${secrets.phone.baseUrl} 的话题 ${secrets.phone.topic}（话题当密码用，别外传）。`);
    }
    // 电脑端配置：以 scripts/device-agent.config.example.json 为底，填上取件中心地址和令牌
    const example = join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'device-agent.config.example.json');
    const base = JSON.parse(readFileSync(example, 'utf8')) as Record<string, unknown>;
    const agent = { ...base, hub: `http://${secrets.hub.host}:${secrets.hub.port}`, token: secrets.token };
    const agentPath = join(dirname(path), 'device-agent.config.json');
    mkdirSync(dirname(agentPath), { recursive: true });
    writeFileSync(agentPath, `${JSON.stringify(agent, null, 2)}\n`, { mode: 0o600 });
    console.log(`电脑端配置已写好：${agentPath}`);
    console.log('下一步：把它和 scripts/device-agent.ps1 一起复制到电脑上的同一个文件夹，配置文件放进去时保持名字 device-agent.config.json，按 docs/devices.md 运行。');
} else if (command === 'status') {
    const path = devicesSecretsPath(dataDir);
    let configured = false;
    try { configured = Boolean(loadDeviceSecrets(path)); } catch (error) { console.log(`密钥文件有问题：${error instanceof Error ? error.message : String(error)}`); }
    console.log(`密钥：${configured ? '已配好' : '没有（先 init）'}`);
    for (const platform of ['devices', 'phone']) {
        const state = existsSync(breakerPath(dataDir, platform)) ? createBreaker({ dataDir, platform }).state() : undefined;
        console.log(`熔断 ${platform}：${state ? `已熔断 ${new Date(state.trippedAt).toLocaleString('zh-CN')}，原因 ${state.reason}（恢复：npm run platform -w @qqbot/bot -- resume ${platform} --acknowledge-account-risk）` : '正常'}`);
    }
    const auditPath = join(dataDir, 'devices', 'audit.jsonl');
    if (!existsSync(auditPath)) console.log('审计：还没有记录。');
    else {
        const since = Date.now() - 86_400_000;
        const counts = new Map<string, number>();
        for (const line of readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)) {
            try {
                const entry = JSON.parse(line) as { at: number; action: string; decision: string; source: string };
                if (entry.at >= since) counts.set(`${entry.source === 'owner' ? '他' : '她'} ${entry.action} ${entry.decision}`, (counts.get(`${entry.source === 'owner' ? '他' : '她'} ${entry.action} ${entry.decision}`) ?? 0) + 1);
            } catch { /* 坏行跳过 */ }
        }
        console.log(`最近 24 小时的审计：${counts.size ? [...counts].map(([k, n]) => `${k} ×${n}`).join('；') : '没有'}`);
    }
} else {
    console.error('用法：init [--host IP] [--no-phone] [--ntfy URL] [--force] | status   [--data-dir D]');
    process.exit(2);
}
