# dsh-plugin-github-sync

Sync DeepSeek Harness (DSH) settings, conversation logs, workspaces, skills and attachments across devices through a **private GitHub repository**.

- Target: DSH `0.2.1-rc.2` Desktop on Windows (PowerShell).
- Zero runtime dependencies: a plain ESM Cordis host plugin plus a standalone CLI.
- Entry points: `/sync` slash command, `github_sync` model tool, `bin/dsh-github-sync.mjs` CLI, optional automatic sync.

> ⚠️ Use a **private** repository. Conversation content, tool output and attachments are uploaded. Credentials (`.credentials.yaml`) are never synced, but conversations may still contain sensitive data.

Full documentation (Chinese): [README.zh.md](README.zh.md) · [installation](docs/installation.md) · [configuration](docs/configuration.md) · [troubleshooting](docs/troubleshooting.md) · [design](docs/design.md)

---

## Quick start

```powershell
# 1) Create a private repository (empty is fine), then set a user-level PAT with Contents: Read and write
[Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')

# 2) Install the plugin (Desktop's bundled dsh shim; plugin page also works)
dsh plugin --profile desktop add link:<插件目录>

# 3) Fully restart DSH Desktop, then in a conversation:
/sync init https://github.com/<you>/dsh-sync.git
```

On a second device: install, set its own token, configure the same `repo` (plus `pathMappings` if workspace paths differ), sync once, then **restart DSH** to see imported workspaces/sessions.

---

## What is synchronized

| Scope (default on) | Repository path | Notes |
|---|---|---|
| `settings` | `home/storages/**`, `home/cordis.patch.yml`, `home/cordis.yml`, `profiles/<profileName>/cordis.patch.yml` | Plugin-owned patch rows are filtered out |
| `sessions` | `home/sessions/**` | zstd JSONL logs, copied byte-for-byte unless paths need rewriting |
| `workspaces` | `home/storages/workspace.json` | Semantic merge; DSH invariants re-validated |
| `skills` | `home/skills/**`, `home/AGENTS.md` | User-level skills and global instructions |
| `attachments` | `home/attachments/**` | Images/files referenced by sessions |
| `market` | `home/storages/community_market/global.json`, `sources/**` | Catalog caches are not synced |

