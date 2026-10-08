// source/scenes.yml 的场景 → SillyTavern 世界书。
//
// 场景按场景档（tiers）区分，陌生人档的话绝不能出现在对男朋友的回复里。
// ST 的世界书没有“按聊天对象过滤”，所以每个档位单独生成一本世界书，只收它的场景档里的场景。

import { textFor } from './persona-to-card.ts';
import { SECTION_KEYS, type PersonaSource, type SceneSource, type TextField } from './source.ts';
import { newWorldInfoEntry, WORLD_INFO_POSITION, type WorldInfoBook } from './st-format.ts';

export function sceneContent(scene: SceneSource): string {
    const quote = (lines: string[]) => lines.map(x => `「${x}」`).join('');
    return `[场景参考·${scene.kind}] 类似的话你可能会这样回：${quote(scene.examples)}；不要回：${quote(scene.avoid)}。只学语气和长短，别照抄。`;
}

/** label：场景档；drop：按 id 去掉的场景（例如名单外好友不要「被问是不是 AI 就否认」的场景） */
export function scenesToLorebook(scenes: SceneSource[], label: string, drop: string[] = []): WorldInfoBook {
    const ofTier = scenes.filter(scene => scene.tiers.includes(label));
    if (ofTier.length === 0) throw new Error(`没有场景档为 ${label} 的场景`);
    for (const id of drop) {
        if (!ofTier.some(scene => scene.id === id)) throw new Error(`场景档 ${label} 的场景里没有要去掉的 ${id}`);
    }
    const selected = ofTier.filter(scene => !drop.includes(scene.id));

    const entries: WorldInfoBook['entries'] = {};
    selected.forEach((scene, uid) => {
        entries[String(uid)] = newWorldInfoEntry(uid, {
            key: scene.trigger,
            comment: `${scene.kind}（${scene.id}）`,
            content: sceneContent(scene),
            // 放在角色设定之后、聊天记录之前
            position: WORLD_INFO_POSITION.after,
            // 固定关掉整词匹配，不跟随 ST 的全局设置：整词匹配按 \W 判边界，
            // 中文字符算边界，但关键词紧挨英文或数字（如“上分666”）时会匹配失败
            matchWholeWords: false,
        });
    });
    return { entries };
}

/**
 * 带触发词的设定（persona.yml 的 traits、sections 里写了 keys）：这一档看得到的接在场景后面，最近的消息说到这些词时才进提示词（DSH 诊断 2.4）。
 * 文字照这一档的说法（variants）
 */
export function withKeyedTraits(book: WorldInfoBook, persona: PersonaSource, tier: string): WorldInfoBook {
    const entries = { ...book.entries };
    let uid = Object.keys(entries).length;
    const fields: [string, TextField][] = [
        ...Object.entries(persona.traits),
        ...SECTION_KEYS.flatMap(key => Object.entries(persona.sections[key])),
    ];
    for (const [name, field] of fields) {
        if (!field.keys || !(field.tiers?.includes(tier) ?? true)) continue;
        entries[String(uid)] = newWorldInfoEntry(uid, {
            key: field.keys,
            comment: `设定·说到才想起（persona-${name}）`,
            content: textFor(field, tier),
            position: WORLD_INFO_POSITION.after,
            matchWholeWords: false,
        });
        uid++;
    }
    return { entries };
}
