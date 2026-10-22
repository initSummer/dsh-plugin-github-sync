# dsh-plugin-github-sync v0.2.0

Near-real-time sync of DeepSeek Harness (DSH) settings, conversation logs, workspaces, skills and attachments across devices through a **private GitHub repository**.

- Target: DSH `0.2.1-rc.2` Desktop on Windows (PowerShell).
- Zero runtime dependencies: a plain ESM Cordis host plugin plus a standalone CLI.
- Entry points: `/sync` slash command, `github_sync` model tool, `bin/dsh-github-sync.mjs` CLI, and the near-real-time background sync enabled by default.
- v0.2.0 adds adaptive polling (≈3 s active / ≈15 s idle), ~2 s sync after session writes, and **hot application** of imported workspaces/sessions — no DSH restart needed at runtime.

> ⚠️ Use a **private** repository. Conversation content, tool output and attachments are uploaded. Credentials (`.credentials.yaml`) are never synced, but conversations may still contain sensitive data.

Full documentation (Chinese): [README.zh.md](README.zh.md) · [installation](docs/installation.md) · [configuration](docs/configuration.md) · [troubleshooting](docs/troubleshooting.md) · [design](docs/design.md)

---

## Quick start

```powershell
# 1) Create a private repository (empty is fine), then set a user-level PAT with Contents: Read and write
[Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')

# 2) Install the plugin (Desktop's bundled dsh shim; plugin page also works)
dsh plugin --profile desktop add link:<plugin-dir>

# 3) Fully restart DSH Desktop once, then in a conversation:
/sync init https://github.com/<you>/dsh-sync.git
```

On a second device: install, set its own token, configure the same `repo` (plus `pathMappings` if workspace paths differ), sync once, and restart DSH **once after installing/upgrading**. Workspaces and sessions then appear within a few seconds; runtime sync does not require restarts.

The package also ships `node scripts/install.mjs` (and `npm run install:profile`) to find the Desktop shim and run the install command.

---

## What is synchronized

| Scope (default on) | Repository path | Notes |
|---|---|---|
| `settings` | `home/storages/**`, `home/cordis.patch.yml`, `home/cordis.yml`, `profiles/<profileName>/cordis.patch.yml` | Plugin-owned patch rows are filtered out |
| `sessions` | `home/sessions/**` | zstd JSONL logs; append-only extensions can be merged (strict prefix only) |
| `workspaces` | `home/storages/workspace.json`, `meta/workspaces.json` | Semantic merge; the sidecar records each workspace's origin device for `wwa · jackfruit` titles |
| `skills` | `home/skills/**`, `home/AGENTS.md` | User-level skills and global instructions |
| `attachments` | `home/attachments/**` | Images/files referenced by sessions |
| `market` | `home/storages/community_market/global.json`, `sources/**` | Catalog caches are not synced |

