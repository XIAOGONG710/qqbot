# Security policy

## Supported versions

The `main` branch is the only supported line. Releases are tagged from it.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private advisory flow:

1. Go to the repository's **Security** tab → **Advisories** → **Report a vulnerability**.
2. Include: affected version/tag, the config keys involved, reproduction steps, and the impact you can demonstrate.

You can expect an acknowledgement within 7 days. If the report is valid we will prepare a fix and a coordinated advisory.

## What this bundle touches

- **Worker sessions** are real DSH sessions created with `danger-full-access` permissions. Treat `acceptMode: accept` as running an agent with your user rights in the selected repository directory. Start with `observe`, then narrow with `acceptSources`.
- **Delivery** default is `mode: patch` — commits stay in a per-ticket worktree and produce a patch + PR draft. Nothing is pushed or opened as a PR unless you set `mode: push` / `pr` and provide a token.
- **Credentials** are read from config or environment at runtime. The bundle never writes a token to disk, and the published tree contains no secrets.
- **HTTP surface** (`/api/super-agent/state`, `/command`, `/hook`) is bound to the same loopback listener as the DSH Web UI. `/hook` verifies an HMAC when `sources.ci.secret` is configured; keep that secret non-empty if the port is reachable by anything else.
- **`cleanup`** only archives `sa-*` sessions and deletes workspaces whose path is inside `<stateDir>/worktrees`.
