// 以后要加的人：运行时读 <dataDir>/others.json，合并进名单，不用改代码。
// 也留给别的适配器/脚本写这个文件的接口。
import { join } from 'node:path'
import { readJsonOr } from '../memory/json-file.ts'
import { CONTACT_TIERS, type Contact, type ContactTier } from '../platform/config.ts'

export interface OtherPerson {
    qq: number;
    name: string;
    tier?: ContactTier;
    /** 给提示词用的一句话，比如“大学同学，最近在准备考研” */
    note?: string;
}

interface OthersFile {
    people?: OtherPerson[];
}

const VALID_TIERS = new Set<string>(CONTACT_TIERS);

/** 读动态联系人；坏文件/坏条目跳过，不影响启动 */
export function loadOthers(dataDir: string, existing: readonly Contact[], log?: (message: string) => void): Contact[] {
    const path = join(dataDir, 'others.json');
    const data = readJsonOr<OthersFile>(path, {}, log);
    const people = Array.isArray(data.people) ? data.people : [];
    const seen = new Set(existing.map(contact => contact.qq));
    const out: Contact[] = [];
    for (const person of people) {
        const qq = Number(person?.qq);
        if (!Number.isSafeInteger(qq) || qq <= 0) continue;
        if (seen.has(qq)) continue;
        const name = String(person.name || '').trim();
        if (!name) continue;
        const tier = VALID_TIERS.has(String(person.tier)) ? person.tier as ContactTier : 'classmate';
        seen.add(qq);
        out.push({
            qq,
            name,
            tier,
            ...(person.note ? { persona: String(person.note).slice(0, 200) } : {}),
        } as Contact);
    }
    return out;
}
