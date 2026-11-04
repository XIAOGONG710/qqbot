import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

interface CommandReceipt { userId: number; messageId: number; at: string }
interface CommandReceiptFile { version: 1; receipts: CommandReceipt[] }

export const MAX_COMMAND_RECEIPTS = 4_096;
export const COMMAND_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;

function validReceipt(value: unknown): value is CommandReceipt {
    if (!value || typeof value !== 'object') return false;
    const receipt = value as Partial<CommandReceipt>;
    return Number.isSafeInteger(receipt.userId) && receipt.userId! > 0
        && Number.isSafeInteger(receipt.messageId) && receipt.messageId! >= 0
        && typeof receipt.at === 'string' && Number.isFinite(Date.parse(receipt.at));
}

function validFile(value: unknown): value is CommandReceiptFile {
    if (!value || typeof value !== 'object') return false;
    const file = value as Partial<CommandReceiptFile>;
    return file.version === 1 && Array.isArray(file.receipts)
        && file.receipts.length <= MAX_COMMAND_RECEIPTS && file.receipts.every(validReceipt);
}

/**
 * Durable, content-free ingress receipts for owner commands. A successful claim is persisted before
 * the caller performs any side effect; unreadable state therefore fails commands closed while normal
 * chat remains available.
 */
export function createCommandReceiptStore(options: { dir: string; log?: (message: string) => void }) {
    mkdirSync(options.dir, { recursive: true });
    const path = join(options.dir, 'commands.json');
    let file: CommandReceiptFile | undefined;
    let unavailable: Error | undefined;
    try {
        file = readJsonOr<CommandReceiptFile>(path, { version: 1, receipts: [] }, options.log, {
            validate: validFile,
            invalid: 'throw',
            label: 'QQ 命令收据',
        });
    } catch (error) {
        unavailable = error instanceof Error ? error : new Error(String(error));
        options.log?.(`QQ 命令收据不可用，命令将安全暂停：${unavailable.message}`);
    }

    return {
        claim(userId: number, messageId: number, now = new Date()): boolean {
            if (unavailable || !file) throw unavailable ?? new Error('QQ 命令收据不可用');
            if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(messageId) || messageId < 0 || !Number.isFinite(now.getTime())) {
                throw new Error('QQ 命令收据参数无效');
            }
            const cutoff = now.getTime() - COMMAND_RECEIPT_TTL_MS;
            const retained = file.receipts.filter(receipt => Date.parse(receipt.at) >= cutoff);
            if (retained.some(receipt => receipt.userId === userId && receipt.messageId === messageId)) return false;
            const next: CommandReceiptFile = {
                version: 1,
                receipts: [...retained, { userId, messageId, at: now.toISOString() }].slice(-MAX_COMMAND_RECEIPTS),
            };
            writeJsonAtomic(path, next);
            file = next;
            return true;
        },
    };
}
