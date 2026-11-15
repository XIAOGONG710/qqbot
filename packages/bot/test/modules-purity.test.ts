import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// ADR 0336「不做 / 不变」：没有绕过执行器的副作用——模块目录里不出现 node:fs、fetch、setTimeout / setInterval、chatCompletion 和对 Transport 的直接调用。
// ADR 原定第 6 步之后再核对；2026-11-16 查的时候模块目录已经全部满足，所以现在就立起来，免得以后新模块图省事直接碰。
// 只看模块文件自己写的（它 import 的 platform / language 里的纯函数不管；那些文件碰不碰外部是第 6 步收尾的事）。
const dir = new URL('../src/modules/', import.meta.url);
const FORBIDDEN: readonly [RegExp, string][] = [
    [/from 'node:(fs|fs\/promises|child_process|net|http|https|dgram|worker_threads)'/, '直接用 node 的文件 / 进程 / 网络模块'],
    [/(?<![.\w])fetch\(/, '直接 fetch'],
    [/(?<![.\w])(setTimeout|setInterval|setImmediate)\(/, '直接开计时器'],
    [/\bchatCompletion\b/, '直接调模型'],
    [/import[^;]*\bTransport\b[^;]*from/, '直接拿 Transport'],
];

describe('模块不绕过执行器（ADR 0336）', () => {
    test('src/modules 下的文件自己不碰文件、进程、网络、计时器、模型、QQ：要碰就由 App 给函数，或写成执行器的动作', () => {
        const files = readdirSync(dir).filter(name => name.endsWith('.ts'));
        assert.ok(files.length > 40, '模块目录读到了');
        const found: string[] = [];
        for (const name of files) {
            const lines = readFileSync(new URL(name, dir), 'utf8').split('\n');
            for (const [i, line] of lines.entries()) {
                if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
                for (const [pattern, why] of FORBIDDEN) if (pattern.test(line)) found.push(`modules/${name}:${i + 1} ${why}`);
            }
        }
        assert.deepEqual(found, []);
    });
});
