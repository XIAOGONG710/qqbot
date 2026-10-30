import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { INSIGHTS_EXPORT_FILE, INSIGHTS_FILE } from '../src/life/diary-insights.ts';
import { FEELINGS_EXPORT_FILE } from '../src/emotion/feeling-export.ts';
import { REVIEW_FILE } from '../src/emotion/feeling-review.ts';
import { SPEECH_FEEDBACK_FILE } from '../src/language/speech-feedback.ts';
import { SPEECH_NOTES_FILE } from '../src/language/speech-notes.ts';
import { SELF_PURSUITS_FILE } from '../src/life/self-pursuits.ts';
import { DEFAULTS, type AppConfig } from '../src/platform/config.ts';
import { isPrivateFile, PEEK_COMMANDS, PEEK_OFF_NOTICE, PRIVATE_FILES, peekRefused } from '../src/platform/private-space.ts';

const cfg = (patch: Partial<AppConfig>) => patch as AppConfig;
const ALL_ON = { pursuits: true, selfPursuits: true, speechNotes: true, herFeelings: true, diaryInsights: true };

describe('她的私人空间（ADR 0200）', () => {
    test('ownerPeek 关着：四条念她私人内容的命令都被拦（功能开着时）；开着不拦', () => {
        for (const { command } of PEEK_COMMANDS) {
            assert.equal(peekRefused(command, cfg({ ...ALL_ON, ownerPeek: false })), true, command);
            assert.equal(peekRefused(command, cfg({ ...ALL_ON, ownerPeek: true })), false, command);
        }
        assert.deepEqual(PEEK_COMMANDS.map(entry => entry.command), ['/追求', '/说话习惯', '/心境', '/自我认识']);
    });

    test('对应的功能没开，命令还是普通的话（不拦）；追求要 pursuits 和 selfPursuits 都开', () => {
        assert.equal(peekRefused('/心境', cfg({ ...ALL_ON, herFeelings: false, ownerPeek: false })), false);
        assert.equal(peekRefused('/自我认识', cfg({ ...ALL_ON, diaryInsights: false, ownerPeek: false })), false);
        assert.equal(peekRefused('/说话习惯', cfg({ ...ALL_ON, speechNotes: false, ownerPeek: false })), false);
        assert.equal(peekRefused('/追求', cfg({ ...ALL_ON, selfPursuits: false, ownerPeek: false })), false);
        assert.equal(peekRefused('/追求', cfg({ ...ALL_ON, pursuits: false, ownerPeek: false })), false);
    });

    test('不在这四条里的不拦：设定账本、说话趋势、他自己的标记、为什么、普通的话、空', () => {
        for (const text of ['/设定', '/说话趋势', '/像AI', '/像真人', '/为什么', '/心境 呢', '在吗', '', undefined]) {
            assert.equal(peekRefused(text, cfg({ ...ALL_ON, ownerPeek: false })), false, String(text));
        }
    });

    test('线上默认是关：不配也不给看', () => {
        assert.equal(DEFAULTS.ownerPeek, false);
    });

    test('那句固定的话不念任何她的内容', () => {
        assert.match(PEEK_OFF_NOTICE, /ownerPeek/);
        assert.ok(PEEK_OFF_NOTICE.length < 60);
    });

    test('私人文件清单和各功能真正用的文件名对得上（改了文件名这里会红）；他自己标的话不在里面', () => {
        assert.deepEqual([...PRIVATE_FILES].sort(), [SPEECH_NOTES_FILE, INSIGHTS_FILE, REVIEW_FILE, SELF_PURSUITS_FILE, INSIGHTS_EXPORT_FILE, FEELINGS_EXPORT_FILE].sort());
        assert.equal(isPrivateFile(SPEECH_FEEDBACK_FILE), false);
        assert.equal(isPrivateFile('diary.json'), false);
        assert.equal(isPrivateFile(SPEECH_NOTES_FILE), true);
    });
});
