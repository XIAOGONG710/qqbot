# Codex handoff — memory hardening and branch consolidation

- Date: 2026-11-05 10:40 JST
- Runtime baseline: `dsh/qq-control@9dcfbc9b`
- Integration branch: `memory-hardening-1105`
- Checkpoint: `4c6eea53`
- Status: **work in progress; do not merge into the runtime branch yet**

## What is integrated at this checkpoint

- Memory storage fault handling, source identities, privacy inventory, pending input/recall receipts, async retention receipts, document revision barriers, derived-memory read barriers, and owned shutdown/drain changes through ADR 0242.
- DSH-specific behavior was retained during conflicts: device capture remains consent-gated; quote/forward hydration, group chat, work mode, self-directed notes, DSH lock heartbeat, and DSH runtime paths remain present.
- The read-only daily raw-numbers report and the 48-hour go-live/restart guard were recovered from old branches and added here.
- No role card, `crisis*.ts`, generated `docs/modules/**`, runtime data, deployment, or external service was changed.

## Verification completed

- `node --test test/daily-report.test.ts test/restart-log.test.ts`: 10 passed, 0 failed.
- Conflict resolutions passed `git diff --check` before each commit.
- A full typecheck is not yet green on this integration branch. Known blockers are recorded below; this branch is intentionally not promoted.

## Known blockers / next work

1. Continue selective memory integration after ADR 0242. The remaining main-line range is not safe to cherry-pick wholesale because it crosses DSH App, diary, responder, and shutdown behavior.
2. Reconcile the feedback schema dependency used by the privacy audit without changing crisis policy.
3. Validate the mobile-companion workspace package against this worktree rather than the original checkout's workspace links.
4. Run the confirmed synthetic memory suite, full repository typecheck, module registry check, and diff audit before promotion.
5. Only after those pass: fast-forward or merge into `dsh/qq-control`, then decide whether `main` should be repointed to the same validated commit.

## Branch cleanup performed

- All 41 former `claude/*` branch tips were preserved as annotated tags under `archive/branches/2026-11-05/claude/*`.
- Their remote branch refs were deleted after tag targets were verified.
- Remote heads now are only `main`, `dsh/qq-control`, `exchange`, and `memory-hardening-1105`.
- `exchange` was retained because it is the handoff line; `main` and DSH were retained because consolidation is not yet validated.

## DSH action

Do not deploy this checkpoint. Continue review from `memory-hardening-1105`, preserve the DSH product-policy files above, and promote only after the listed validation gates are green.
