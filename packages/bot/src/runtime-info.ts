export interface RuntimeInfo {
    commit: string;
    branch: string;
    dirty: boolean | null;
    startedAt: string;
}

/** 启动脚本把 Git 身份放进环境变量；没有走脚本时明确显示 unknown，不猜线上版本。 */
export function runtimeInfo(env: NodeJS.ProcessEnv = process.env, startedAt = new Date()): RuntimeInfo {
    return {
        commit: env.QQBOT_GIT_COMMIT?.trim() || 'unknown',
        branch: env.QQBOT_GIT_BRANCH?.trim() || 'unknown',
        dirty: env.QQBOT_GIT_DIRTY === 'true' ? true : env.QQBOT_GIT_DIRTY === 'false' ? false : null,
        startedAt: startedAt.toISOString(),
    };
}
