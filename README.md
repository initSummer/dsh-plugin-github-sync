# dsh-plugin-github-sync v0.2.0

Near-real-time sync of DeepSeek Harness (DSH) settings, conversation logs, workspace registries, skills and attachments across devices through a **private GitHub repository**.

- **Version**: `v0.2.0`.
- **Target**: DSH `0.2.1-rc.2` Desktop on Windows (PowerShell). The plugin is a plain Node ESM Cordis host plugin with no third-party runtime dependencies.
- **DSH home**: `%USERPROFILE%\.dsh` by default (override with `DSH_HOME`).
- **Entry points**: `/sync` slash command, `github_sync` model tool, `bin/dsh-github-sync.mjs` CLI, and near-real-time background sync (enabled by default).

> Full Chinese manual: [README.zh.md](README.zh.md) · [installation](docs/installation.md) · [configuration](docs/configuration.md) · [troubleshooting](docs/troubleshooting.md) · [design](docs/design.md)

---

## Five warnings

1. 🔴 **Use a private repository.** Conversation text, tool output, attachments and skills are committed to Git history. The plugin does not check repository visibility.
2. 🔴 **`.credentials.yaml` is never synced.** DSH login state and model API keys stay on the local device; a second device must log in to DSH and configure its own provider keys.
3. 🔴 **Project files inside workspaces are never synced.** The plugin only projects data under `$DSH_HOME` (workspace registry, session logs, attachments, etc.). Sync project code/files with git, a cloud drive, or another tool.
4. 🔴 **Restart DSH once after installing or upgrading the plugin.** The realtime polling/hot-apply wiring is established at plugin load; after that, runtime sync needs no restarts.
5. 🔴 **Open sessions do not live-refresh, and writing the same session on two devices forks it.** DSH live sessions read the in-memory log only; remote updates are deferred (`pending`) until the session is closed/reopened or DSH restarts. Concurrent writes are not auto-merged; one side is kept and the other whole log is preserved as a conflict copy.

Also not synced: `~/.agents/skills`, project-level `.dsh/skills` / `.agents/skills`, `cache/`, `session_projcache/`, `node_modules/`, `dsh-runtimes/`, `agents-anywhere/`, DSH home directories outside the managed scopes, `.anonymous-user-id`, and plugin runtime data.

---

## Quick start

```powershell
# 1) Create a private repository (empty is fine), then set a user-level PAT (skip for SSH)
[Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')

# 2) Install (Desktop's dsh shim; plugin page or scripts/install.mjs also work)
dsh plugin --profile desktop add link:<plugin-dir>

# 3) Fully restart DSH Desktop once, then:
/sync init https://github.com/<you>/dsh-sync.git
```

With SSH (recommended for long-term use):

```text
/sync init git@github.com:<you>/dsh-sync.git
```

### 30-second checklist

```powershell
git --version
node --version                                  # CLI needs ^22.19.0 || >=24.0.0
[Environment]::GetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'User')   # PAT
ssh -T git@github.com                           # SSH
Test-Path "$env:USERPROFILE\.dsh\github-sync.json"
```

In DSH: `/sync help`, `/sync status`, and the `github_sync` tool should be available. If not, fully restart DSH once.

---

## What is synchronized

Default-on scopes:

| Scope | Repository path | Notes |
|---|---|---|
| `settings` | `home/storages/**`, `home/cordis.patch.yml`, `home/cordis.yml`, `profiles/<profileName>/cordis.patch.yml` | Plugin-owned patch rows are filtered out |
| `sessions` | `home/sessions/**` | zstd JSONL logs; append-only prefix extensions can be merged |
| `workspaces` | `home/storages/workspace.json`, `meta/workspaces.json` | Semantic merge; sidecar records origin device for `name · device` titles |
| `skills` | `home/skills/**`, `home/AGENTS.md`, `home/agents.md` | Only user-level skills inside DSH home |
| `attachments` | `home/attachments/**` | Images/files referenced by sessions |
| `market` | `home/storages/community_market/global.json`, `sources/**` | Catalog caches are not synced |