Optional (default off): `projections` (`session_projcache/**`, rebuildable) and `plugins` (profile `package.json` / lockfiles — can change the other device's plugin setup).

Never synced: `.credentials.yaml`, `.anonymous-user-id`, `cache/`, `github-sync/` itself, `dsh-runtimes/`, `agents-anywhere/`, `node_modules/`, `.dsh-sync/` conflict copies, session lock/temp files.

The other device therefore needs its own DSH login and model-provider keys.

---

## Installation

### A. Desktop plugin page

Sidebar **Plugins** → **Add plugin** → enter the local absolute path:

```text
<插件目录>
```

(or a Git URL). The package declares `dsh.bundle.patch`, so it is installed as a bundle and enabled automatically. Restart DSH.

### B. Desktop `dsh` shim (CLI)

```powershell
$dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
& $dsh plugin --profile desktop add link:<插件目录>
```

Use the Desktop shim, not the npm `dsh` CLI: the npm CLI refuses `--profile desktop`. `link:` links the source, `file:` copies it.

---

## Configuration

Machine-local file: `%USERPROFILE%\.dsh\github-sync.json` (or `$env:DSH_HOME\github-sync.json`). It is never synced.

Minimal configuration:

```json
{
  "repo": "https://github.com/<you>/dsh-sync.git",
  "branch": "main",
  "deviceName": "workstation-a",
  "pathMappings": []
}
```

For a device where the workspace lives at a different path:

```json
{
  "pathMappings": [
    { "from": "E:\\my-workspace", "to": "D:\\wwa" }
  ]
}
```

`from` is the canonical path stored in the repository (usually the first device's path); `to` is the local path. The plugin creates missing directories, rewrites `workspace.json` paths, session `header.cwd` and path text inside events, and renames the session directory (`--E-work_with_yan--` → `--D-wwa--`). Keep `rewriteSessionPaths` and `createMissingWorkspaceDirs` at their defaults (`true`).

See [configuration.md](docs/configuration.md) for every field, default, range and precedence rule.

---

## Commands and tools

| Entry | Usage |
|---|---|
| Slash command | `/sync`, `/sync status`, `/sync sync` (aliases `push`/`pull`/`now`), `/sync init <repo-url>`, `/sync help` |
| Model tool | `github_sync` with `action: status \| sync \| init`, plus `repo`, `branch`, `dryRun` |
| CLI | `node bin\dsh-github-sync.mjs status \| sync [--dry-run] \| init --repo <url> [--branch] [--device] [--profile] \| doctor \| paths` |

A sync runs: adopt remote history on a fresh snapshot repo (and import it into the local home on a device's first sync) → export + commit → fetch + merge (fast-forward when only the remote advanced) → resolve conflicts → import into the local home → re-export → push (retry up to 3 times when another device pushed) → update local state and prune old backups.

---

## Conflicts and backups

- Default `onConflict: "keep-local"`: the local version wins; the other side is saved under the repository `.dsh-sync/conflicts/<device>/<timestamp>/`.
- If a local file changes while the sync is running (DSH still writing), the local version is always kept and the remote version is saved to both `$DSH_HOME/github-sync/conflicts/<timestamp>/` and the repository conflict directory.
- `prefer-remote` selects the remote side for real conflicts (Git merge conflicts and import-stage overwrites), backing up the local file first; `fail` aborts only on real conflicts (useful for strict auditing).
- `workspace.json` and patch files are merged semantically (by workspace id/path and patch row id) instead of whole-file replacement.
- On a device's **first sync**, remote state is imported before exporting: `workspace.json` is merged semantically, `cordis.patch.yml` is merged row by row (both sides' unique rows kept; same-id rows follow `onConflict`, default local), and remote sessions are imported. For other opaque settings files, a fresh DSH home (no sessions, workspaces or meaningful settings) lets the remote version win after a backup; an established device keeps local files and stores the remote variant as a conflict copy, unless `onConflict: "prefer-remote"` is set, in which case the local file is backed up and the remote version is applied.
- Local files overwritten or deleted during import are backed up to `$DSH_HOME/github-sync/backups/<timestamp>/` (retained `backup.keepDays`, default 30).
- Continuing the **same session** on two devices at the same time creates diverging append-only logs; the plugin does not merge them. Sync before switching devices.

Restore files by copying them back from the backup/conflict directories while DSH is fully closed. See [troubleshooting.md](docs/troubleshooting.md) for recovery procedures.

---

## Automatic sync

- Startup sync ~15 s after the plugin loads (`auto.startup`, default on).
- Periodic sync every 10 minutes (`auto.intervalMinutes`, `0` disables).
- After session writes, one sync ~120 s later (`auto.sessionDebounceSeconds`, `0` disables).
- Only one sync runs per process; overlapping requests are skipped.
- There is no sync on DSH exit; run `/sync sync` before closing if needed.
- `auto.*` is read at plugin load; other settings are re-read on every operation.

---

## Security

- Use a private repository only.
- Tokens are read from environment variables (`DSH_SYNC_GITHUB_TOKEN`, then `GH_TOKEN` / `GITHUB_TOKEN`), passed as a transient Git HTTP header for HTTPS remotes, never written to config/remote/logs, and redacted in errors. SSH remotes use your SSH credentials instead.
- `.credentials.yaml` and `.anonymous-user-id` are never synced; the second device must log in to DSH and configure model keys itself.
- The local snapshot repository, backups and conflict copies contain plaintext data copies.

---

## Limitations

- Imported workspaces/sessions are visible only after a **DSH restart** (the registry is read at startup).
- Session files locked by DSH are skipped for that run and retried on the next sync.
- Same-session concurrent editing forks the log; no automatic merge.
- Windows long-path limits apply even though `core.longpaths=true` is configured (enable system long-path support).
- DSH data formats (session v4, workspace v2) may change between DSH releases; the plugin does not version-check imported data.
- No cross-device lock, no Git LFS, no history compaction; repositories grow over time.
- No graphical settings UI.
- Windows + DSH Desktop is the documented environment; macOS/Linux are untested.

For the full Chinese documentation, start with [README.zh.md](README.zh.md); architecture and data-flow details are in [design.md](docs/design.md).
