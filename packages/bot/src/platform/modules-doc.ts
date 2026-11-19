// 由 modules.ts 生成 docs/modules/ 下的文档（ADR 0122）。纯函数：输入模块表、功能总表、ADR 文件名清单，输出 { 文件名: 内容 }。
// ops/modules-doc.ts 负责读 ADR 目录并写文件；modules.test.ts 核对写出来的文件和这里生成的一致。

import { FEATURES } from './features.ts';
import { MODULES, type ModuleDef } from './modules.ts';

const adrLink = (number: string, adrFiles: readonly string[]) => {
    const file = adrFiles.find(name => name.startsWith(`${number}-`));
    return file ? `[ADR ${number}](../adr/${file})` : `ADR ${number}`;
};

const moduleFeatures = (module: ModuleDef) => FEATURES.filter(feature => module.featureKeys ? module.featureKeys.includes(feature.key) : module.groups.includes(feature.group));

function moduleDoc(module: ModuleDef, adrFiles: readonly string[]): string {
    const switches = moduleFeatures(module);
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
            ? ['| 配置 | 功能 | ADR |', '| --- | --- | --- |', ...switches.map(feature => `| \`${feature.key}\` | ${feature.label}${feature.kind === 'mode' ? '（模式）' : ''}${feature.description ? `：${feature.description}` : ''} | ${feature.adr ? adrLink(feature.adr, adrFiles) : ''} |`)]
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
    '按 [ADR 0336](../adr/0336-interpreter-executor-modules.md)，运行时是「一个解释器、一个执行器，其余都是解释器的模块」：一轮回复的模块、定时任务都经解释器，副作用经执行器。',
    '每个开关只在 `platform/features.ts` 定义一次：状态页、这里的开关表、Koishi 配置页的说明和下拉选项都从它生成；文件归属、职责和指标在 `platform/modules.ts`。',
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
        ...MODULES.map(module => `| [${module.name}](${module.id}.md) | ${module.scope} | ${moduleFeatures(module).length} |`),
        '',
        '## 加一个新功能时',
        '',
        '1. 找它属于哪个模块（拿不准就看它改的是“她怎么说”还是“她什么时候说”还是“她过着什么日子”）；新文件加进 `platform/modules.ts` 的 `files`；',
        '2. 在 `platform/features.ts` 登记它的开关，连同配置页说明 `detail`（几档的还有 `choices`），Koishi 插件里加一行 `toggle(\'键\')` / `choice(\'键\')`（`dashboard.test.ts`、`feature-schema.test.ts` 会核对）；',
        '3. 写 ADR，写测试，真模型模拟；周报里能看到它有没有在发生（日志计数）；',
        '4. 重新生成这份文档。',
        '',
        ...NEXT_STEPS,
        '',
    ].join('\n');
    return docs;
}
