// 在读的书（ADR 0015）作为解释器的模块（ADR 0263 第 5 步）：
// - assess：他最近提到了在读的书、或者她此刻正在看书（turn.facts.state 的空闲活动，她此刻的模块写），按这一轮用的卡算出书和进度，写进 turn.facts.books；
//   旧逻辑的出口检查拿其中的进度核对她说的第几章 / 一共几章（对不上重写一次），这一轮没放书就不核对。
// - contribute：往「此刻」块的 books 槽放那一行。
// 跟着「她自己的日子」（配置 herDays）开。挑书、算进度的规则都在 life/her-days.ts（readingSection），这里只是接线；
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 books 等场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { readingSection } from '../life/her-days.ts';

export interface BooksModuleOptions {
    /** 她自己的日子（配置 herDays） */
    herDays?: boolean;
}

export function booksModule(options: BooksModuleOptions = {}): Module {
    return {
        id: 'books',
        assess(turn) {
            const schedule = options.herDays ? turn.card?.schedule : undefined;
            if (!schedule) return;
            const { state } = turn.facts;
            const books = readingSection(schedule, turn.card!.books, turn.at, {
                history: turn.history, userName: turn.contact.name,
                ...(state?.activity.kind === 'free' ? { activity: state.activity.text } : {}),
            });
            if (books) turn.facts.books = books;
        },
        contribute(turn) {
            const { books } = turn.facts;
            return books ? [{ slot: 'books', text: books.text }] : [];
        },
    };
}
