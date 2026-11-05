# Codex handoff — memory hardening and branch consolidation

- Updated: 2026-11-05 JST
- Runtime baseline: `dsh/qq-control@9dcfbc9b`
- Integration branch: `memory-hardening-1105`
- Code checkpoint: `a30ede7e`
- Remote: `https://github.com/XIAOGONG710/qqbot.git`
- Branch URL: `https://github.com/XIAOGONG710/qqbot/tree/memory-hardening-1105`
- Status: **work in progress; do not merge into the runtime branch yet**

## What is integrated at this checkpoint

- Memory storage fault handling, source identities, privacy inventory, pending input/recall receipts, asynchronous retention receipts, document revision barriers, and derived-memory read barriers (integration ADRs 0300–0305).
- Shared derived-state process coordination (ADR 0306), attributable feedback records, the shared civil-date helper, and stable world-action identities.
- Promise extraction source revalidation and causal rollback: recalls discard stale extraction results, changed appointments retain their logical ID, and later valid sources cannot be rolled back by earlier ones.
- Private relationship-model repair with durable evidence and finite settlement of obsolete refresh jobs (ADRs 0307–0308). Public derived memories and historical observations remain protected rather than being falsely declared clean.
- Crash-resumable forget intent plus a full-directory SQLite OS lease (ADR 0309). JSON remains the domain source of truth; the SQLite file is coordination only. Legacy PID/heartbeat writers remain recognizable during migration.
- Source-visible history and civil-day identity (ADR 0310): future messages cannot enter current memory snapshots early, and missing/low-year/DST civil dates do not roll into another day.
- External-action stop ownership (ADR 0311): already-dispatched sends and mutations settle before the directory lease is released, while undispatched local work is cancelled.
- Read-only historical-observation repair evidence (ADR 0312). It exposes capability and status facts without pretending that an accepted request, empty live inventory, or version string proves the old observation store is clean.
- Immutable diary/week/phase submission intents, remote task completion receipts, and source manifests (ADR 0313), plus continuous source revalidation before public derived reads (ADR 0314). Completed remote facts are retained, but recalled or re-tiered sources close the public read path.
- Crash-resumable archive plans (ADR 0315): the original file/config move plan is persisted before business writes, can resume after child-process interruption, and blocks App startup or forget operations while incomplete.
- The read-only daily raw-numbers report and the 48-hour go-live/restart guard recovered from archived branches.

DSH-specific behavior was retained during conflicts: device capture remains consent-gated; quote/forward hydration, group chat, work mode, self-directed notes, DSH inboxes, migration tooling, and DSH runtime paths remain present. No role card or `packages/bot/src/emotion/crisis*.ts` file was changed. `docs/modules/**` changes were produced only by `modules-doc.ts`.

## Verification completed

- Promise source/causal suite: 63 passed, 0 failed.
- Private repair initial suite: 61 passed, 0 failed.
- Obsolete-refresh settlement suite: 49 passed, 0 failed.
- Forget/data-lease suite, including real child-process contention and crash recovery: 33 passed, 0 failed.
- Civil-day/future-history/repair integration suite: 50 passed, 0 failed.
- External-action stop-ownership suite: 11 passed, 0 failed.
- Observation repair API suite: 18 passed, 0 failed.
- Diary prepared-retain/source-revalidation combined suite: 71 passed, 0 failed.
- Archive intent/resume/privacy suite, including real child-process interruption: 18 passed, 0 failed.
- Full workspace `npm run typecheck`: passed after replacing the stale cross-worktree `node_modules` junction with this worktree's own install.
- Module registry/generated-doc check: 4 passed, 0 failed after each module change.
- `git diff --check` and prohibited-path checks passed before each pushed checkpoint.

These are confirmed synthetic/fake-service suites, not a fresh claim that every repository test is synthetic or that the whole repository test matrix has been rerun. Historical full runs used repository fixtures; do not restate them as this checkpoint's validation.

## Known blockers / next work

1. Continue selective memory integration after ADR 0315. Do not cherry-pick the remaining main-line range wholesale because it crosses DSH App, diary, responder, social, Bilibili, and shutdown behavior.
2. Historical observations and public diary/week/phase-derived memories still need an independently evidenced cleanup/rebuild protocol. Client-side guards, source manifests, `stats`, or an accepted refresh ACK do not prove the remote worker is quiescent or the old store is clean.
3. Continue the later live-inventory evidence, owner/drain, authored-intent, and resource-cost batches with synthetic fixtures. Preserve already-dispatched mutation ACKs while cancelling only local pure-read/model work.
4. Run the final confirmed synthetic memory suite, full repository typecheck, module registry, and diff audit after the last selective batch. Only then consider promotion.
5. After all validation gates pass: merge or fast-forward into `dsh/qq-control`; decide separately whether `main` should be repointed. Do not deploy this WIP branch.

## Branch cleanup performed

- All 41 former `claude/*` branch tips are preserved as annotated tags under `archive/branches/2026-11-05/claude/*`; their remote heads were deleted after target verification.
- The redundant `memory-1105-dsh-integration` branch was verified as a strict capability subset of this branch, archived at `archive/branches/2026-11-05/memory-1105-dsh-integration`, then deleted.
- Remote heads are again only `main`, `dsh/qq-control`, `exchange`, and `memory-hardening-1105`.
- `exchange` remains for handoff; `main` and DSH remain untouched while consolidation is not yet validated.

## DSH action

Do not deploy this checkpoint. Continue from `memory-hardening-1105`, preserve the DSH product-policy files and boundaries above, and promote only after the remaining memory work and final validation gates are complete.
