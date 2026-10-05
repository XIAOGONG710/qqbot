// 「她自己的日子」（ADR 0015）：source/moods.yml、books.yml → 每一档卡片的 qqbot 扩展。
// 这里只做档位裁剪和字段名转换；日期抽心情、算进度等行为在 packages/bot 的纯函数里。

import type { CharacterSource } from './source.ts';
import type { CardBook, CardMood } from './st-format.ts';

export function moodsForTier(source: CharacterSource, tier: string): CardMood[] | undefined {
    if (!source.moods) return undefined;
    const moods = source.moods.moods
        .filter(mood => mood.style.tiers?.includes(tier))
        .map(mood => ({
            name: mood.name,
            weight: mood.weight,
            style: mood.style.variants?.find(variant => variant.tiers.includes(tier))?.text ?? mood.style.text,
            when: mood.when.map(condition => ({ ...condition })),
        }));
    return moods.length ? moods : undefined;
}

export function booksForTier(source: CharacterSource, tier: string): CardBook[] | undefined {
    if (!source.books) return undefined;
    const books = source.books.books
        .filter(book => book.tiers.includes(tier))
        .map(book => ({
            id: book.id,
            title: book.title,
            aliases: [...book.aliases],
            author: book.author,
            kind: book.kind,
            platform: book.platform,
            status: book.status,
            ...(book.activity ? { activity: { ...book.activity } } : {}),
            ...(book.total ? { total: { amount: book.total.amount, unit: book.total.unit } } : {}),
            progress: {
                startDay: book.progress.start_day,
                start: book.progress.start,
                everyDays: book.progress.every_days,
                amount: book.progress.amount,
                unit: book.progress.unit,
                ...(book.progress.max !== undefined ? { max: book.progress.max } : {}),
                state: book.progress.state ?? 'reading',
            },
            attitude: book.attitude,
            unreadKeywords: [...book.unread_keywords],
            nodes: book.nodes
                .filter(node => !node.tiers || node.tiers.includes(tier))
                .map(node => ({ id: node.id, topic: node.topic, from: node.from, keywords: [...node.keywords], points: [...node.points] })),
        }));
    return books.length ? books : undefined;
}
