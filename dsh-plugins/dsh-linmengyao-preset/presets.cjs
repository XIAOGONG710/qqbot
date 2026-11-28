// 由 build-presets.mjs 生成，别手改。
// 四个内置模式的插件表照抄 DSH 自带 preset，只把 persona 的 prefix 换成她的身份：组 preset 时由 her-prefix.cjs 现读角色卡（ADR 0353）。
// 生成时间见 git 提交说明；DSH 升级后重跑：node dsh-plugins/dsh-linmengyao-preset/build-presets.mjs
"use strict";

// standard: 原 id standard，order 1，23 行
exports.standard = (ctx, baseUrl) => [
  {
    id: "persona",
    name: "@deepseek-ai/dsh-persona",
    config: {
      prefix: (require("./her-prefix.cjs").herPrefix()),
    },
  },
  {
    id: "agent-instructions",
    name: "@deepseek-ai/dsh-agent-instructions",
    config: {
      maxBytes: 65536,
    },
  },
  {
    id: "time-context",
    name: "@deepseek-ai/dsh-time-context",
  },
  {
    id: "tool-bash",
    name: "@deepseek-ai/dsh-tool-bash",
    disabled: (process.platform === 'win32'),
  },
  {
    id: "tool-pwsh",
    name: "@deepseek-ai/dsh-tool-pwsh",
    disabled: (process.platform !== 'win32'),
  },
  {
    id: "tool-fs",
    name: "@deepseek-ai/dsh-tool-fs",
    config: {
      applyPatch: false,
    },
  },
  {
    id: "tool-fs-search",
    name: "@deepseek-ai/dsh-tool-fs-search",
    config: {
      sampleOverCapGlobResults: false,
    },
  },
  {
    id: "tool-jobs",
    name: "@deepseek-ai/dsh-tool-jobs",
  },
  {
    id: "tool-schedule",
    name: "@deepseek-ai/dsh-tool-schedule",
  },
  {
    id: "skill-filesystem",
    name: "@deepseek-ai/dsh-skill-filesystem",
    config: {
      customSkillDirs: [
        (process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')),
      ],
    },
  },
  {
    id: "tool-skill",
    name: "@deepseek-ai/dsh-tool-skill",
  },
  {
    id: "command-goal",
    name: "@deepseek-ai/dsh-command-goal",
  },
  {
    id: "tool-goal",
    name: "@deepseek-ai/dsh-tool-goal",
  },
  {
    id: "planning",
    name: "cordis:group",
    group: true,
    isolate: {
      planMode: true,
    },
    config: [
      {
        id: "plan-mode",
        name: "@deepseek-ai/dsh-plan-mode",
        config: {
          section: "You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.\n\nExplore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.\n\nThe tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.\n\nResolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.\n\nMake the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.\n\nWhen ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask \"should I proceed?\" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.\n",
        },
      },
    ],
  },
  {
    id: "compaction",
    name: "cordis:group",
    group: true,
    isolate: {
      compaction: true,
      toolResultPruner: true,
    },
    config: [
      {
        id: "compaction-basic",
        name: "@deepseek-ai/dsh-compaction-basic",
      },
      {
        id: "command-compact",
        name: "@deepseek-ai/dsh-command-compact",
      },
      {
        id: "tool-result-pruner",
        name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
        config: {
          thresholdChars: 8192,
          headChars: 4096,
          tailChars: 1024,
        },
      },
    ],
  },
  {
    id: "delegation",
    name: "cordis:group",
    group: true,
    isolate: {
      workflowEngine: true,
    },
    config: [
      {
        id: "tool-subagent-control",
        name: "@deepseek-ai/dsh-tool-subagent-control",
        config: {
          interrupt: false,
        },
      },
      {
        id: "tool-subagent",
        name: "@deepseek-ai/dsh-tool-subagent",
        config: {
          provider: "spawn",
          toolName: "subagent",
          modelSelection: true,
          modelDiscovery: true,
        },
      },
      {
        id: "tool-subagent-fork",
        name: "@deepseek-ai/dsh-tool-subagent",
        config: {
          provider: "fork",
          toolName: "subagent_fork",
        },
      },
      {
        id: "workflow-ptc",
        name: "@deepseek-ai/dsh-workflow-ptc",
        config: {
          provider: "spawn",
        },
      },
      {
        id: "tool-workflow",
        name: "@deepseek-ai/dsh-tool-workflow",
      },
    ],
  },
  {
    id: "tool-ask-user",
    name: "@deepseek-ai/dsh-tool-ask-user",
  },
  {
    id: "tool-todo",
    name: "@deepseek-ai/dsh-tool-todo",
    config: {
      allowParallelInProgress: true,
    },
  },
  {
    id: "tool-web",
    name: "@deepseek-ai/dsh-tool-web",
    config: {
      fetch: true,
      searchTimeoutMs: 60000,
    },
  },
  {
    id: "present",
    name: "@deepseek-ai/dsh-tool-present",
  },
  {
    id: "tool-office",
    name: "@deepseek-ai/dsh-tool-office",
  },
  {
    id: "tool-plugin-manager",
    name: "@deepseek-ai/dsh-plugin-manager/tools",
    disabled: (!ctx.get('profileContext')),
  },
  {
    id: "tool-plugin-market",
    name: "@deepseek-ai/dsh-plugin-market/tools",
    disabled: true,
  },
];

// ptc: 原 id ptc，order 2，24 行
exports.ptc = (ctx, baseUrl) => [
  {
    id: "persona",
    name: "@deepseek-ai/dsh-persona",
    config: {
      prefix: (require("./her-prefix.cjs").herPrefix()),
    },
  },
  {
    id: "agent-instructions",
    name: "@deepseek-ai/dsh-agent-instructions",
    config: {
      maxBytes: 65536,
    },
  },
  {
    id: "time-context",
    name: "@deepseek-ai/dsh-time-context",
  },
  {
    id: "tool-bash",
    name: "@deepseek-ai/dsh-tool-bash",
    disabled: (process.platform === 'win32'),
  },
  {
    id: "tool-pwsh",
    name: "@deepseek-ai/dsh-tool-pwsh",
    disabled: (process.platform !== 'win32'),
  },
  {
    id: "tool-fs",
    name: "@deepseek-ai/dsh-tool-fs",
    config: {
      applyPatch: false,
    },
  },
  {
    id: "tool-fs-search",
    name: "@deepseek-ai/dsh-tool-fs-search",
    config: {
      sampleOverCapGlobResults: false,
    },
  },
  {
    id: "tool-jobs",
    name: "@deepseek-ai/dsh-tool-jobs",
  },
  {
    id: "tool-schedule",
    name: "@deepseek-ai/dsh-tool-schedule",
  },
  {
    id: "skill-filesystem",
    name: "@deepseek-ai/dsh-skill-filesystem",
  },
  {
    id: "tool-skill",
    name: "@deepseek-ai/dsh-tool-skill",
  },
  {
    id: "command-goal",
    name: "@deepseek-ai/dsh-command-goal",
  },
  {
    id: "tool-goal",
    name: "@deepseek-ai/dsh-tool-goal",
  },
  {
    id: "planning",
    name: "cordis:group",
    group: true,
    isolate: {
      planMode: true,
    },
    config: [
      {
        id: "plan-mode",
        name: "@deepseek-ai/dsh-plan-mode",
        config: {
          section: "You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.\n\nExplore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.\n\nThe tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.\n\nResolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.\n\nMake the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.\n\nWhen ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask \"should I proceed?\" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.\n",
        },
      },
    ],
  },
  {
    id: "compaction",
    name: "cordis:group",
    group: true,
    isolate: {
      compaction: true,
      toolResultPruner: true,
    },
    config: [
      {
        id: "compaction-basic",
        name: "@deepseek-ai/dsh-compaction-basic",
      },
      {
        id: "command-compact",
        name: "@deepseek-ai/dsh-command-compact",
      },
      {
        id: "tool-result-pruner",
        name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
        config: {
          thresholdChars: 8192,
          headChars: 4096,
          tailChars: 1024,
        },
      },
    ],
  },
  {
    id: "delegation",
    name: "cordis:group",
    group: true,
    isolate: {
      workflowEngine: true,
    },
    config: [
      {
        id: "tool-subagent-control",
        name: "@deepseek-ai/dsh-tool-subagent-control",
        config: {
          interrupt: false,
        },
      },
      {
        id: "tool-subagent",
        name: "@deepseek-ai/dsh-tool-subagent",
        config: {
          provider: "spawn",
          toolName: "subagent",
          modelSelection: true,
          modelDiscovery: true,
        },
      },
      {
        id: "tool-subagent-fork",
        name: "@deepseek-ai/dsh-tool-subagent",
        config: {
          provider: "fork",
          toolName: "subagent_fork",
        },
      },
      {
        id: "workflow-ptc",
        name: "@deepseek-ai/dsh-workflow-ptc",
        disabled: true,
        config: {
          provider: "spawn",
        },
      },
      {
        id: "tool-workflow",
        name: "@deepseek-ai/dsh-tool-workflow",
        disabled: true,
      },
    ],
  },
  {
    id: "tool-ask-user",
    name: "@deepseek-ai/dsh-tool-ask-user",
  },
  {
    id: "tool-todo",
    name: "@deepseek-ai/dsh-tool-todo",
    config: {
      allowParallelInProgress: true,
    },
  },
  {
    id: "tool-web",
    name: "@deepseek-ai/dsh-tool-web",
    config: {
      fetch: true,
      searchTimeoutMs: 60000,
    },
  },
  {
    id: "tool-executor-ptc",
    name: "@deepseek-ai/dsh-tool-executor-ptc",
  },
  {
    id: "present",
    name: "@deepseek-ai/dsh-tool-present",
  },
  {
    id: "tool-office",
    name: "@deepseek-ai/dsh-tool-office",
  },
  {
    id: "tool-plugin-manager",
    name: "@deepseek-ai/dsh-plugin-manager/tools",
    disabled: true,
  },
  {
    id: "tool-plugin-market",
    name: "@deepseek-ai/dsh-plugin-market/tools",
    disabled: true,
  },
];

// minimal: 原 id minimal，order 3，4 行
exports.minimal = (ctx, baseUrl) => [
  {
    id: "persona",
    name: "@deepseek-ai/dsh-persona",
    config: {
      prefix: (require("./her-prefix.cjs").herPrefix()),
      complete: true,
      includeRuntimeContext: false,
    },
  },
  {
    id: "tool-fs",
    name: "@deepseek-ai/dsh-tool-fs",
    config: {
      read: false,
      readImage: true,
      write: false,
      edit: false,
    },
  },
  {
    id: "compaction",
    name: "cordis:group",
    group: true,
    isolate: {
      compaction: true,
    },
    config: [
      {
        id: "compaction-basic",
        name: "@deepseek-ai/dsh-compaction-basic",
      },
      {
        id: "command-compact",
        name: "@deepseek-ai/dsh-command-compact",
      },
    ],
  },
  {
    id: "persistent-shell",
    name: "cordis:group",
    group: true,
    isolate: {
      terminals: true,
    },
    config: [
      {
        id: "pty",
        name: "@deepseek-ai/dsh-terminal",
      },
      {
        id: "terminal-bash",
        name: "@deepseek-ai/dsh-terminal-bash",
        disabled: (process.platform === 'win32'),
        config: {
          timeoutMs: 300000,
        },
      },
      {
        id: "persistent-bash",
        name: "@deepseek-ai/dsh-tool-bash-persistent",
        disabled: (process.platform === 'win32'),
        config: {
          timeoutMs: 300000,
          description: "Run commands in a bash shell\n* When invoking this tool, the contents of the \"command\" parameter does NOT need to be XML-escaped.\n* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.\n* State is persistent across command calls and discussions with the user.\n* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.\n* Please avoid commands that may produce a very large amount of output.\n* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
        },
      },
      {
        id: "terminal-pwsh",
        name: "@deepseek-ai/dsh-terminal-bash",
        disabled: (process.platform !== 'win32'),
        config: {
          shellDialect: "pwsh",
          timeoutMs: 300000,
        },
      },
      {
        id: "persistent-pwsh",
        name: "@deepseek-ai/dsh-tool-pwsh-persistent",
        disabled: (process.platform !== 'win32'),
        config: {
          timeoutMs: 300000,
          description: "Run commands in a PowerShell shell\n* When invoking this tool, the contents of the \"command\" parameter does NOT need to be XML-escaped.\n* You don't have access to the internet via this tool.\n* State is persistent across command calls and discussions with the user.\n* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.\n* Please avoid commands that may produce a very large amount of output.\n* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.",
        },
      },
    ],
  },
];

// cordis: 原 id cordis，order 4，23 行
exports.cordis = (ctx, baseUrl) => [
  {
    id: "persona",
    name: "@deepseek-ai/dsh-persona",
    config: {
      prefix: (require("./her-prefix.cjs").herPrefix()),
    },
  },
  {
    id: "agent-instructions",
    name: "@deepseek-ai/dsh-agent-instructions",
    config: {
      maxBytes: 65536,
    },
  },
  {
    id: "time-context",
    name: "@deepseek-ai/dsh-time-context",
  },
  {
    id: "tool-bash",
    name: "@deepseek-ai/dsh-tool-bash",
    disabled: (process.platform === 'win32'),
  },
  {
    id: "tool-pwsh",
    name: "@deepseek-ai/dsh-tool-pwsh",
    disabled: (process.platform !== 'win32'),
  },
  {
    id: "tool-fs",
    name: "@deepseek-ai/dsh-tool-fs",
    config: {
      applyPatch: false,
    },
  },
  {
    id: "tool-fs-search",
    name: "@deepseek-ai/dsh-tool-fs-search",
    config: {
      sampleOverCapGlobResults: false,
    },
  },
  {
    id: "tool-jobs",
    name: "@deepseek-ai/dsh-tool-jobs",
  },
  {
    id: "tool-schedule",
    name: "@deepseek-ai/dsh-tool-schedule",
  },
  {
    id: "command-goal",
    name: "@deepseek-ai/dsh-command-goal",
  },
  {
    id: "tool-goal",
    name: "@deepseek-ai/dsh-tool-goal",
  },
  {
    id: "planning",
    name: "cordis:group",
    group: true,
    isolate: {
      planMode: true,
    },
    config: [
      {
        id: "plan-mode",
        name: "@deepseek-ai/dsh-plan-mode",
        config: {
          section: "You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.\n\nExplore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.\n\nThe tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.\n\nResolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.\n\nMake the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.\n\nWhen ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask \"should I proceed?\" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.\n",
        },
      },
    ],
  },
  {
    id: "compaction",
    name: "cordis:group",
    group: true,
    isolate: {
      compaction: true,
      toolResultPruner: true,
    },
    config: [
      {
        id: "compaction-basic",
        name: "@deepseek-ai/dsh-compaction-basic",
      },
      {
        id: "command-compact",
        name: "@deepseek-ai/dsh-command-compact",
      },
      {
        id: "tool-result-pruner",
        name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
        config: {
          thresholdChars: 8192,
          headChars: 4096,
          tailChars: 1024,
        },
      },
    ],
  },
  {
    id: "delegation",
    name: "cordis:group",
    group: true,
    isolate: {
      workflowEngine: true,
    },
    config: [
      {
        id: "tool-subagent-control",
        name: "@deepseek-ai/dsh-tool-subagent-control",
        config: {
          interrupt: false,
        },
      },
      {
        id: "tool-subagent",
        name: "@deepseek-ai/dsh-tool-subagent",
        config: {
          provider: "spawn",
          toolName: "subagent",
          modelSelection: true,
          modelDiscovery: true,
        },
      },
      {
        id: "tool-subagent-fork",
        name: "@deepseek-ai/dsh-tool-subagent",
        config: {
          provider: "fork",
          toolName: "subagent_fork",
        },
      },
      {
        id: "workflow-ptc",
        name: "@deepseek-ai/dsh-workflow-ptc",
        config: {
          provider: "spawn",
        },
      },
      {
        id: "tool-workflow",
        name: "@deepseek-ai/dsh-tool-workflow",
      },
    ],
  },
  {
    id: "tool-ask-user",
    name: "@deepseek-ai/dsh-tool-ask-user",
  },
  {
    id: "tool-todo",
    name: "@deepseek-ai/dsh-tool-todo",
    config: {
      allowParallelInProgress: true,
    },
  },
  {
    id: "tool-web",
    name: "@deepseek-ai/dsh-tool-web",
    config: {
      fetch: true,
      searchTimeoutMs: 60000,
    },
  },
  {
    id: "tool-cordis",
    name: "@deepseek-ai/dsh-tool-cordis",
  },
  {
    id: "skill-filesystem",
    name: "@deepseek-ai/dsh-skill-filesystem",
    config: {
      customSkillDirs: [
        (process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')),
      ],
    },
  },
  {
    id: "tool-skill",
    name: "@deepseek-ai/dsh-tool-skill",
  },
  {
    id: "present",
    name: "@deepseek-ai/dsh-tool-present",
  },
  {
    id: "tool-plugin-manager",
    name: "@deepseek-ai/dsh-plugin-manager/tools",
    disabled: (!ctx.get('profileContext')),
  },
  {
    id: "tool-plugin-market",
    name: "@deepseek-ai/dsh-plugin-market/tools",
    disabled: (!ctx.get('profileContext')),
  },
];
