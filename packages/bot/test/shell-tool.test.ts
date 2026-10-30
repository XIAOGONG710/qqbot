import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runShell, shellNoteLine, takeShellCommands } from '../src/platform/shell-tool.ts';

// 用户 10-30：「直接将本机的最高权限给她」——她能在这台电脑上跑命令，但要留审计、能超时
test('从回复里摘出要跑的命令，剩下的字照发', () => {
    const taken = takeShellCommands('我看看哈\n<<执行：Get-ChildItem >>\n好了');
    assert.deepEqual(taken.commands, ['Get-ChildItem']);
    assert.equal(taken.text, '我看看哈\n\n好了');
    assert.deepEqual(takeShellCommands('没有命令').commands, []);
});

test('真跑：输出拿得到，退出码不对算没跑成', async () => {
    const ok = await runShell('Write-Output "hello"');
    assert.equal(ok.ok, true);
    assert.ok(ok.output.includes('hello'));
    const bad = await runShell('exit 3');
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 3);
});

test('跑太久会被掐掉，输出会截断', async () => {
    const slow = await runShell('Start-Sleep -Seconds 5', { timeoutMs: 500 });
    assert.equal(slow.ok, false);
    assert.ok(slow.output.includes('掐掉'));
    const many = await runShell('1..2000 | ForEach-Object { "line $_" }', { maxChars: 200 });
    assert.ok(many.output.length <= 220, String(many.output.length));
});

test('给她的那一行说清跑了什么、成没成', () => {
    const line = shellNoteLine({ command: 'whoami', ok: true, code: 0, output: 'pc-user', ms: 12 });
    assert.ok(line.includes('whoami'));
    assert.ok(line.includes('跑成了'));
    assert.ok(line.includes('pc-user'));
});
