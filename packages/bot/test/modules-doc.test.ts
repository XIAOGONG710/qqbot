import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FEATURES } from '../src/platform/features.ts';
import { MODULES } from '../src/platform/modules.ts';
import { moduleDocs } from '../src/platform/modules-doc.ts';

// 直接测 modules-doc.ts 这个纯函数：输入 ADR 文件名清单，输出 { 文件名: 内容 }。
// 断言生成文本里具体有哪些标题、文件行、开关行、ADR 链接，而不是只断言「有东西」。
const ADR_FILES = ['0122-module-map.md', '0115-interruptions.md', '0336-interpreter-executor-modules.md'];
const docs = moduleDocs(ADR_FILES);
const language = MODULES.find(module => module.id === 'language')!;
const emotion = MODULES.find(module => module.id === 'emotion')!;
const languageSwitchCount = FEATURES.filter(feature => feature.group === '说话').length;

describe('moduleDocs（ADR 0122 文档生成）', () => {
    test('输出每个模块一份 .md 加一份 README.md，不多不少', () => {
        assert.equal(Object.keys(docs).length, MODULES.length + 1);
        for (const module of MODULES) assert.ok(`${module.id}.md` in docs, `${module.id}.md`);
        assert.ok('README.md' in docs);
    });

    test('模块文档含具体标题、说明、真实文件行、开关表和指标', () => {
        const text = docs['language.md']!;
        assert.ok(text.startsWith(`# 模块：${language.name}`));
        assert.ok(text.includes('> 由 `packages/bot/src/platform/modules.ts` 清单生成'));
        assert.ok(text.includes('不要手改；改清单后重新生成。'));
        assert.ok(text.includes(`**管什么**：${language.scope}`));
        assert.ok(text.includes('## 文件（`packages/bot/src/` 下）'));
        assert.ok(text.includes('- `language/tokens.ts`'));
        assert.ok(text.includes('- `modules/interruptions.ts`'));
        assert.ok(text.includes('## 开关'));
        assert.ok(text.includes('| 配置 | 功能 | ADR |'));
        assert.ok(text.includes('| --- | --- | --- |'));
        assert.ok(text.includes('| `herNo` |')); // 说话组的开关真的列进来了
        assert.ok(text.includes('ADR 0103')); // 没给 0103 的文件名时退化为纯文本
        assert.ok(text.includes('## 看它有没有变好'));
        assert.ok(text.includes(language.metrics));
        assert.ok(text.includes('## 最相关的 ADR'));
    });

    test('ADR 链接：文件清单里有对应文件就生成相对链接，没有就退化成纯文本', () => {
        const text = docs['language.md']!;
        assert.ok(text.includes('[ADR 0115](../adr/0115-interruptions.md)'));
        assert.ok(text.includes('ADR 0111')); // 没给 0111 的文件名，退化为纯文本
        assert.ok(!text.includes('[ADR 0122')); // 0122 不在 language 的 adrs 里
        assert.ok(docs['platform.md']!.includes('[ADR 0336](../adr/0336-interpreter-executor-modules.md)'));

        const noLinks = moduleDocs([])['language.md']!;
        assert.ok(noLinks.includes('ADR 0115'));
        assert.ok(noLinks.includes('ADR 0111'));
        assert.ok(!noLinks.includes('](../adr/'));
    });

    test('有 featureKeys 的模块只列自己的开关，不按 groups 把别的组捞进来', () => {
        assert.deepEqual(emotion.groups, []);
        const text = docs['emotion.md']!;
        for (const key of emotion.featureKeys!) assert.ok(text.includes(`| \`${key}\` |`), key);
        assert.ok(!text.includes('| `rhythm` |')); // 说话组的开关，不在 emotion 的 featureKeys 里
        assert.ok(!text.includes('](../adr/')); // emotion 的 ADR 都没给文件
        assert.ok(text.includes('ADR 0102'));
        assert.ok(text.includes('ADR 0074'));
        assert.ok(text.includes('ADR 0073'));
    });

    test('adrFiles 里同一编号有多个文件时取第一个', () => {
        const first = moduleDocs(['0336-zzz.md', '0336-aaa.md']);
        assert.ok(first['platform.md']!.includes('[ADR 0336](../adr/0336-zzz.md)'));
        assert.ok(!first['platform.md']!.includes('0336-aaa.md'));
        // README 的「接下来」是固定文案，里的 0336 链接不随 adrFiles 变
        assert.ok(first['README.md']!.includes('[ADR 0336](../adr/0336-interpreter-executor-modules.md)'));
    });

    test('README 总览含逐模块表格、开关数、加功能的步骤和目录整理结语', () => {
        const readme = docs['README.md']!;
        assert.ok(readme.startsWith('# 模块总览'));
        assert.ok(readme.includes('> 由 `packages/bot/src/platform/modules.ts` 清单生成'));
        assert.ok(readme.includes('不要手改。'));
        assert.ok(readme.includes('| 模块 | 管什么 | 开关数 |'));
        assert.ok(readme.includes('| --- | --- | --- |'));
        for (const module of MODULES) {
            assert.ok(readme.includes(`| [${module.name}](${module.id}.md) | ${module.scope} |`), module.id);
        }
        assert.ok(readme.includes(`| [${language.name}](${language.id}.md) | ${language.scope} | ${languageSwitchCount} |`));
        assert.ok(readme.includes('## 加一个新功能时'));
        assert.ok(readme.includes('1. 找它属于哪个模块'));
        assert.ok(readme.includes('4. 重新生成这份文档。'));
        assert.ok(readme.includes('## 已完成的目录整理'));
        assert.ok(readme.includes('目录整理已经完成，不再作为待办。'));
        assert.ok(readme.includes('## 接下来'));
        assert.ok(readme.includes('[ADR 0336](../adr/0336-interpreter-executor-modules.md)'));
        assert.ok(readme.includes('每个开关只在 `platform/features.ts` 定义一次'));

        const noLinks = moduleDocs([])['README.md']!;
        assert.ok(noLinks.includes('按 [ADR 0336](../adr/0336-interpreter-executor-modules.md)，运行时是'));
        assert.ok(!moduleDocs([])['language.md']!.includes('](../adr/'));
    });
});
