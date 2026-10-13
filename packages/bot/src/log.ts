// 日志：打到终端，同时按本地日期追加到 <dir>/<YYYY-MM-DD>.log（runtime/bot/logs，不入库）。
// bot 在用户自己的终端里运行，核对实测结果时从文件里只 grep 需要的几行。写文件失败不影响 bot。

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Log = (message: string) => void;

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * 日志是一行一条（ADR 0070 第 15 项）：来自 QQ 消息、OCR、模型回复的字符串里有换行、回车、控制字符时，
 * 不能让它另起一行冒充一条系统日志。换行换成可见的 ⏎，制表符换成空格，其余控制字符去掉。
 */
export function oneLine(message: string): string {
    return message
        .replace(/\r\n|\r|\n/g, ' ⏎ ')
        .replaceAll(LINE_SEPARATOR, ' ⏎ ')
        .replaceAll(PARAGRAPH_SEPARATOR, ' ⏎ ')
        .replace(/\t/g, ' ')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

export function createLog(dir: string, now: () => Date = () => new Date(), print: (line: string) => void = console.log): Log {
    let fileOk = true;
    try {
        mkdirSync(dir, { recursive: true });
    } catch (error) {
        fileOk = false;
        print(`日志目录 ${dir} 建不了，只打到终端：${error instanceof Error ? error.message : String(error)}`);
    }
    return message => {
        const time = now();
        const line = `[${time.toLocaleString('zh-CN', { hour12: false })}] ${oneLine(message)}`;
        print(line);
        if (!fileOk) return;
        try {
            appendFileSync(join(dir, `${localDate(time)}.log`), `${line}\n`);
        } catch (error) {
            fileOk = false;
            print(`日志写不进文件，之后只打到终端：${error instanceof Error ? error.message : String(error)}`);
        }
    };
}

function localDate(time: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}
