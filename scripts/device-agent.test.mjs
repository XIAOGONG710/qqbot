// scripts/device-agent.ps1 的纯函数（ADR 0148，2026-11-26 设备控制审查）：只把函数定义抠出来单独跑，
// 不跑整个小程序（它会连取件中心、按键），所以这里不会碰到任何真的设备。没有 Windows PowerShell 的机器上跳过。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const script = readFileSync(join(import.meta.dirname, 'device-agent.ps1'), 'utf8');
const hasPowerShell = (() => {
    if (process.platform !== 'win32') return false;
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** 抠出一个 function 定义（到第一行只有「}」为止） */
function functionText(name) {
    const match = new RegExp(`^function ${name}\\b[\\s\\S]*?^\\}`, 'm').exec(script);
    assert.ok(match, `device-agent.ps1 里没有 ${name}`);
    return match[0];
}

test('音量 set：先按 50 次「减」，再每 2% 按一次「加」；0 和 1 一次「加」都不按（原来 1..0 会按两次，静音变成 4%）', { skip: !hasPowerShell && '没有 Windows PowerShell' }, () => {
    const command = `${functionText('Get-VolumeKeys')}\n@(0, 1, 2, 3, 40, 60) | ForEach-Object { $k = Get-VolumeKeys $_; '{0}:{1}:{2}' -f $_, @($k | Where-Object { $_ -eq 0xAE }).Count, @($k | Where-Object { $_ -eq 0xAF }).Count }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim().split(/\r?\n/);
    // [Math]::Round 是银行家舍入：1 → 0、3 → 2
    assert.deepEqual(out, ['0:50:0', '1:50:0', '2:50:1', '3:50:2', '40:50:20', '60:50:30']);
});

test('通知文字的长度按字（码点）数，和 bot 那头一样：60 个表情能弹，61 个不行；带尖括号、换行的不行', { skip: !hasPowerShell && '没有 Windows PowerShell' }, () => {
    // 表情用 ConvertFromUtf32 在 PowerShell 里拼，命令行上只有 ASCII
    const command = `${functionText('Test-Text')}\n$e = [char]::ConvertFromUtf32(0x1F600)\n(Test-Text ($e * 60) 60); (Test-Text ($e * 61) 60); (Test-Text ('x' * 60) 60); (Test-Text ('x' * 61) 60); (Test-Text 'a<b' 60); (Test-Text "a\`nb" 60); (Test-Text '' 60); (Test-Text 5 60)`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.deepEqual(out, ['True', 'False', 'True', 'False', 'False', 'False', 'False', 'False']);
});

test('device-agent.ps1 保持纯 ASCII（Windows PowerShell 5.1 会把没有 BOM 的 UTF-8 读错）', () => {
    assert.doesNotMatch(script, /[^\x00-\x7f]/);
});
