// 由 modules.ts 生成 docs/modules/ 下的文档（ADR 0122）。纯函数：输入模块表、功能总表、ADR 文件名清单，输出 { 文件名: 内容 }。
// ops/modules-doc.ts 负责读 ADR 目录并写文件；modules.test.ts 核对写出来的文件和这里生成的一致。

import { FEATURES } from './features.ts';
import { MODULES, type ModuleDef } from './modules.ts';

const adrLink = (number: string, adrFiles: readonly string[]) => {
    const file = adrFiles.find(name => name.startsWith(`${number}-`));
    return file ? `[ADR ${number}](../adr/${file})` : `ADR ${number}`;
};

function moduleDoc(module: ModuleDef, adrFiles: readonly string[]): string {
    const switches = FEATURES.filter(feature => module.groups.includes(feature.group));
    const lines = [
        `# 模块：${module.name}`,
        '',
        '> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。',
        '',
        `**管什么**：${module.scope}`,
        '',
        '## 文件（`packages/bot/src/` 下）',
        '',
        ...module.files.map(file => `- \`${file}\``),
        '',
        '## 开关',
        '',
        ...(switches.length
            ? ['| 配置 | 功能 | ADR |', '| --- | --- | --- |', ...switches.map(feature => `| \`${feature.key}\` | ${feature.label}${feature.kind === 'mode' ? '（模式）' : ''} | ${feature.adr ? adrLink(feature.adr, adrFiles) : ''} |`)]
            : ['这个模块没有独立的开关（它是底线 / 基础设施，永远开着）。']),
        '',
        '## 看它有没有变好',
        '',
        module.metrics,
        '',
        '## 最相关的 ADR',
        '',
        module.adrs.map(number => adrLink(number, adrFiles)).join('、'),
        '',
    ];
    return lines.join('\n');
}

const NEXT_STEPS = [
    '## 已完成的目录整理',
    '',
    '多数源文件已按职责迁入 `src/language/`、`src/life/`、`src/platform/` 等子目录；当前文件归属以模块清单为准。目录整理已经完成，不再作为待办。',
    '',
    '## 接下来',
    '',
    '1. **每个模块自己的配置段**：`platform/config.ts` 里仍有许多平铺的开关；可以按模块分段，同时保留平铺写法能用。',
    '2. **提示词由各模块“贡献”**：`platform/contact.ts` 仍集中组装提示词；可改成每个模块提供一个“这一轮我要往提示词里放什么”的函数，由 `contact.ts` 负责排序和拼接。这一步改动较大，做完要用回放核对提示词行为。',
    '',
    '这两项仍是后续架构计划，不因目录整理完成而视为完成；优先顺序取决于模块配置与提示词维护的实际需要。',
];

export function moduleDocs(adrFiles: readonly string[]): Record<string, string> {
    const docs: Record<string, string> = {};
    for (const module of MODULES) docs[`${module.id}.md`] = moduleDoc(module, adrFiles);
    docs['README.md'] = [
        '# 模块总览',
        '',
        '> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改。',
        '',
        '模块总表最初只做分类和文档（ADR 0122）；目前多数源文件已迁入职责对应的子目录。`packages/bot/src/platform/modules.ts` 记录各模块的文件归属、职责和验证指标。',
        '`modules.test.ts` 保证：每个 `.ts` 文件恰好属于一个模块、清单里的文件都真实存在、这里的文档和清单一致。',
        '',
        '| 模块 | 管什么 | 开关数 |',
        '| --- | --- | --- |',
        ...MODULES.map(module => `| [${module.name}](${module.id}.md) | ${module.scope} | ${FEATURES.filter(feature => module.groups.includes(feature.group)).length} |`),
        '',
        '## 加一个新功能时',
        '',
        '1. 找它属于哪个模块（拿不准就看它改的是“她怎么说”还是“她什么时候说”还是“她过着什么日子”）；新文件加进 `platform/modules.ts` 的 `files`；',
        '2. 在 `platform/features.ts` 登记它的开关（`dashboard.test.ts` 会核对没有漏掉的）；',
        '3. 写 ADR，写测试，真模型模拟；周报里能看到它有没有在发生（日志计数）；',
        '4. 重新生成这份文档。',
        '',
        ...NEXT_STEPS,
        '',
    ].join('\n');
    return docs;
}
