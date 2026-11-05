import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createFeedbackChannel, FeedbackLog, locateTurn, parseFeedback, type FeedbackRow } from '../src/emotion/feedback.ts';
import { feedbackDigest, readFeedback } from '../src/emotion/feedback-digest.ts';

const at = new Date('2026-11-05T12:00:00Z');
const row = (id = 9): FeedbackRow => ({ at: at.toISOString(), label: 'fake', messageId: id, herMessageId: 1, her: ['合成答复'], context: [], tier: 'boyfriend' });
const fixture = (work: (dir: string) => void) => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-feedback-review-')); try { work(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('反馈只能评价当时已发生的话，引用不收未来连续气泡与上下文', () => {
 const past = { time: '2026-11-05T11:59:00Z', role: 'assistant' as const, content: '已发生', messageId: 1 };
 const future = { ...past, time: '2026-11-05T12:01:00Z', content: '未来', messageId: 2 };
 assert.equal(locateTurn([future], at), undefined); assert.equal(locateTurn([future], at, 2), undefined);
 assert.deepEqual(locateTurn([past, future], at, 1)!.her.map(message => message.content), ['已发生']);
 assert.ok(locateTurn([{ ...past, time: '2026-11-05T12:00:00.999Z' }], at), 'OneBot秒精度的同秒反馈仍有效');
 assert.equal(locateTurn([{ ...past, time: '2026-11-05T12:00:01.000Z' }], at), undefined);
 assert.equal(locateTurn([past], new Date(NaN), 1), undefined);
});

test('坏反馈行不占去重身份、不算数量，摘要不接受缺context或非字符串气泡', () => fixture(dir => {
 mkdirSync(join(dir, 'feedback')); const file = join(dir, 'feedback', '2026-11.jsonl');
 const malformed = [{ messageId: 9 }, { ...row(10), context: undefined }, { ...row(11), her: [1] }, null];
 writeFileSync(file, malformed.map(value => JSON.stringify(value)).join('\n') + '\n');
 const store = new FeedbackLog(dir); assert.equal(store.has(9), false);
 assert.deepEqual(readFeedback(dir), []); assert.match(feedbackDigest(malformed as FeedbackRow[], at, 7), /共 0 条/);
 assert.equal(store.record(row(), at), 1);
}));

test('四位低年份月文件可重启去重，坏尾行不吞掉下一条完整反馈', () => fixture(dir => {
 const low = new Date('0099-11-05T12:00:00Z'); const lowRow = { ...row(), at: low.toISOString() };
 new FeedbackLog(dir).record(lowRow, low);
 assert.equal(new FeedbackLog(dir).has(9), true);
 assert.ok(readFeedback(dir).some(item => item.messageId === 9));
 const file = join(dir, 'feedback', '2026-11.jsonl'); writeFileSync(file, '{"PRIVATE_PARTIAL":');
 new FeedbackLog(dir).record(row(10), at);
 assert.equal(new FeedbackLog(dir).has(10), true); assert.equal(readFeedback(dir).filter(item => item.messageId === 10).length, 1);
 assert.match(feedbackDigest([lowRow], low, 7), /0099-11-05/);
}));

test('畸形文本段不能强转成反馈命令，无效时间/身份不产生坏记录', () => fixture(dir => {
 assert.equal(parseFeedback([{ type: 'text', data: { text: ['假'] } }]), undefined);
 const channel = createFeedbackChannel(dir, () => {});
 const history = [{ time: '2026-11-05T11:59:00Z', role: 'assistant' as const, content: '合成答复', messageId: 1 }];
 assert.equal(channel.consume(1, 'boyfriend', '假', NaN, at, history), false);
 assert.equal(channel.consume(1, 'boyfriend', '假', 2, new Date(NaN), history), false);
}));

test('CLI缺少参数值或未知参数在读取默认目录前失败，IO错误不输出私密路径', () => fixture(dir => {
 const cli = join(import.meta.dirname, '../src/emotion/feedback-digest-cli.ts');
 for (const args of [['--dir'], ['--days'], ['--unknown'], ['--days', '1e308'], ['--dir', '--days', '7']]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 2, args.join(' ')); assert.equal(result.stdout, '');
 }
 const obstacle = join(dir, 'PRIVATE_PATH_MARKER'); writeFileSync(obstacle, 'not a directory');
 const result = spawnSync(process.execPath, [cli, '--dir', obstacle], { cwd: dir, encoding: 'utf8', timeout: 2000 });
 assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /PRIVATE_PATH_MARKER/);
}));

