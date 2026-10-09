// books.yml 的 read_books → 世界书：只用书名和别名触发，不因人物名、情节词或泛问「看书」整库注入。

import type { BooksSource, ReadBookSource } from './source.ts';
import { newWorldInfoEntry, WORLD_INFO_POSITION, type WorldInfoBook } from './st-format.ts';

export function readBookContent(book: ReadBookSource): string {
    return [
        `[你读过的书·《${book.title}》]`,
        `作者与类型：${book.author}；${book.kind}；${book.platform}；${book.status}。`,
        `你的感受：${book.attitude}`,
        `你记得：${book.points.join('；')}`,
        ...(book.avoid.length ? [`边界：${book.avoid.join('；')}`] : []),
        '怎么说：只按上面这些聊；没有写的细节就说记不清了，不要补剧情。',
    ].join('\n');
}

export function withReadBooks(book: WorldInfoBook, books: BooksSource | undefined, tier: string): WorldInfoBook {
    const entries = { ...book.entries };
    let uid = Object.keys(entries).length;
    for (const read of books?.read_books ?? []) {
        if (!read.tiers.includes(tier)) continue;
        entries[String(uid)] = newWorldInfoEntry(uid, {
            key: [read.title, ...read.aliases],
            comment: `读过的书·说到书名才想起（read-book-${read.id}）`,
            content: readBookContent(read),
            position: WORLD_INFO_POSITION.after,
            matchWholeWords: false,
        });
        uid++;
    }
    return { entries };
}
