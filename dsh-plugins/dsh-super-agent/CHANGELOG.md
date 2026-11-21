# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-11-14

### Added

- Router/Worker two-layer control plane with batched semantic admission, thread subscription, contextual chain pointers and a persistent JSON snapshot.
- Real Trigger sources: directory inbox, GitHub issue/comment polling (cursors, ETag-free, rate-limit backoff) and signed webhooks for GitHub and generic CI.
- Per-ticket git worktrees (`git worktree add -b sa/<ticket>`) so several repositories run in parallel without touching each other's working tree.
- Delivery pipeline: commit with explicit identity, binary-safe patch, PR draft, optional push, optional GitHub PR, and a result reply back to the originating thread (inbox receipt or issue comment).
- Unattended guards: per-hour / per-ticket-runtime / daily-token budgets, per-source allowlist (`acceptSources`), restart-safe ticket ids, and a `cleanup` action that removes only this bundle's sidebar artifacts.
- Live console: architecture topology, admission funnel, attention budget, worker lanes, watchdog ring, p50/p95 against the single-session baseline, event stream and control bar.
- Worker sessions are nested subagents, so a ticket never creates a Workspace or a top-level conversation.

### Fixed

- Worker sessions created without a model selection failed on the first turn; workers now get an explicit model and directory at creation.
- `resolveAgent` materializes a Session before `create` can anchor it; creation is now workspace-first, then resolve.
- Remote Session methods require a cancellation signal; calls without one threw `throwIfAborted`.
- Local clones with a configured remote were forced into patch-only delivery; the gate now checks for a remote, not for a local path.
- Console pause state was persisted and silently stopped the Router after a restart; runtime mode is no longer restored from state.

### Verified

- 98 offline assertions (engine 14 · worktree 6 · sources 13 · reply 9 · delivery 56).
- Live DSH runs: paper-shaped p50 12.6 min / p95 15.7 min, cross-repository parallelism, inbox tickets end-to-end, and a real GitHub poll of `openai/openai-node` with zero replay after restart.

## [0.1.0] — 2026-11-09

- First working vertical slice: admission funnel, dispatch, simulated demo replay, console panel and HTTP API.

[Unreleased]: https://github.com/aowind/dsh-super-agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/aowind/dsh-super-agent/releases/tag/v0.2.0
