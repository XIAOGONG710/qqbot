import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSource, SECTION_KEYS } from '../src/source.ts';

// 全合成源资料，不读取角色源或生成角色卡。
function source(day: unknown) {
    return {
        persona: {
            name: '合成角色', identity: '合成身份', personality: '合成性格', reply_style: '合成风格',
            redlines: { keywords: [], note: '合成底线' }, traits: {}, social: {},
            sections: { ...Object.fromEntries(SECTION_KEYS.map(key => [key, {}])), dates: { anniversary: { text: '纪念日', tiers: [], day } } },
        },
        scenes: [], tiers: { discreet: { text: '合成分寸' }, tiers: [] },
        schedule: {
            sleep: '23:00', wakeup: { early: '07:00', lazy: '09:00' }, periods: {},
            semester: { start: '2026-09-01', weeks: 16 }, holidays: [], makeups: [], courses: [], free: [],
            course_detail: { tiers: [] }, where: { by_tier: [] },
            kinds: Object.fromEntries(['hard', 'machine', 'water', 'pe'].map(kind => [kind, { label: '合成课型' }])),
        },
    };
}

test('源重要日期拒绝永不出现的公历月日，农历最多30日', () => {
    for (const date of ['02-30', '02-31', '04-31', '06-31', '09-31', '11-31']) {
        assert.throws(() => checkSource(source({ name: '合成日子', date })), /persona.yml.*anniversary.day.date.*有效月日/);
    }
    for (const lunar of ['01-31', '02-31', '12-31']) {
        assert.throws(() => checkSource(source({ name: '合成日子', lunar })), /persona.yml.*anniversary.day.lunar.*有效月日/);
    }
});

test('源月日规则保留公历闰日周年与农历各月30日，不猜测特定年份', () => {
    const limits = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let month = 1; month <= 12; month++) {
        for (const key of ['date', 'lunar'] as const) {
            const value = `${String(month).padStart(2, '0')}-${key === 'date' ? limits[month - 1] : 30}`;
            const checked = checkSource(source({ name: '合成日子', [key]: value }));
            assert.equal(checked.persona.sections.dates.anniversary!.day![key], value);
        }
    }
    assert.equal(checkSource(source({})).persona.sections.dates.anniversary!.day, undefined);
});

test('源月日错误只报字段和格式，不回显误填正文', () => {
    for (const key of ['date', 'lunar'] as const) {
        const marker = 'SYNTHETIC_PRIVATE_DAY';
        assert.throws(() => checkSource(source({ name: '合成日子', [key]: marker })), error =>
            error instanceof Error && error.message.includes(`anniversary.day.${key}`) && !error.message.includes(marker));
    }
});
