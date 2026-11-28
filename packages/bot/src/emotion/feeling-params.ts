// 心境参数（硬编码改造第五批）：QQ 这边从和 DSH 共用的那张表拿数（dsh-plugins/dsh-linmengyao-memory/feeling-params.mjs）。
// 默认值就是原来写死在 feelings.ts / recovery.ts / affect.ts / grievance.ts / feeling-export.ts 里的数。
// 要调：环境变量 QQBOT_FEELING_PARAMS 指向一个 JSON 文件（只写要改的键）；DSH 插件读同一个环境变量、同一个文件、走同一个解析，
// 两边共用的概念（心境多久算过期）读到的一定是同一个数。文件有一样不对就整个不用、全部默认（FEELING_PARAMS_RESULT.issue 写原因）。
// 进程启动时读一次；改了文件要重启 Koishi（和 DSH 那边重开插件）才生效。

import { feelingParamsLogLine, loadFeelingParams, type FeelingParams, type FeelingParamsResult } from '../../../../dsh-plugins/dsh-linmengyao-memory/feeling-params.mjs';

/** 这个进程用的那张表（含没用上的原因） */
export const FEELING_PARAMS_RESULT: FeelingParamsResult = loadFeelingParams(process.env.QQBOT_FEELING_PARAMS);
export const FEELING_PARAMS: FeelingParams = FEELING_PARAMS_RESULT.values;
/** 日志那一行（调过或文件没用上时才有；不写路径和文件内容） */
export const feelingParamsLine = (): string => feelingParamsLogLine(FEELING_PARAMS_RESULT);
