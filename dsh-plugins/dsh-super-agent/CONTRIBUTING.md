# Contributing

Thanks for helping. This is a DSH **bundle**: a Host half (`index.js`, `lib/`) and a Client half (`client.js`). Keep the split clean — the control plane never imports a DSH package, so it stays testable with plain `node`.

## Ground rules

- **No new runtime dependencies.** Only `node:` built-ins and the global `fetch`.
- **The control plane stays DSH-free.** `lib/engine.js` receives an adapter; `index.js` is the only file that talks to `ctx.sessionController`, `ctx.agents`, `ctx.webServer`, and friends.
- **Every behaviour gets a cheap assertion.** Offline suites run in seconds and must not touch the real network.
- **Secrets never enter the tree.** Tokens go into config or environment, read at runtime.
- **User-visible text is bilingual.** Console strings live in the `zh`/`en` dictionaries inside `client.js`; plugin metadata lives in `locale/*.json`.

## Local workflow

```bash
node --check index.js
node --check client.js
npm test                     # engine 14 · worktree 6 · sources 13 · reply 9 · delivery 56
node lib/sources/reply.test.mjs
```

For UI work, mount the client half without the GUI:

```bash
node <workspace>/probes/render-console.mjs --state <captured-state.json>
```

`--state` takes the JSON from `GET /api/super-agent/state`, so a real snapshot renders in jsdom and can be screenshotted.

## Installing your working copy into a profile

```
plugin_manager action=install_bundle target=<absolute-path-to-this-directory>
```

The package is installed as a link, so a plugin toggle (`set_plugin enabled=false` then `true`) reloads your edits. `lib/*.mjs` modules are imported with a cache-busting query, so they are re-evaluated on every activation.

## What a good change looks like

1. A failing case first (offline assertion), then the fix.
2. The config key is documented in `cordis.patch.yml` **and** `README.md`.
3. The console still renders with a sparse/old state snapshot (the normalizers treat every field as optional).
4. `cleanup` still only touches `sa-*` sessions and `…/worktrees/…` workspaces.

## Commit messages

`type: short imperative summary` — `feat`, `fix`, `docs`, `test`, `chore`, `refactor`. Mention the area (`sources:`, `delivery:`, `worktree:`, `console:`) when it helps.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.
