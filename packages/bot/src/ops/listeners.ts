// 本机监听检查（ADR 0070 第 12 项）：我们自己的进程（Koishi / NapCat / Hindsight / PostgreSQL）只该监听本机回环地址。
// 服务只靠「监听 127.0.0.1」挡外面的人，所以绑定变了要马上发现，而不是等数据被读走。

export interface Listener { address: string; port: number; pid: number; name: string }

/** 只管我们自己起的进程；远程桌面（3389）、系统服务不是本项目的事 */
export const OUR_PROCESSES: readonly string[] = ['node', 'python', 'postgres', 'qq', 'napcatwinboot', 'napcatwinbootmain'];
const LOOPBACK = new Set(['127.0.0.1', '::1']);

export function exposedListeners(listeners: readonly Listener[], ours: readonly string[] = OUR_PROCESSES): Listener[] {
    return listeners.filter(item => ours.includes(item.name.toLowerCase()) && !LOOPBACK.has(item.address));
}

/** PowerShell 的 ConvertTo-Json：一个对象时不是数组，没有结果时是空 */
export function parseListeners(json: string): Listener[] {
    const text = json.trim();
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap(row => {
        const r = row as Record<string, unknown>;
        return typeof r.address === 'string' && typeof r.port === 'number'
            ? [{ address: r.address, port: r.port, pid: Number(r.pid ?? 0), name: String(r.name ?? '') }]
            : [];
    });
}

export const LISTENERS_POWERSHELL = '@(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess; name = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } }) | ConvertTo-Json -Compress';
