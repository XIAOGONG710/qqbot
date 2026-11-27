import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { INSIGHTS_EXPORT_FILE, INSIGHTS_FILE } from '../src/life/diary-insights.ts';
import { FEELINGS_EXPORT_FILE } from '../src/emotion/feeling-export.ts';
import { SELF_FILE } from '../src/life/self-types.ts';
import { REVIEW_FILE } from '../src/emotion/feeling-review.ts';
import { SPEECH_FEEDBACK_FILE } from '../src/language/speech-feedback.ts';
import { SPEECH_NOTES_FILE } from '../src/language/speech-notes.ts';
import { TAKES_FILE } from '../src/life/reading-takes.ts';
import { QUESTIONS_FILE } from '../src/life/open-questions.ts';
import { GUESSES_FILE } from '../src/life/her-guesses.ts';
import { REVIEW_FILE as CHAT_REVIEW_FILE } from '../src/language/chat-review.ts';
import { SELF_PURSUITS_FILE } from '../src/life/self-pursuits.ts';
import { isPrivateFile, PRIVATE_FILES, PRIVATE_PATTERNS } from '../src/platform/private-space.ts';
import { MANIFEST_FILE, manifestFileName } from '../src/platform/prompt-manifest.ts';

describe('她的私人空间（ADR 0200）', () => {
    test('私人文件清单和各功能真正用的文件名对得上（改了文件名这里会红）；他自己标的话不在里面', () => {
        assert.deepEqual([...PRIVATE_FILES].sort(), [SPEECH_NOTES_FILE, INSIGHTS_FILE, REVIEW_FILE, SELF_PURSUITS_FILE, INSIGHTS_EXPORT_FILE, FEELINGS_EXPORT_FILE, SELF_FILE, TAKES_FILE, QUESTIONS_FILE, GUESSES_FILE, CHAT_REVIEW_FILE].sort());
        assert.equal(isPrivateFile(SPEECH_FEEDBACK_FILE), false);
        assert.equal(isPrivateFile('diary.json'), false);
        assert.equal(isPrivateFile(SPEECH_NOTES_FILE), true);
    });

    test('按天滚动的私人文件：提示词指纹清单（只有哈希，但短行能穷举，同样不带）；和写清单用的是同一个名字规则', () => {
        assert.ok(PRIVATE_PATTERNS.includes(MANIFEST_FILE));
        assert.equal(isPrivateFile(manifestFileName('2026-11-22')), true);
        assert.equal(isPrivateFile('notebook-learning-10002.json'), true);
        assert.equal(isPrivateFile('notebook-learning.ts'), false);
        assert.equal(isPrivateFile('2026-11-22.log'), false, '按天日志不在这里（另有隐私审计）');
    });
});