Optional (default off): `projections` (`session_projcache/**`, rebuildable) and `plugins` (profile `package.json` / lockfiles — can change the other device's plugin setup).

Never synced: `.credentials.yaml`, `.anonymous-user-id`, `cache/`, `github-sync/` itself, `dsh-runtimes/`, `agents-anywhere/`, `node_modules/`, `.dsh-sync/` conflict copies, session lock/temp files.

The other device therefore needs its own DSH login and model-provider keys.

---

## Configuration

Machine-local file: `%USERPROFILE%\.dsh\github-sync.json` (or `$env:DSH_HOME\github-sync.json`). It is never synced.

Minimal configuration:

```json
{
  "repo": "https://github.com/<you>/dsh-sync.git",
  "branch": "main",
  "deviceName": "workstation-a"
}
```

Near-real-time defaults (all fields optional):

```json
{
  "realtime": {
    "enabled": true,
    "intervalSeconds": 3,
    "idleIntervalSeconds": 15,
    "activeWindowSeconds": 90,
    "pushDebounceSeconds": 2,
    "workspaceDeviceLabel": true,
    "mergeAppendOnlySessions": true
  }
}
```

- `intervalSeconds` / `idleIntervalSeconds`: active / idle polling (3 s / 15 s).
- `activeWindowSeconds`: how long after the last session event the plugin stays in active mode (90 s).
- `pushDebounceSeconds`: sync ~2 s after a session write.
- `workspaceDeviceLabel`: decorate workspace titles with the origin device (`wwa · jackfruit`).
- `mergeAppendOnlySessions`: accept the longer log when two session logs are a strict append-only extension of each other.
- `realtime.enabled: false` falls back to the legacy `auto.intervalMinutes` mode (startup ~15 s, write debounce via `auto.sessionDebounceSeconds`).

Devices whose workspace lives at a different path:

```json
{
  "pathMappings": [
    { "from": "E:\\my-workspace", "to": "D:\\wwa" }
  ]
}
```

`from` is the canonical path stored in the repository (usually the first device's path); `to` is the local path. The plugin creates missing directories, rewrites `workspace.json` paths, session `header.cwd` and path text inside events, and renames the session directory (`--E-work_with_yan--` → `--D-wwa--`).

See [configuration.md](docs/configuration.md) for every field, default, range and precedence rule.

---

## Commands and tools

| Entry | Usage |
|---|---|
| Slash command | `/sync`, `/sync status`, `/sync sync` (aliases `push`/`pull`/`now`), `/sync init <repo-url>`, `/sync help` |
| Model tool | `github_sync` with `action: status \| sync \| init`, plus `repo`, `branch`, `dryRun` |
| CLI | `node bin\dsh-github-sync.mjs status \| sync [--dry-run] \| init --repo <url> [--branch] [--device] [--profile] \| doctor \| paths` |

`/sync status` shows the realtime mode (active/idle intervals, write debounce), the workspace label setting, and any pending (deferred) live sessions.

A sync runs: poll/fetch + merge (fast-forward when only remote advanced; append-only session extensions accepted) → import into the local home with a **live-session gate** → hot-apply to the running DSH (`workspaceRegistry`, `api-session/*` events) → export + push (retry up to 3 times when another device pushed) → update local state and prune old backups.

---

## Near-real-time behavior (v0.2.0)

- **Workspaces and sessions appear without restart.** Imported workspaces are reconciled through the live DSH workspace registry; sessions are pushed to the browser as `api-session/added|activity|removed`. A change on one device normally shows up on the other within 3–6 seconds.
- **Workspace titles show the origin device** (`wwa · jackfruit`), recorded in `meta/workspaces.json`. Disable with `realtime.workspaceDeviceLabel: false`; this only stops new suffixes — titles that already have one must be renamed manually (set it on all devices).
- **A session opened on this device is not overwritten.** The live session owns the in-memory log, so the remote update is deferred (`pendingSessionIds`, shown in `/sync status`). Close and reopen the session (or restart DSH) to see it.
- **Same session on two devices at once** forks the append-only log. The plugin never re-numbers or merges divergent histories: with default `onConflict: "keep-local"` it keeps one side and stores the other whole log as a conflict copy. Avoid continuing the same session on two devices simultaneously.
- **Append-only merge:** when one log is a strict prefix extension of the other (sync first, continue later), the longer log is taken without conflicts.
- **Polling/backoff:** active ≈3 s, idle ≈15 s, failures back off exponentially up to 60 s with jitter; a fast path skips the import pass when nothing changed and no session is pending.
- **Traffic** (rough): ~1 KB per empty poll, ~3–10 KB per changed round. The Git smart-HTTP endpoint does not consume GitHub's REST 5000/h quota, but it is subject to secondary rate limits; keep each device at ≤15 polls/minute (the defaults are far below that).

---

## Conflicts and backups

- Default `onConflict: "keep-local"`: the local version wins; the other side is saved under the repository `.dsh-sync/conflicts/<device>/<timestamp>/`.
- If a local file changes while the sync is running (DSH still writing), the local version is kept and the remote version is saved to both `$DSH_HOME/github-sync/conflicts/<timestamp>/` and the repository conflict directory.
- `prefer-remote` selects the remote side for real conflicts (Git merge conflicts and import-stage overwrites), backing up the local file first; `fail` aborts only on real conflicts (useful for strict auditing).
- `workspace.json` is merged semantically (by workspace id/path); patch files are merged row by row; session logs use the append-only prefix rule above before falling back to the conflict policy.
- On a device's **first sync**, remote state is imported before exporting: workspaces/patch rows are merged, remote sessions are imported, and other opaque settings follow `onConflict` (a fresh DSH home lets the remote version win after a backup).
- Local files overwritten or deleted during import are backed up to `$DSH_HOME/github-sync/backups/<timestamp>/` (retained `backup.keepDays`, default 30).

Restore files by copying them back from the backup/conflict directories while DSH is fully closed. See [troubleshooting.md](docs/troubleshooting.md) for recovery procedures.

---

## Security

- Use a private repository only.
- Tokens are read from environment variables (`DSH_SYNC_GITHUB_TOKEN`, then `GH_TOKEN` / `GITHUB_TOKEN`), passed as a transient Git HTTP header for HTTPS remotes, never written to config/remote/logs, and redacted in errors. SSH remotes use your SSH credentials instead.
- `.credentials.yaml` and `.anonymous-user-id` are never synced; the second device must log in to DSH and configure model keys itself.
- The local snapshot repository, backups and conflict copies contain plaintext data copies.

---

## Limitations

- **Restart once after installing/upgrading the plugin.** Runtime sync and hot application then need no restart. In profiles/CLI environments without the workspace/session services, changes fall back to file writes and may need a restart.
- A **session already open** on a device is not live-refreshed; updates are pending until it is closed and reopened (or DSH restarts).
- Concurrently continuing the **same session** on two devices forks the log; only strict append-only extensions are merged automatically.
- Windows long-path limits apply even though `core.longpaths=true` is configured (enable system long-path support).
- DSH data formats (session v4, workspace v2) may change between DSH releases; the plugin does not version-check imported data.
- No cross-device lock, no Git LFS, no history compaction; repositories grow over time.
- No graphical settings UI.
- Windows + DSH Desktop is the documented environment; macOS/Linux are untested.

For the full Chinese documentation, start with [README.zh.md](README.zh.md); architecture, realtime flow and data-flow details are in [design.md](docs/design.md).