test('追加前失败可恢复重试，追加已发生后报错不会重复记录或泄漏私密IO信息', () => {
 for (const after of [false, true]) fixture(dir => {
  const logs: string[] = []; const channel = createFeedbackChannel(dir, line => logs.push(line));
  const history = [{ time: '2026-11-05T11:59:00Z', role: 'assistant' as const, content: '合成答复', messageId: 1 }];
  const original = fs.appendFileSync;
  fs.appendFileSync = ((...args: Parameters<typeof fs.appendFileSync>) => { if (after) original(...args); throw Object.assign(new Error('PRIVATE_APPEND_FAILURE'), { code: 'EIO' }); }) as typeof original;
  syncBuiltinESMExports();
  try { try { channel.consume(1, 'boyfriend', '假', 9, at, history); } catch { /* retry after restoring the store */ } }
  finally { fs.appendFileSync = original; syncBuiltinESMExports(); }
  assert.equal(channel.consume(1, 'boyfriend', '假', 9, at, history), true);
  assert.equal(readFeedback(dir).filter(item => item.messageId === 9).length, 1);
  assert.ok(logs.every(line => !line.includes('PRIVATE_APPEND_FAILURE')));
 });
});

test('相同短消息ID跨联系人/跨源时间独立记录，同一事实重投及重启只记一次', () => fixture(dir => {
 const channel = createFeedbackChannel(dir, () => {}); const id = 1562800174;
 const history = [{ time: '2026-11-05T11:59:00Z', role: 'assistant' as const, content: '合成答复', messageId: 1 }];
 for (const qq of [2881, 42066]) assert.equal(channel.consume(qq, 'boyfriend', '假', id, at, history), true);
 const later = new Date(at.getTime() + 1000);
 assert.equal(channel.consume(2881, 'boyfriend', '像', id, later, history), true);
 const again = createFeedbackChannel(dir, () => {});
 for (const [qq, time] of [[2881, at], [42066, at], [2881, later]] as const) assert.equal(again.consume(qq, 'boyfriend', '假', id, time, []), true);
 const rows = readFeedback(dir); assert.equal(rows.length, 3);
 assert.deepEqual(rows.map(item => (item as FeedbackRow & { contact?: number }).contact), [2881, 42066, 2881]);
 assert.equal(new FeedbackLog(dir).has(id), true, '旧has(id)仍表示这个id曾出现');
 assert.doesNotMatch(feedbackDigest(rows, later, 7), /2881|42066/);
}));

test('无contact旧行只按同源时间及ID保守去重，旧重复行不重复计数', () => fixture(dir => {
 mkdirSync(join(dir, 'feedback')); const file = join(dir, 'feedback', '2026-11.jsonl');
 writeFileSync(file, `${JSON.stringify(row())}\n${JSON.stringify(row())}\n`);
 assert.equal(readFeedback(dir).length, 1);
 const labels: string[] = []; const channel = createFeedbackChannel(dir, line => labels.push(line));
 assert.equal(channel.consume(42, 'boyfriend', '假', 9, at, []), true);
 const later = new Date(at.getTime() + 1000); const history = [{ time: at.toISOString(), role: 'assistant' as const, content: '合成答复', messageId: 1 }];
 assert.equal(channel.consume(42, 'boyfriend', '假', 9, later, history), true);
 assert.equal(readFeedback(dir).length, 2);
 assert.ok(labels.some(line => line.includes('本月第 2 条')));
 assert.match(feedbackDigest(readFeedback(dir), later, 7), /共 2 条/);
}));

test('追加失败不能因另一联系人存在同短ID就误报本条已成功', () => fixture(dir => {
 const channel = createFeedbackChannel(dir, () => {}); const history = [{ time: '2026-11-05T11:59:00Z', role: 'assistant' as const, content: '合成答复', messageId: 1 }];
 channel.consume(1, 'boyfriend', '假', 9, at, history);
 const original = fs.appendFileSync;
 fs.appendFileSync = (() => { throw new Error('synthetic append failed'); }) as typeof original; syncBuiltinESMExports();
 try { assert.throws(() => channel.consume(2, 'boyfriend', '假', 9, at, history), /写入失败/); }
 finally { fs.appendFileSync = original; syncBuiltinESMExports(); }
 assert.equal(channel.consume(2, 'boyfriend', '假', 9, at, history), true); assert.equal(readFeedback(dir).length, 2);
}));

test('摘要截取大气泡不展开整个字符串，在受限堆中仍输出有限前缀', () => {
 const url = pathToFileURL(join(import.meta.dirname, '../src/emotion/feedback-digest.ts')).href;
 const source = `import {feedbackDigest} from ${JSON.stringify(url)};const at=new Date('2026-11-05T12:00:00Z');const r={at:at.toISOString(),label:'fake',messageId:1,herMessageId:1,her:['合'.repeat(8000000)],context:[],tier:'boyfriend'};const s=feedbackDigest([r],at,7);if(s.length>1000||!s.includes('…'))throw Error('bad clipping');console.log('ok');`;
 const result = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
 assert.equal(result.status, 0, result.stderr.slice(-200)); assert.equal(result.stdout.trim(), 'ok');
});

test('有界摘要保留代码点与原来的空白折叠/省略号边界', () => {
 const summary = feedbackDigest([{ ...row(), her: ['😀'.repeat(81), '😀'.repeat(79) + ' \t\n '] }], at, 7);
 assert.ok(summary.includes(`「${'😀'.repeat(80)}…」`));
 assert.ok(summary.includes(`「${'😀'.repeat(79)} 」`));
});
