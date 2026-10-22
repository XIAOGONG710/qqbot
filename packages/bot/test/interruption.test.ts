import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeInterruption, INTERRUPT_SHARE, INTERRUPT_WINDOW_MS, interruptionNow, LIVE_CHAT_MS, type WorldEventLite } from '../src/interruption.ts';

// ADR 0115：被第三方打断——聊天正在进行时，世界账里她那边恰好发生了一件小事
const base = new Date(2026, 9, 28, 22, 20).getTime();
const min = (n: number) => n * 60_000;
type Said = { role: 'user' | 'assistant'; content: string; time: string };
const said = (role: 'user' | 'assistant', ago: number, content: string, now = base): Said => ({ role, content, time: new Date(now - min(ago)).toISOString() });
const event = (agoMin: number, text = '宿舍查卫生，前一晚大家一起收拾了桌子', id = 'e1', now = base): WorldEventLite => ({ id, text, at: new Date(now - min(agoMin)) });

/** 找一个会触发的“他最后一句”（同一句每次一样，用来固定测试） */
function triggering(events: WorldEventLite[], build: (text: string) => Said[]): Said[] {
    for (let i = 0; i < 200; i++) {
        const history = build(`第 ${i} 句闲话`);
        if (interruptionNow(events, history, base)) return history;
    }
    throw new Error('找不到会触发的一句');
}

describe('被打断：什么时候算', () => {
    const chat = (lastText: string) => [said('user', 8, '在吗'), said('assistant', 7.5, '在呢'), said('user', 1, lastText)];

    test('聊天正在进行、小事发生在她上一次回话之后、不超过 INTERRUPT_WINDOW_MS：算；约 INTERRUPT_SHARE 的轮次真打断，同一句每次一样', () => {
        const events = [event(4)];
        const hits = Array.from({ length: 300 }, (_, i) => interruptionNow(events, chat(`第 ${i} 句闲话`), base)).filter(Boolean);
        assert.ok(hits.length > 300 * INTERRUPT_SHARE * 0.7 && hits.length < 300 * INTERRUPT_SHARE * 1.3, `300 轮里 ${hits.length}`);
        const history = triggering(events, chat);
        assert.deepEqual(interruptionNow(events, history, base), interruptionNow(events, history, base));
        assert.deepEqual(interruptionNow(events, history, base), { text: '宿舍查卫生，前一晚大家一起收拾了桌子', minutesAgo: 4 });
    });

    test('不算：小事发生在她上一次回话之前 / 超过窗口 / 在未来 / 聊天没在进行 / 她已经自己说过了', () => {
        const history = triggering([event(4)], chat0);
        function chat0(text: string): Said[] { return [said('user', 8, '在吗'), said('assistant', 7.5, '在呢'), said('user', 1, text)]; }
        assert.equal(interruptionNow([event(7.9)], history, base), undefined, '在她回话之前');
        assert.equal(interruptionNow([event(INTERRUPT_WINDOW_MS / 60_000 + 1)], [said('user', 20, '在吗'), said('assistant', 19, '在呢'), said('user', 1, '嗯')], base), undefined, '太久了');
        assert.equal(interruptionNow([event(-3)], history, base), undefined, '还没发生');
        const stale = [said('user', LIVE_CHAT_MS / 60_000 + 3, '在吗'), said('assistant', LIVE_CHAT_MS / 60_000 + 2.5, '在呢')];
        assert.equal(interruptionNow([event(4)], stale, base), undefined, '聊天没在进行');
        const told = [...history.slice(0, 2), said('assistant', 3, '刚宿舍在查卫生'), said('user', 1, history[2]!.content)];
        assert.equal(interruptionNow([event(4)], told, base), undefined, '她已经说过了');
        assert.equal(interruptionNow([], history, base), undefined);
    });

    test('有几件时取最近的一件', () => {
        const events = [event(5, '室友借了充电器', 'a'), event(2, '澡堂排了半天队', 'b')];
        const history = (() => { for (let i = 0; i < 300; i++) { const h = [said('user', 8, '在吗'), said('assistant', 7.5, '在呢'), said('user', 1, `第 ${i} 句`)]; if (interruptionNow(events, h, base)?.text === '澡堂排了半天队') return h; } throw new Error('x'); })();
        assert.equal(interruptionNow(events, history, base)!.text, '澡堂排了半天队');
    });

    test('提示词那一行：几分钟前、哪件事；先接他的话、顺带岔一下；细节不编；不给台词', () => {
        const line = describeInterruption({ text: '澡堂排了半天队', minutesAgo: 3 });
        assert.ok(line.includes('3 分钟前') && line.includes('澡堂排了半天队') && line.includes('先接他的话') && line.includes('没写的别编') && line.includes('等下'), line);
        assert.ok(describeInterruption({ text: 'x', minutesAgo: 0 }).includes('刚刚'));
    });
});
