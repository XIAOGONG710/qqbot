// 记忆阈值（硬编码改造第三批）：QQ 这边从和 DSH 共用的那张表拿数（dsh-plugins/dsh-linmengyao-memory/memory-thresholds.mjs）。
// 默认值就是原来写死在 fading.ts / cross-recent.ts / long-term.ts / desktop-log.ts / dsh-inbox.ts / notebook-learning.ts / config.ts 里的数。
// 要调：环境变量 QQBOT_MEMORY_THRESHOLDS 指向一个 JSON 文件（只写要改的键）；DSH 插件读同一个环境变量、同一个文件、走同一个解析，
// 两边共用的概念读到的一定是同一个数。文件有一样不对就整个不用、全部默认（MEMORY_THRESHOLDS_RESULT.issue 写原因）。
// 进程启动时读一次；改了文件要重启 Koishi（和 DSH 那边重开插件）才生效。

import { loadMemoryThresholds, memoryThresholdsLogLine, type MemoryThresholds, type MemoryThresholdsResult } from '../../../../dsh-plugins/dsh-linmengyao-memory/memory-thresholds.mjs';

/** 这个进程用的那张表（含没用上的原因） */
export const MEMORY_THRESHOLDS_RESULT: MemoryThresholdsResult = loadMemoryThresholds(process.env.QQBOT_MEMORY_THRESHOLDS);
export const MEMORY_THRESHOLDS: MemoryThresholds = MEMORY_THRESHOLDS_RESULT.values;
/** 启动日志那一行（不写路径和文件内容） */
export const memoryThresholdsLine = (): string => memoryThresholdsLogLine(MEMORY_THRESHOLDS_RESULT);
