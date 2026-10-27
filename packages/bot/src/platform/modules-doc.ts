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
        '> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。',
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
    '## 接下来（都没做）',
    '',
    '1. **把文件真的挪进子目录**（`src/language/`、`src/life/`……）：只改 import 路径，测试当护栏；最好在没有分支在飞的时候做一次性提交。',
    '2. **每个模块自己的配置段**：`config.ts` 里现在是五十几个平铺的开关，插件表单也是平铺的；可以分段，同时保留平铺写法能用。',
    '3. **提示词由各模块“贡献”**：`contact.ts` 现在手工拼提示词（几十个 import）；改成每个模块提供一个“这一轮我要往提示词里放什么”的函数，`contact.ts` 只负责排序和拼接。这一步收益最大、改动也最大，放最后，做完要用回放核对提示词没变。',
    '',
    '先做哪一步，取决于目标是“多人分工”（我 / DSH / GPT 各管一块）还是“每个模块单独开关、单独量”（这份文档和状态页已经能做后者）。',
];

export function moduleDocs(adrFiles: readonly string[]): Record<string, string> {
    const docs: Record<string, string> = {};
    for (const module of MODULES) docs[`${module.id}.md`] = moduleDoc(module, adrFiles);
    docs['README.md'] = [
        '# 模块总览',
        '',
        '> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改。',
        '',
        '`packages/bot/src` 下的文件按“管什么”分成几个模块。这一步**只分类、只写文档**，没有挪任何文件、没有改任何运行代码（ADR 0122）。',
        '`modules.test.ts` 保证：每个 `.ts` 文件恰好属于一个模块、清单里的文件都真实存在、这里的文档和清单一致。',
        '',
        '| 模块 | 管什么 | 开关数 |',
        '| --- | --- | --- |',
        ...MODULES.map(module => `| [${module.name}](${module.id}.md) | ${module.scope} | ${FEATURES.filter(feature => module.groups.includes(feature.group)).length} |`),
        '',
        '## 加一个新功能时',
        '',
        '1. 找它属于哪个模块（拿不准就看它改的是“她怎么说”还是“她什么时候说”还是“她过着什么日子”）；新文件加进 `modules.ts` 的 `files`；',
        '2. 在 `features.ts` 登记它的开关（`dashboard.test.ts` 会核对没有漏掉的）；',
        '3. 写 ADR，写测试，真模型模拟；周报里能看到它有没有在发生（日志计数）；',
        '4. 重新生成这份文档。',
        '',
        ...NEXT_STEPS,
        '',
    ].join('\n');
    return docs;
}