Optional (default off): `projections` (`session_projcache/**`, rebuildable) and `plugins` (profile `package.json` / lockfiles — can change the other device's plugin setup).

Never synced: workspace project files, `.credentials.yaml`, `.anonymous-user-id`, `~/.agents/skills`, project `.dsh/skills` / `.agents/skills`, `cache/`, `session_projcache/`, `node_modules/`, `dsh-runtimes/`, `agents-anywhere/`, DSH home directories outside the managed scopes, `.dsh-sync/` conflict copies, session locks/temp files.

---

## Credentials: PAT or SSH

**PAT (HTTPS)**:

- Create a Fine-grained PAT with **Contents: Read and write** (or a classic token with `repo`).
- Set `DSH_SYNC_GITHUB_TOKEN` as a **user** environment variable and fully restart DSH.
- `repo` = `https://github.com/<you>/<repo>.git`.

**SSH (recommended)**:

```powershell
ssh-keygen -t ed25519 -C "dsh-sync" -f "$env:USERPROFILE\.ssh\id_ed25519_dsh"
ssh-add "$env:USERPROFILE\.ssh\id_ed25519_dsh"
ssh -T git@github.com
```

Add the `.pub` as a **Deploy key** (repo Settings → Deploy keys → **Allow write access**) or an account SSH key, then:

```json
{ "repo": "git@github.com:<you>/<repo>.git" }
```

If port 22 is blocked, add to `~/.ssh/config`:

```text
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile C:\Users\<you>\.ssh\id_ed25519_dsh
  IdentitiesOnly yes
```

Windows ACL problems (`Bad owner or permissions on .ssh/config`) are fixed with `icacls` (remove inheritance; grant only the current user + SYSTEM + Administrators). GCM TLS errors such as `安全包中没有可用的凭证` are best bypassed with SSH, or HTTPS + `DSH_SYNC_GITHUB_TOKEN`. See [README.zh.md](README.zh.md) §4 for exact commands.

> SSH remotes do not use the token environment variable. Token values are never written to config, remote URLs or logs.

---

## Installation

### A. Desktop plugin page

Sidebar **Plugins** → **Add plugin** → local absolute path `<plugin-dir>` (or a Git URL). The package declares `dsh.bundle.patch`, so it installs as a bundle and is enabled automatically. Restart DSH.

### B. Desktop `dsh` shim

```powershell
$dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
& $dsh plugin --profile desktop add link:<plugin-dir>
```

Use the Desktop shim: the npm `dsh` CLI refuses `--profile desktop`.

### C. Install helper

```powershell
cd <plugin-dir>
node scripts\install.mjs        # or: npm run install:profile
```

### After installation

- Fully restart DSH **once** (required after install/upgrade; runtime sync then needs no restarts).
- Verify: `/sync help`, `/sync status`, the `github_sync` tool, and the plugin entry in the profile `package.json`.
- Optional: `dsh --profile desktop --dump-config` (may rewrite/initialize the profile; back it up first).

---

## Configuration

Machine-local file: `%USERPROFILE%\.dsh\github-sync.json` (or `$env:DSH_HOME\github-sync.json`). It is never synced.

Minimum:

```json
{
  "repo": "git@github.com:<you>/dsh-sync.git",
  "branch": "main",
  "deviceName": "workstation-a"
}
```

Realtime defaults (v0.2):

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

- `realtime.enabled` / `pushDebounceSeconds` are read when the plugin registers its listeners — restart after changing them;
- the other realtime fields are re-read each round;
- `realtime.enabled=false` falls back to the legacy `auto.intervalMinutes` mode (startup ~15 s, session debounce via `auto.sessionDebounceSeconds`);
- workspace titles are decorated as `name · device`; disabling only stops new suffixes (existing ones must be renamed manually);
- `onConflict` defaults to `keep-local`.

Different machine paths:

```json
{
  "pathMappings": [
    { "from": "E:\\projects\\foo", "to": "D:\\projects\\foo" }
  ]
}
```

`from` is the canonical path stored in the repository (usually the first device's path); `to` is the local path. Create the target directory beforehand. Do not use junctions/symlinks — DSH compares `realpath`.

See [configuration.md](docs/configuration.md) for every field.

---

## Multi-device (A → B)

**A**:

1. Install + restart once.
2. Configure PAT/SSH.
3. `/sync init <repo>` (or edit config + `/sync sync`).
4. Verify `home/`, `profiles/desktop/` and `meta/workspaces.json` in the repository.

**B**:

1. Install + restart once.
2. Use B's own PAT/SSH.
3. Configure the same `repo`, a different `deviceName`, and `pathMappings` if paths differ.
4. Create the mapped target directory.
5. Run the first sync — remote state is imported before exporting local data.
6. Restart DSH once after the first sync/path mapping if the sidebar does not settle; v0.2 hot apply normally shows results within seconds.
7. Subsequent realtime sync needs no restarts.

First-sync merge rules: `workspace.json` semantic merge; patch rows merged by id; other opaque settings default local + remote conflict copy (a fresh DSH home lets remote win); remote sessions imported.

---

## Realtime behavior (v0.2)

- New workspaces/sessions appear on the other device within **3–6 seconds** (polling 3 s active / 15 s idle; ~2 s after session writes).
- Workspace titles show the origin device (`wwa · jackfruit`), recorded in `meta/workspaces.json`.
- B operating in A's workspace/session syncs back to A; sessions A has not opened are updated and appear in the list.
- **Sessions opened on a device are not live-refreshed.** The update is deferred (`pendingSessionIds`, shown in `/sync status`); close/reopen the session or restart DSH.
- **Same session on two devices at once forks the append-only log.** The plugin merges only strict append-only prefixes; divergent histories keep one side and save the other whole log as a conflict copy. Do not continue the same session on two devices simultaneously.
- Polling traffic: ~1 KB per empty round, ~3–10 KB per changed round. Git smart HTTP does not consume GitHub's REST 5000/h quota but is subject to secondary rate limits; keep each device at ≤15 polls/minute. Tune intervals or disable `realtime` on a device.
- Repository history grows roughly 3–7× the raw session bytes due to whole-file zstd snapshots; no LFS built in. Consider periodically switching to a new private repository (update `repo` on **all** devices).

---

## Commands and tools

| Entry | Usage |
|---|---|
| Slash command | `/sync`, `/sync status`, `/sync sync` (aliases `push`/`pull`/`now`), `/sync init <repo-url>`, `/sync help` |
| Model tool | `github_sync` with `action: status \| sync \| init`, plus `repo`, `branch`, `dryRun` |
| CLI | `node bin\dsh-github-sync.mjs status \| sync [--dry-run] \| init --repo <url> [--branch] [--device] [--profile] \| doctor \| paths` |

`/sync status` shows the realtime mode (active/idle intervals, write debounce), workspace label setting, and pending live sessions.

A sync round: fetch/merge (fast-forward when only remote advanced; append-only session extensions accepted) → import with live gate → hot-apply (`workspaceRegistry`, `api-session/*`) → export + push (retry up to 3 times) → update state and prune backups.

`dryRun` / `--dry-run` only plans the export; it does not write the local home or snapshot repository, commit, or push.

---

## Conflicts and backups

- `keep-local` (default): local wins; the other side goes to `.dsh-sync/conflicts/<device>/<timestamp>/`.
- `prefer-remote`: remote wins for real conflicts; local files are backed up first at import stage.
- `fail`: aborts only on real conflicts (strict auditing).
- `workspace.json` is merged semantically; patch files are merged row by row; session logs use append-only prefix merging before falling back to the conflict policy.
- Open sessions are never overwritten; they become pending until closed.
- Local files overwritten/deleted during import are backed up to `$DSH_HOME/github-sync/backups/<timestamp>/` (retained `backup.keepDays`, default 30). Conflict copies are not auto-pruned.

Restore by copying files back while DSH is fully closed, or use `git revert` on the snapshot repo. See [troubleshooting.md](docs/troubleshooting.md).

---

## Security and limitations

- Private repository only; conversations/attachments are plaintext (zstd-compressed) in Git history.
- Tokens are read from environment variables only, passed as a transient HTTP header for HTTPS, never written to config/remote/logs, and redacted in errors.
- `.credentials.yaml` and `.anonymous-user-id` are never synced; the second device logs in and configures model keys itself.
- First install/upgrade requires one DSH restart; runtime hot apply needs none.
- Open sessions are not live-refreshed; same-session concurrent writes fork.
- No project-file sync, no Git LFS/history compaction, no cross-device lock, no graphical settings UI.
- DSH data formats (session v4, workspace v2) may change; the plugin does not version-check imported data.
- Windows long-path support is required for deep paths even with `core.longpaths=true`.
- Windows + DSH Desktop is the documented environment; macOS/Linux are untested.

---

## Appendix: sample config

Replace the account/repository/device name with your own; never put a token in this file.

```json
{
  "version": 1,
  "enabled": true,
  "repo": "git@github.com:initSummer/work_with_yan.git",
  "branch": "main",
  "deviceName": "jackfruit",
  "profileName": "desktop",
  "pathMappings": [],
  "rewriteSessionPaths": true,
  "createMissingWorkspaceDirs": true,
  "onConflict": "keep-local",
  "realtime": {
    "enabled": true,
    "intervalSeconds": 3,
    "idleIntervalSeconds": 15,
    "activeWindowSeconds": 90,
    "pushDebounceSeconds": 2,
    "workspaceDeviceLabel": true,
    "mergeAppendOnlySessions": true
  },
  "auto": { "startup": true, "intervalMinutes": 10, "sessionDebounceSeconds": 120 },
  "scopes": {
    "settings": true, "sessions": true, "workspaces": true,
    "skills": true, "attachments": true, "market": true,
    "projections": false, "plugins": false
  },
  "backup": { "enabled": true, "keepDays": 30 },
  "limits": { "maxFileMB": 100, "maxTotalMB": 4096, "maxSessions": 0 },
  "git": {
    "path": "git",
    "timeoutMs": 180000,
    "tokenEnv": "DSH_SYNC_GITHUB_TOKEN",
    "fallbackTokenEnvs": ["GH_TOKEN", "GITHUB_TOKEN"],
    "batchMode": true,
    "authorName": "DSH GitHub Sync",
    "authorEmail": "dsh-sync@localhost"
  },
  "commit": { "messagePrefix": "dsh-sync" }
}
```

For the complete Chinese manual (SSH/ACL/GCM, all troubleshooting cases, detailed field reference), start with [README.zh.md](README.zh.md).
