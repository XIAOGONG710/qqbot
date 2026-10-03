// 读取 characters/<角色>/legacy/ 下的旧项目 TOML。只读，不改原文件。

import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

export type Table = Record<string, unknown>;

export function readToml(path: string): Table {
    return parse(readFileSync(path, 'utf8')) as Table;
}

export function isTable(value: unknown): value is Table {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function getTable(parent: Table, key: string, where: string): Table {
    const value = parent[key];
    if (!isTable(value)) throw new Error(`${where}.${key} 应为表`);
    return value;
}

export function getString(parent: Table, key: string, where: string): string {
    const value = parent[key];
    if (typeof value !== 'string') throw new Error(`${where}.${key} 应为字符串`);
    return value.trim();
}

export function getStringArray(parent: Table, key: string, where: string): string[] {
    const value = parent[key];
    if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) {
        throw new Error(`${where}.${key} 应为字符串数组`);
    }
    return value.map(x => x.trim());
}

/** speech_library.toml 的一个 [[scenes]] */
export interface Scene {
    id: string;
    family: string;
    kind: string;
    tier: string[];
    trigger: string[];
    examples: string[];
    avoid: string[];
    source: string;
}

export function readScenes(path: string): Scene[] {
    const lib = readToml(path);
    const scenes = lib.scenes;
    if (!Array.isArray(scenes)) throw new Error(`${path}: 缺少 [[scenes]]`);
    return scenes.map((raw: unknown, i) => {
        const where = `scenes[${i}]`;
        if (!isTable(raw)) throw new Error(`${where} 应为表`);
        return {
            id: getString(raw, 'id', where),
            family: getString(raw, 'family', where),
            kind: getString(raw, 'kind', where),
            tier: getStringArray(raw, 'tier', where),
            trigger: getStringArray(raw, 'trigger', where),
            examples: getStringArray(raw, 'examples', where),
            avoid: getStringArray(raw, 'avoid', where),
            source: getString(raw, 'source', where),
        };
    });
}
