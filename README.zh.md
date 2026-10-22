# dsh-plugin-github-sync v0.2.0

> 用一条 `/sync` 命令，把本机 DSH 的设置、对话记录、工作区、技能和附件同步到你自己的 **GitHub 私有仓库**，并在多台设备之间**近实时**继续工作。

- 版本：`v0.2.0`（近实时多设备；首次安装或升级后重启一次 DSH，之后运行期无需重启）。
- 适用环境：DSH `0.2.1-rc.2` Desktop（Windows / PowerShell 为主；插件本身是纯 Node ESM，无第三方运行时依赖）。
- 仓库布局：插件把 `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`）的受管内容投影到私有仓库的 `home/`、`profiles/<profile>/` 与 `meta/workspaces.json`，再用 Git 提交/拉取/合并。
- 入口：对话里的 `/sync` 命令、模型可调用的 `github_sync` 工具、`bin/dsh-github-sync.mjs` 独立 CLI，以及默认开启的近实时后台同步。
- 实时能力：活跃时约每 3 秒、空闲时约每 15 秒轮询；本机有会话写入后约 2 秒触发同步；导入的工作区/会话通过 DSH 运行时热应用，**不需要重启 DSH** 就会出现在侧栏（已打开的会话除外，见下文）。

> ⚠️ **必须使用私有仓库。** 对话正文、工具输出、附件内容都会进入仓库；插件不会同步 `.credentials.yaml` 等密钥文件，但对话中有可能包含敏感信息。

---

## TL;DR 三步

```powershell
# 1) 在 GitHub 建一个私有仓库（空仓库也可以；首次同步会自动创建并推送 main），
#    然后设置用户级环境变量（永久；Desktop 重启后生效）：
[Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')

# 2) 安装插件（用 DSH Desktop 自带的 dsh 垫片，路径见下文；也可用「插件」页安装本地路径）：
dsh plugin --profile desktop add link:<插件目录>

# 3) 完全退出并重启 DSH Desktop，然后在对话里执行：
/sync init https://github.com/<you>/dsh-sync.git
```

首次同步会把本机数据推到仓库；换到第二台设备安装、配置好同一个仓库（必要时加 `pathMappings`）并同步一次后，工作区与会话会在数秒内出现在侧栏，**运行期不再需要重启**（首次安装/升级插件本身需要重启一次）。

---

## 目录

- [1. 同步什么、不同步什么](#1-同步什么不同步什么)
- [2. 前置条件（Git / 私有仓库 / Node / PAT）](#2-前置条件git--私有仓库--node--pat)
- [3. 安装](#3-安装)
- [4. 首次配置](#4-首次配置)
- [5. 多设备使用流程](#5-多设备使用流程)
- [6. 命令与工具](#6-命令与工具)
- [7. 配置字段参考](#7-配置字段参考)
- [8. 仓库布局与同步流程](#8-仓库布局与同步流程)
- [9. 冲突与数据安全](#9-冲突与数据安全)
- [10. 常见问题](#10-常见问题)
- [11. 安全与隐私](#11-安全与隐私)
- [12. 限制与未验证项](#12-限制与未验证项)
- [13. 路径速查](#13-路径速查)
- [14. 文档索引](#14-文档索引)

---

## 1. 同步什么、不同步什么

### 1.1 默认同步的内容

按 `scopes` 配置，默认开启以下六类：

| 范围 | 仓库内路径 | 内容 |
|---|---|---|
| `settings` | `home/storages/**`、`home/cordis.patch.yml`、`home/cordis.yml`、`profiles/<profileName>/cordis.patch.yml` | DSH 设置（`storages` 下除工作区/缓存/市场外的 JSON 域，如 `schedule.json`、`settings.json`）、profile 用户设置层、home 级 patch 层 |
| `sessions` | `home/sessions/**` | 对话日志 `session.v4.jsonl.zstd`（zstd 多帧 JSONL）；路径不变时按字节复制，路径变化时逐帧重写；追加扩展可自动合并（见 9.x） |
| `workspaces` | `home/storages/workspace.json`、`meta/workspaces.json` | 工作区注册表语义合并；`meta/workspaces.json` 记录每个工作区的来源设备，用于把侧栏标题显示为 `wwa · jackfruit` |
| `skills` | `home/skills/**`、`home/AGENTS.md`、`home/agents.md` | 用户级技能与全局 Agent 指令 |
| `attachments` | `home/attachments/**` | 会话引用的图片/文件附件（内容寻址对象库） |
| `market` | `home/storages/community_market/global.json`、`community_market/sources/**` | 插件市场源注册（权威用户意图；目录缓存不同步） |

以下两类**默认关闭**，可在需要时打开：

| 范围 | 默认 | 仓库内路径 | 说明 |
|---|---|---|---|
| `projections` | `false` | `home/storages/session_projcache/**` | 会话投影缓存（标题/todo/goal 等 UI 缓存），可重建，通常没必要同步 |
| `plugins` | `false` | `profiles/<profileName>/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`compatibility.json`、`.npmrc` | 插件清单/依赖锁。打开后会用 A 设备的插件清单覆盖 B，可能改变 B 的插件环境，慎用 |

### 1.2 永远不同步的内容

插件在导出和导入时都会跳过下列内容（代码里硬编码排除）：

| 路径 | 原因 |
|---|---|
| `home/.credentials.yaml` | 明文凭据（DSH 登录 token、模型 API key 等） |
| `home/.anonymous-user-id` | 设备级遥测身份，两台设备应各自独立 |
| `home/cache/**` | 派生缓存，可重建 |
| `home/github-sync/**` | 插件自己的快照仓库、状态、备份、冲突副本 |
| `home/storages/session_projcache/**` | 默认不同步（除非 `scopes.projections=true`） |
| `home/storages/community_market/catalog_cache/**` | 市场目录缓存 |
| `profiles/*/node_modules/**`、`.dsh-module-fallback/**` | 平台相关安装产物，B 上应自行安装 |
| `dsh-runtimes/**`、`agents-anywhere/**` | 随包运行时 / 远程访问桥，机器本地 |
| `profiles/*/cordis.yml` | 启动器生成的 profile root，不是用户设置 |
| 仓库里的 `.dsh-sync/**` | 冲突副本目录，导入时忽略 |
| `session.lock`、`*.tmp`、迁移临时文件、符号链接 | 锁/临时/非普通文件 |

> 会话文件被同名覆盖的问题由 `live` 闸门处理：会话正在本机打开时，远端更新暂缓应用（pending），关闭会话后自动应用。详见 [9.6](#96-打开中的会话pending)。

> B 设备不会拿到 A 的 DSH 登录状态和模型 API key：需要自己在 B 上登录 DSH、配置模型服务商 key。

---

## 2. 前置条件（Git / 私有仓库 / Node / PAT）

### 2.1 软件与账号

| 条件 | 要求 | 检查命令 |
|---|---|---|
| Git | 任意较新的 Git for Windows（插件通过 `git` CLI 工作） | `git --version` |
| GitHub 私有仓库 | 新建的空仓库或已有仓库均可；**必须私有**；若仓库已有分支，默认分支名需与配置的 `branch` 一致 | 浏览器创建 |
| Node.js | 插件运行在 DSH 自带 Node 里；若要使用独立 CLI，需要 Node `^22.19.0 || >=24.0.0`（依赖 `node:zlib` 的 zstd API） | `node --version` |
| DSH | Desktop `0.2.1-rc.2`（其他版本未验证） | 应用内查看 / `dsh --version` |

**关于空仓库**：无需先提交任何文件。首次同步会 fetch 远端（空仓库没有引用也不会失败），在本机导出并提交后自动创建并推送 `branch`（默认 `main`）。如果仓库已有分支，请让 `branch` 与远端默认分支一致，否则插件会在远端新建一个配置的分支。

### 2.2 创建 PAT（最小权限）

插件支持两种 token：

**方式 A：Fine-grained personal access token（推荐）**

1. GitHub → 右上头像 → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
2. **Resource owner** 选你的账号；**Repository access** 选 **Only select repositories**，只勾选同步用的私有仓库（例如 `dsh-sync`）。
3. **Repository permissions** → **Contents** 设为 **Read and write**（`Metadata` 会自动带只读）。
4. 设置合理的过期时间，生成后复制 token（只显示一次）。

**方式 B：Classic token**

GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)** → 勾选 `repo` scope（私有仓库读写）→ 生成并复制。

> token 不要写进 `github-sync.json`、仓库 URL 或任何会提交的文件；插件只从环境变量读取。

### 2.3 设置 `DSH_SYNC_GITHUB_TOKEN`

插件按以下顺序查找 token：`git.tokenEnv`（默认 `DSH_SYNC_GITHUB_TOKEN`）→ `git.fallbackTokenEnvs`（默认 `GH_TOKEN`、`GITHUB_TOKEN`）。

**仅当前 PowerShell 窗口有效（临时）**：

```powershell
$env:DSH_SYNC_GITHUB_TOKEN = "github_pat_xxxxxxxx"
```

适合：在同一窗口运行 CLI（`node bin\dsh-github-sync.mjs ...`）。**Desktop 的同步运行在 DSH 进程内，看不到其它 PowerShell 窗口的临时变量**；要让 DSH 使用 token，请用下面的永久设置并重启 Desktop。

**永久生效（推荐，当前用户级）**：

```powershell
[Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')
```

也可用 `setx DSH_SYNC_GITHUB_TOKEN "github_pat_xxxxxxxx"`（注意 `setx` 有长度/截断限制，且不会影响已打开的窗口）。

设置后需要**完全退出并重启 DSH Desktop**：Desktop 进程在启动时继承用户环境变量，仅重开一个对话不会生效。验证：

```powershell
[Environment]::GetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'User')
```

或运行 CLI 的 `doctor`（见 [6.3](#63-独立-cli)），它会显示“环境变量 xxx 已设置”，但不会打印 token 内容。

### 2.4 不用 PAT 的替代方式

- **Git Credential Manager（GCM）**：Git for Windows 自带。执行 `git credential-manager github login` 按提示登录后，HTTPS 推送会走系统凭据。插件在无 token 时会回退到本机 git credential。
- **SSH**：仓库地址改用 `git@github.com:<you>/dsh-sync.git`，并配置 SSH key（`ssh-keygen` → 把公钥加到 GitHub → `ssh -T git@github.com` 验证）。插件对 `git@` / `ssh://` 地址不会注入 token，完全依赖本机 SSH 配置；`git.batchMode=true` 时会用 `ssh -o BatchMode=yes`，因此私钥不能依赖交互式口令（请用 ssh-agent）。
- 两种方式二选一即可；HTTPS + token 是最省事的组合。

---

## 3. 安装

两种方式任选其一。安装完成后都建议**完全退出并重启 DSH Desktop**。下文以插件目录 `<插件目录>` 为例，其他设备请替换为实际路径（或使用 Git 仓库地址安装）。

### 3.1 方式 A：桌面「插件」页安装（图形界面）

1. 侧栏打开 **插件** 页 → **添加插件** / **安装第三方插件**。
2. 输入本地绝对路径：
   ```text
   <插件目录>
   ```
   或输入 Git 仓库地址（私有仓库需要可用的 Git 凭据）。
3. 确认安装成功。该入口只接受声明了 `dsh.bundle.patch` 的 bundle；本插件已在 `package.json` 中声明，安装后会插入行 id 为 `github-sync` 的插件行并自动启用。
4. 重启 DSH Desktop。

> 插件是 `"private": true` 的本地包，不要通过 npm 发布/安装；用本地路径或 Git 地址安装。

### 3.2 方式 B：Desktop 自带 CLI（`dsh` 垫片）

Desktop 会生成一个 `dsh.cmd` 垫片，默认 profile 就是 `desktop`，并且允许管理 desktop profile：

```powershell
# 找到最新的 dsh 垫片
$dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
$dsh

# 安装（link: 开发链接，不复制代码；file: 复制安装）
& $dsh plugin --profile desktop add link:<插件目录>
```

如果 Desktop 已经把 `dsh` 加到 PATH，也可以直接：

```powershell
dsh plugin --profile desktop add link:<插件目录>
```

注意：

- **npm 版 `dsh` 会拒绝 `--profile desktop`**，必须用 Desktop 垫片或桌面插件页。
- `link:` 适合本机开发：修改插件源码后重启 DSH 生效（`package.json` 的 `exports`/`main` 变更需要重新安装或重启）。
- `file:` 会复制一份安装，适合固定版本。
- 卸载：`& $dsh plugin --profile desktop remove dsh-plugin-github-sync`，然后重启 DSH。卸载不会删除已同步的数据，也不会删除 `$DSH_HOME/github-sync.json` / `$DSH_HOME/github-sync/`。

### 3.3 方式 C：安装脚本（可选）

插件自带 `scripts/install.mjs`，会自动查找 Desktop 的 `dsh` 垫片并执行上面的 `add link:`：

```powershell
cd <插件目录>
node scripts\install.mjs                 # 默认 desktop profile
node scripts\install.mjs --profile desktop --print   # 只打印将要执行的命令
```

或使用 package script：

```powershell
npm run install:profile
```

### 3.4 安装后验证

1. 完全退出 DSH Desktop（托盘图标退出，确保进程结束）后重新打开。**安装或升级插件后必须重启一次**；之后运行期的同步不需要再重启。
2. 对话输入 `/`，应能看到 `sync` 命令；输入 `/sync help` 应返回用法。
3. 模型侧工具 `github_sync` 也应可见（例如让它调用 `action="status"`）。
4. 若 `/sync` 不存在：检查插件页是否启用、DSH 日志是否有加载错误，再重启一次。

---

## 4. 首次配置

同步配置是**机器本地**文件，不会被同步：

```text
%USERPROFILE%\.dsh\github-sync.json
```

若设置了 `DSH_HOME`，则是 `$env:DSH_HOME\github-sync.json`。

### 4.1 方式一：编辑配置文件（可控、推荐用于多设备）

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
notepad "$dshHome\github-sync.json"
```

写入下面这份完整示例（最少只需把 `repo` 改成你的私有仓库；其它字段都有默认值）：

```json
{
  "$schema": "https://github.com/deepseek-harness/dsh-plugin-github-sync#configuration",
  "version": 1,
  "enabled": true,
  "repo": "https://github.com/<you>/dsh-sync.git",
  "branch": "main",
  "remoteName": "origin",
  "deviceName": "workstation-a",
  "profileName": "desktop",
  "pathMappings": [],
  "rewriteSessionPaths": true,
  "createMissingWorkspaceDirs": true,
  "onConflict": "keep-local",
  "auto": {
    "startup": true,
    "intervalMinutes": 10,
    "sessionDebounceSeconds": 120
  },
  "realtime": {
    "enabled": true,
    "intervalSeconds": 3,
    "idleIntervalSeconds": 15,
    "activeWindowSeconds": 90,
    "pushDebounceSeconds": 2,
    "workspaceDeviceLabel": true,
    "mergeAppendOnlySessions": true
  },
  "scopes": {
    "settings": true,
    "sessions": true,
    "workspaces": true,
    "skills": true,
    "attachments": true,
    "market": true,
    "projections": false,
    "plugins": false
  },
  "backup": {
    "enabled": true,
    "keepDays": 30
  },
  "limits": {
    "maxFileMB": 100,
    "maxTotalMB": 4096,
    "maxSessions": 0
  },
  "excludeSessionIds": [],
  "excludeWorkspacePaths": [],
  "git": {
    "path": "git",
    "timeoutMs": 180000,
    "tokenEnv": "DSH_SYNC_GITHUB_TOKEN",
    "fallbackTokenEnvs": ["GH_TOKEN", "GITHUB_TOKEN"],
    "batchMode": true,
    "authorName": "DSH GitHub Sync",
    "authorEmail": "dsh-sync@localhost"
  },
  "commit": {
    "messagePrefix": "dsh-sync"
  }
}
```

注意：

- `repo` 必须是完整 URL（`https://github.com/...`、`git@github.com:...` 或 `ssh://...`），`/sync init` 会校验；不接受 `owner/name` 简写。
- JSON 里 Windows 路径的反斜杠要写成双反斜杠：`"E:\\my-workspace"`。
- `deviceName` 用来区分提交和冲突副本，两台设备请设成不同值（默认取主机名）。
- 文件保存为 UTF-8 即可（插件会容忍 BOM）。

然后执行首次同步：

```text
/sync sync
```

### 4.2 方式二：对话里一条命令完成配置 + 首次同步

```text
/sync init https://github.com/<you>/dsh-sync.git
```

它会：

1. 读取/创建 `$DSH_HOME/github-sync.json`（保留已有字段，写入 `enabled: true`、`repo`、`branch`、`deviceName`、`profileName`）；
2. 立即执行一次完整同步。

等价的 CLI 写法（适合 DSH 未启动或需要脚本化时）：

```powershell
cd <插件目录>
$env:DSH_SYNC_GITHUB_TOKEN = "github_pat_xxxxxxxx"
node bin\dsh-github-sync.mjs init --repo https://github.com/<you>/dsh-sync.git --device workstation-a
```

> 已配置过仓库时，`/sync init <新地址>` 会直接用新地址覆盖 `repo`，请确认再执行。

### 4.3 改配置后要不要重启？

| 改动 | 生效时机 |
|---|---|
| `repo`、`branch`、`scopes`、`pathMappings`、`onConflict`、`limits`、`backup`、`git.path` 等 | 每轮同步/状态查询都会重新读取配置文件，通常在**下一轮轮询**（数秒内）生效，无需重启 |
| `realtime.intervalSeconds` / `idleIntervalSeconds` / `activeWindowSeconds` / `workspaceDeviceLabel` / `mergeAppendOnlySessions` | 每轮读取，通常下一轮生效，无需重启 |
| `realtime.enabled` / `realtime.pushDebounceSeconds` | 在插件加载时用于建立轮询/会话事件监听，修改后建议**重载插件或重启 DSH** |
| `auto.*`（启动同步、legacy 定时/写后窗口） | 只在插件加载时读取，**需要重载插件或重启 DSH**；`realtime.enabled=false` 时才会用到其中大部分字段 |
| 环境变量（token） | DSH 进程启动时继承，**需要完全重启 DSH Desktop** |
| 插件代码升级（v0.2.0 及以后） | 升级后重启一次 DSH；之后运行期实时同步无需再重启 |

> Desktop 的 HMR 可能在改动 profile 配置或 `link:` 包文件时自动重载插件，但安装/升级后的行为以**完全重启 DSH Desktop** 为准；`/sync` 命令消失时优先尝试重启。

---

## 5. 多设备使用流程

假设两台设备 A、B 都安装同一插件、配置同一个私有仓库。v0.2.0 默认开启近实时同步：两台设备都运行时，任意一端的改动通常会在数秒内出现在另一端，不需要重启 DSH。核心原则仍是：**不要在两端同时打开并继续同一个会话**。

### 5.1 A 设备：建立基线

```powershell
# 为桌面 DSH 设置用户级环境变量（永久），设置后完全重启 DSH Desktop
[Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')
```

```text
/sync init https://github.com/<you>/dsh-sync.git
```

成功后：

- 本机快照仓库出现在 `%USERPROFILE%\.dsh\github-sync\repo`；
- GitHub 仓库里出现 `home/`（以及可能存在 `profiles/desktop/`）目录与一次 `dsh-sync[workstation-a]: export ...` 提交；
- `/sync status` 能看到仓库、分支、设备、最近同步时间。

### 5.2 B 设备：安装并同步

1. 按 [3. 安装](#3-安装) 在 B 上安装插件，并设置 B 自己的 `DSH_SYNC_GITHUB_TOKEN`（或 GCM/SSH）。
2. 编辑 B 的 `$DSH_HOME\github-sync.json`，至少设置：
   - `repo`：同一个仓库地址；
   - `deviceName`：和 A 不同的名字（如 `workstation-b`）；
   - `pathMappings`：**仅当 B 上工作区路径与 A 不同时才需要**（见 5.3）。
3. 执行一次同步（DSH 里 `/sync sync`，或先关闭 DSH 用 CLI `node bin\dsh-github-sync.mjs sync`）。
   > 首次同步时 B 还没有同步状态，插件会**先把远端（A）的版本导入本机**，并与本机内容合并：
   > - `workspace.json`：语义合并（本机工作区保留，远端工作区与会话并入）；
   > - `cordis.patch.yml`：按行 id 合并（远端行与本机独有行都保留，同 id 行按 `onConflict`，默认保留本机）；
   > - 其它不透明设置文件（如 `schedule.json`）：默认保留本机并保存/备份远端副本；`onConflict: "prefer-remote"` 时先备份本机再采用远端版本；如果 B 是全新 home（无会话、无工作区、profile 设置为空），则远端优先，避免空设置覆盖远端；
   > - 会话：远端会话按路径映射导入，本机会话保留。
   >
   > 如果 B 上已有重要本地数据，建议先备份或确认后再同步。
4. 首次安装或升级插件后，B 需要**完全重启 DSH Desktop 一次**；此后运行期同步（包括 A 的改动、B 新建的会话/工作区）都会实时热应用，**不再需要重启**。工作区与会话通常会在 3–6 秒内出现在侧栏。

### 5.3 路径不同时：配置 `pathMappings`

A 的工作区在 `E:\my-workspace`，B 上放在 `D:\wwa`。在 **B** 的 `github-sync.json` 里加：

```json
"pathMappings": [
  { "from": "E:\\my-workspace", "to": "D:\\wwa" }
]
```

语义：

- `from` 是**仓库里保存的规范路径**（通常就是 A 的路径），`to` 是 B 本机路径；
- 可以配置多条；前缀最长者优先；Windows 下大小写不敏感；
- 也接受对象写法：`{ "E:\\my-workspace": "D:\\wwa" }`。

B 首次同步会先把远端（A）的数据导入本机（`workspace.json` 语义合并、patch 按行合并、不透明设置按 `onConflict`），其中与路径相关的处理是：

1. 自动创建 `D:\wwa`（`createMissingWorkspaceDirs=true` 时）；
2. 把 `workspace.json` 中对应工作区的 `path` 改写成 B 上的真实路径（`realpath` 后，含盘符大小写等）；
3. 把会话 `header.cwd` 以及会话事件文本里的旧路径（含单反斜杠、双反斜杠、正斜杠写法）重写为新路径；
4. 把会话目录从 `--E-work_with_yan--` 重命名为 `--D-wwa--`，并把文件放到 B 的 `sessions/<新目录名>/<会话 id>/` 下。

配置好并同步后，B 上侧栏会多出该工作区，历史会话可以直接打开继续。B 上工作区标题可能仍沿用 A 的目录名（如 `work_with_yan`），可在侧栏重命名，不影响同步。

如果 B 之后继续这些会话，下一次同步会把 B 的路径再映射回 A 的规范路径，A 同步后路径保持一致。

> **不要用 junction / 符号链接代替 `pathMappings`**：DSH 用 `realpath` 规范化工作区路径，链接会解析成真实目标，容易导致会话匹配不上工作区。请让插件做路径重写。

### 5.4 两台设备路径相同

如果 B 上也能使用同一绝对路径（例如同样有 `E:\my-workspace`，或把内容放到相同路径），则 `pathMappings` 保持 `[]` 即可，插件只做字节复制，风险最低。

### 5.5 实时多设备行为（v0.2.0）

- **工作区/会话免重启出现**：插件在 host 内通过 DSH 的 workspace registry 与 session 事件热应用同步结果，并推送到浏览器（工作区走 `workspace/follow`，会话走 `api-session/added|activity|removed`）。A 的改动在 B 上通常 3–6 秒内可见，反之亦然。
- **工作区标题显示来源设备**：仓库里的 `meta/workspaces.json` 记录每个工作区的来源设备，侧栏标题形如 `wwa · jackfruit`。本机设置 `"realtime": { "workspaceDeviceLabel": false }` 可关闭该后缀（只阻止继续追加；已带后缀的标题需手动改名，建议在所有设备上统一关闭）。
- **B 在 A 的工作区/会话里操作**：B 新建会话或追加事件后，A 会在数秒内收到；A 未打开该会话时文件自动更新并出现在列表中。
- **A 已打开该会话时不会实时刷新消息**：DSH 的 live session 只读内存、没有 reload API，插件会**暂缓覆盖**（pending）；关闭并重新打开该会话（或重启 DSH）后即可看到远端更新。`/sync status` 会显示待应用会话数。
- **同一会话双端同时写**：DSH 是单写者/连续 `seq` 契约，两端各自追加会产生分叉；插件不会自动合并分叉，默认保留本机整份日志 + 远端整份日志作为冲突副本 + 告警，需要手动 fork/取舍。避免在两台设备上同时打开并继续同一个会话。
- **追加合并**：当一端的日志是另一端的严格前缀扩展（先同步、后继续）时，插件会直接采用较长的一份，不产生冲突、不重编号。

### 5.6 日常使用建议

- **避免同时打开同一个会话**：这是唯一无法完全自动化处理的场景；需要切换设备时先确保另一端已关闭该会话（或至少停止写入）。
- 实时同步默认开启（活跃 3s / 空闲 15s 轮询、写后约 2s 触发），通常不需要手动 `/sync sync`；遇到网络异常或需要立即确认时再手动执行。
- 如果只想让一台设备推送、另一台只读，可在只读设备上把 `realtime.enabled` 设为 `false`，或把 `auto.*` 的周期调大/关闭；也可以干脆不同步该设备。
- 新设备首次同步、或升级插件后，记得重启 DSH 一次（仅此一次）。

---

## 6. 命令与工具

### 6.1 斜杠命令 `/sync`

| 命令 | 作用 |
|---|---|
| `/sync` 或 `/sync status` | 查看状态：仓库、分支、设备、profile、配置文件、同步范围、实时同步模式（活跃/空闲间隔、写后延迟）、工作区设备标签、路径映射、git、本地快照 HEAD、最近同步/错误、待应用（pending）会话数、最近冲突、本机会话数、配置提示 |
| `/sync sync` | 立即执行一次完整同步（别名：`/sync push`、`/sync pull`、`/sync now`） |
| `/sync init <仓库地址>` | 写入/更新本机配置并立即执行首次同步 |
| `/sync help` | 显示用法 |

命令结果只显示在 UI 中，不会写入模型消息；同步过程与结果也会记录在插件日志里。状态里如果出现“待应用（本机打开中的会话）：N 个”，表示有远端更新被 live 闸门暂缓，关闭对应会话后会自动应用（也可重启 DSH 立即应用）。

示例输出（节选）：

```text
✅ DSH GitHub 同步完成（设备 workstation-a，分支 main）
仓库：https://github.com/you/dsh-sync.git
提交：a1b2c3d4e5f6
方向：拉取远端更改 / 已推送
文件：导出 42 个；本机写入 0 个、更新 3 个、删除 0 个
```

### 6.2 模型工具 `github_sync`

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `status` \| `sync` \| `init` | 必填 |
| `repo` | string | `action=init` 时使用，GitHub 仓库 URL |
| `branch` | string | `action=init` 时使用，默认沿用当前配置（`main`） |
| `dryRun` | boolean | `action=sync` 时试运行：只规划导出，不写本机、不修改快照仓库、不提交、不推送 |

模型可以在对话里用它检查/触发同步，无需访问 shell。`dryRun` 的准确含义见 [9.5](#95-试运行dry-run)。

### 6.3 独立 CLI

```powershell
cd <插件目录>

node bin\dsh-github-sync.mjs status                # 查看状态
node bin\dsh-github-sync.mjs sync                  # 执行一次同步
node bin\dsh-github-sync.mjs sync --dry-run        # 试运行
node bin\dsh-github-sync.mjs init --repo https://github.com/<you>/dsh-sync.git `
  --branch main --device workstation-a --profile desktop
node bin\dsh-github-sync.mjs doctor                # 检查 git / 配置 / token / 状态
node bin\dsh-github-sync.mjs paths                 # 打印相关路径
node bin\dsh-github-sync.mjs help                  # 用法
```

要点：

- CLI 与插件读取**同一份** `$DSH_HOME/github-sync.json` 和 `state.json`，共用快照仓库。
- CLI 适合：首次配置、DSH 无法启动时恢复、计划任务/cron、在同步前先看清 `doctor` 的检查结果。
- 运行 CLI 的 Node 需要 `^22.19.0 || >=24.0.0`；在 DSH Desktop 自带的 Node 环境下执行也可以，但最省事的是系统 Node 24。
- 同步/初始化失败时退出码为 1；参数错误为 2；`doctor` 有阻塞问题时为 1。
- `--dry-run` 只做导出规划与统计，不写本机 DSH 数据、不创建/修改快照仓库、不提交、不推送。

---

## 7. 配置字段参考

配置文件：`$DSH_HOME/github-sync.json`。合并顺序：**内置默认值 ← profile patch 行的 `config:` ← 本机 JSON**（本机 JSON 优先）。数组字段整体替换，不追加。

### 7.1 顶层字段

| 字段 | 类型 / 默认值 | 说明与建议 |
|---|---|---|
| `$schema` | string / 内置 URL | 仅用于编辑器提示，可删 |
| `version` | number / `1` | 配置格式版本，当前无迁移逻辑 |
| `enabled` | boolean / `true` | 是否启用**后台同步**（近实时/自动）；当 `repo` 为空时会被强制视为 `false`。手动 `/sync sync` 不受此字段限制 |
| `repo` | string / `""` | **必填**。GitHub 私有仓库完整 URL；支持 `https://`、`git@`、`ssh://`。不支持 `owner/name` 简写 |
| `branch` | string / `"main"` | 同步分支，必须与远端默认分支一致 |
| `remoteName` | string / `"origin"` | 快照仓库里的远端名，一般不用改 |
| `deviceName` | string / 主机名 | 设备标识，用于提交信息和冲突副本目录；会清理为 `[A-Za-z0-9._-]`，最长 48。多设备请设不同值 |
| `profileName` | string / `"desktop"` | 要同步的 DSH profile 名；只处理 `profiles/<profileName>/`，仓库里其它 profile 目录会被忽略 |
| `pathMappings` | array / `[]` | 路径映射，见 7.2 |
| `rewriteSessionPaths` | boolean / `true` | 是否重写会话中的路径（`header.cwd` 与事件内文本）。使用 `pathMappings` 时必须为 `true`，否则需要重写的会话会被跳过并告警 |
| `createMissingWorkspaceDirs` | boolean / `true` | 导入时自动创建映射后的工作区目录，并用 `realpath` 规范化；关闭后工作区可能因目录不存在而不显示 |
| `onConflict` | `"keep-local"` \| `"prefer-remote"` \| `"fail"` / `"keep-local"` | 冲突策略（Git 合并冲突 + 导入阶段双方都改的冲突），见 [9.1](#91-冲突策略) |
| `excludeSessionIds` | string[] / `[]` | 导出时跳过这些会话 id（匹配会话 header 的 `id`）；只影响导出，仓库中已存在的会话仍可能被导入 |
| `excludeWorkspacePaths` | string[] / `[]` | 不同步这些本机工作区（精确匹配工作区路径，不含子路径；Windows 下不区分大小写；填写本机路径）：导出时跳过该工作区的会话、从仓库的 `workspace.json` 中剔除对应记录并重建不变量；导入时也跳过对应的会话与工作区记录。不会删除本机数据，也不会从仓库历史中删除已上传内容 |
| `backup.enabled` | boolean / `true` | 覆盖或删除本机文件前是否备份 |
| `backup.keepDays` | number / `30`（1–3650） | 成功同步后清理超过该天数的备份目录；冲突副本目录不自动清理 |
| `limits.maxFileMB` | number / `100`（0.1–4096） | 单文件大小上限，超过则跳过并告警；大附件/长会话可能触发 |
| `limits.maxTotalMB` | number / `4096`（1–1048576） | 单次导出的总大小上限，超出部分跳过并告警 |
| `limits.maxSessions` | number / `0`（0–1,000,000） | 最多导出多少个会话，`0` 表示不限 |
| `commit.messagePrefix` | string / `"dsh-sync"` | 提交信息前缀 |

### 7.2 `pathMappings` 写法

```json
"pathMappings": [
  { "from": "E:\\my-workspace", "to": "D:\\wwa" }
]
```

或对象写法：

```json
"pathMappings": {
  "E:\\my-workspace": "D:\\wwa"
}
```

- `from`：仓库中保存的规范路径（A 设备上的路径）；
- `to`：本机真实路径；
- 前缀匹配，最长前缀优先；Windows 大小写不敏感；
- 路径会被规范化为绝对路径，并去掉末尾分隔符；
- 导入时还会经过 `realpath`，让最终路径与 DSH 记录的 `workspace.path` 逐字一致。

### 7.3 `realtime`：近实时同步（v0.2.0 默认）

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `realtime.enabled` | `true` | boolean | 开启近实时自适应轮询；设为 `false` 回退到 `auto.intervalMinutes` 定时模式 |
| `realtime.intervalSeconds` | `3` | 1–3600 | 活跃状态下的轮询间隔（秒）。最近 90 秒内有会话活动即视为活跃 |
| `realtime.idleIntervalSeconds` | `15` | 1–3600 | 空闲状态下的轮询间隔（秒） |
| `realtime.activeWindowSeconds` | `90` | 5–3600 | 多久没有会话活动后从活跃切换到空闲 |
| `realtime.pushDebounceSeconds` | `2` | 0–600 | 有会话写入后，延迟多久触发同步（秒）；`0` 表示不因写入额外触发 |
| `realtime.workspaceDeviceLabel` | `true` | boolean | 工作区标题是否追加来源设备后缀（`wwa · jackfruit`） |
| `realtime.mergeAppendOnlySessions` | `true` | boolean | Git 合并冲突时，若两条会话日志是严格追加/前缀关系，是否自动采用较长的一份（不重编号、不合并分叉） |

行为说明：

- **自适应轮询**：活跃时约 3 秒一轮，空闲时约 15 秒一轮；两端都运行时，一次改动通常在数秒内同步到另一端。
- **写后触发**：本机收到 `session/event` 后约 2 秒触发一轮同步，并与定时轮询共享单飞锁。
- **失败退避**：连续失败时按 5s → 10s → 20s → 40s → 60s（上限 60s）指数退避并加 ±20% 抖动，避免网络故障时高频打 GitHub。
- **无变化快路径**：本机没有新提交、远端也没有前进、且没有 pending 会话时，一轮只做 fetch/比较就返回，不执行昂贵导入。
- **流量与限流**（估算，供容量规划参考）：空轮询约 1 KB/次；有变更时增量约 3–10 KB。Git 的 smart HTTP 端点不消耗 GitHub REST 的 5000 次/小时配额，但受**二级限流**约束；建议每设备控制在 **≤15 次/分钟**（默认配置远低于此）。多设备/大仓库可适当调大 `intervalSeconds`/`idleIntervalSeconds`，或在某台设备关闭 `realtime`。

> `realtime.enabled` 与 `realtime.pushDebounceSeconds` 在插件加载时用于注册事件监听；修改这两项建议重启一次 DSH。其它 realtime 字段在下一轮读取。

### 7.4 `auto`：启动同步与 realtime 关闭时的兜底

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `auto.startup` | `true` | boolean | 启动后先跑一轮：realtime 开启时约 **5 秒**后；realtime 关闭时约 15 秒后 |
| `auto.intervalMinutes` | `10` | 0–1440 | **仅 realtime 关闭时**的定时间隔（分钟）；`0` 关闭 |
| `auto.sessionDebounceSeconds` | `120` | 0–3600 | **仅 realtime 关闭时**，会话写入后约 120 秒触发一次同步；`0` 关闭 |

自动/实时同步与手动同步共享单飞锁：同一进程内同时只有一个同步在跑，重叠请求会被跳过并提示“另一个同步任务正在进行中”。

> 退出 DSH 时不会自动同步（退出阶段无法可靠等待同步完成）。请依赖实时/定时同步，或养成在关闭 DSH 前手动执行一次 `/sync sync` 的习惯。

### 7.5 `scopes`：同步范围

| 字段 | 默认 | 对应路径 |
|---|---|---|
| `scopes.settings` | `true` | `home/storages/**`（工作区、projcache、community_market 除外）、`home/cordis.patch.yml`、`home/cordis.yml`、`profiles/<profileName>/cordis.patch.yml` |
| `scopes.sessions` | `true` | `home/sessions/**` |
| `scopes.workspaces` | `true` | `home/storages/workspace.json` |
| `scopes.skills` | `true` | `home/skills/**`、`home/AGENTS.md`、`home/agents.md` |
| `scopes.attachments` | `true` | `home/attachments/**` |
| `scopes.market` | `true` | `home/storages/community_market/global.json`、`community_market/sources/**` |
| `scopes.projections` | `false` | `home/storages/session_projcache/**`（可重建缓存） |
| `scopes.plugins` | `false` | `profiles/<profileName>/` 的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`compatibility.json`、`.npmrc` |

注意：

- 关闭 `workspaces` 但保留 `sessions` 时，导入的会话不会自动登记到工作区列表；插件会在状态里提示。
- 关闭 `sessions` 但保留 `workspaces` 时，远端工作区可能指向缺失的会话。
- 打开 `plugins` 会同步插件清单，可能改变 B 的插件环境，非必要不建议开。

### 7.6 `git`：Git 与认证

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `git.path` | `"git"` | string | git 可执行文件名或绝对路径；找不到时会尝试 Windows 常见安装路径 |
| `git.timeoutMs` | `180000` | 5000–3600000 | 单条 git 命令超时（毫秒） |
| `git.tokenEnv` | `"DSH_SYNC_GITHUB_TOKEN"` | string | 首选 token 环境变量名 |
| `git.fallbackTokenEnvs` | `["GH_TOKEN", "GITHUB_TOKEN"]` | string[] | 备用 token 环境变量 |
| `git.batchMode` | `true` | boolean | 非交互模式：`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、SSH `BatchMode=yes`，避免后台同步卡在凭据提示 |
| `git.authorName` | `"DSH GitHub Sync"` | string | 提交作者名 |
| `git.authorEmail` | `"dsh-sync@localhost"` | string | 提交作者邮箱 |

插件如何用 token：仅当远端是 `https://` 地址时，把 token 作为临时 `http.extraHeader` 传给 git（`x-access-token:<token>` 的 Basic 认证），**不会写入仓库配置、远程 URL 或日志**；错误信息中也会做脱敏。`git@` / `ssh://` 地址不使用 token，走 SSH 凭据。

---

## 8. 仓库布局与同步流程

### 8.1 本机数据布局

```text
%USERPROFILE%\.dsh\
├─ github-sync.json              ← 本机配置（不同步）
├─ github-sync\
│  ├─ repo\                      ← 快照 git 工作区（已 clone/fetch 的仓库内容）
│  ├─ state.json                 ← 本机状态：managed 文件表、pendings、最近错误/历史（不同步）
│  ├─ backups\<时间戳>\          ← 被覆盖/删除的本机文件备份
│  └─ conflicts\<时间戳>\        ← 本机冲突副本（另一方版本）
├─ sessions\                     ← 对话日志
├─ storages\                     ← workspace.json 等
├─ profiles\desktop\             ← 设置与插件清单
└─ ...
```

### 8.2 私有仓库布局

```text
<repo>/
├─ .gitattributes                 ← 首次同步自动生成（会话按二进制处理，文本统一 LF）
├─ home/
│  ├─ sessions/--E-work_with_yan--/session-<id>/session.v4.jsonl.zstd
│  ├─ storages/workspace.json
│  ├─ storages/settings.json     ← 按你本机实际存在的文件
│  ├─ cordis.patch.yml           ← 如果本机存在 home 级 patch
│  ├─ skills/<skill>/SKILL.md
│  ├─ AGENTS.md
│  └─ attachments/v1/objects/...
├─ profiles/desktop/
│  └─ cordis.patch.yml           ← profile 用户设置层
├─ meta/
│  └─ workspaces.json            ← 工作区来源设备映射（标题「base · device」后缀）
└─ .dsh-sync/
   └─ conflicts/<device>/<时间戳>/...   ← 只在发生合并冲突后出现
```

`.gitattributes` 由插件创建，内容类似：

```text
* -text
*.json text eol=lf
*.jsonl text eol=lf
*.yml text eol=lf
*.yaml text eol=lf
*.md text eol=lf
```

这样会话 zstd 二进制不会被 Git 做行尾转换，JSON/YAML 仍可正常 diff。

### 8.3 一次同步做了什么

```text
（realtime 每轮，默认活跃 3s / 空闲 15s 触发）
  → 读取配置/状态（有会话写入时提前到约 2s 后触发；无变化时只 fetch 比较后返回）
  → 确保快照仓库存在（首次会 init；本机还没有任何快照提交时，先 fetch 并 reset 到远端分支，采用远端历史）
  → 首次同步（本机还没有同步状态）：先把远端内容导入本机（workspace.json 语义合并、patch 按行合并；不透明设置：全新 home 远端优先，已有本地数据则本机优先、远端版本存冲突副本），再导出本机数据
  → 导出本机数据到快照仓库工作区（含 meta/workspaces.json 设备来源）
  → 提交（dsh-sync[<device>]: export ...）
  → fetch 远端分支（本地落后则 fast-forward 并导入；双方分叉则 merge，冲突按策略处理；会话严格追加关系可自动采用较长日志）
  → 把合并后的仓库内容导入本机（live 闸门：打开中的会话暂缓为 pending；workspace.json 交给运行时 registry 热应用）
  → 热应用：workspaceRegistry create/setTitle/attachSession；推送 api-session/added|activity|removed
  → 再导出一次（让语义合并结果在仓库中规范化）→ 应用工作区设备标签
  → push（被拒时重新 fetch/merge，最多重试 3 轮；空仓库此时自动创建分支）
  → 更新 state.json（含 pendingSessionIds），清理过期备份
```

详细设计（数据投影规则、workspace 合并算法、实时轮询、live 闸门、会话 zstd 重写、冲突判定）见 [docs/design.md](docs/design.md)。

### 8.4 实时轮询与热应用

- **轮询**：默认开启（`realtime.enabled=true`）。活跃时每约 3 秒、空闲时每约 15 秒跑一轮；最近 90 秒内有会话写入即视为活跃；连续失败指数退避到 60 秒并加抖动。关闭 realtime 后回退到 `auto.intervalMinutes` 定时模式。
- **写后触发**：`session/event` 后约 2 秒触发一轮（`realtime.pushDebounceSeconds`），与轮询共用单飞锁。
- **工作区热应用**：运行时存在 `workspaceRegistry` 时，插件不直接写 `workspace.json`，而是通过 registry 的 `create` / `setTitle` / `attachSession` 应用合并结果；registry 的 `domain/changed` 会驱动 Web 客户端的 `workspace/follow`，侧栏即时更新。
- **会话热应用**：新导入的会话通过 `api-session/added` 加入列表，更新/删除分别用 `api-session/activity` / `api-session/removed`；不需要重启 DSH。
- **live 闸门**：本机 `sessions.list()` 中正在打开的会话，其远端文件更新会被暂缓（`pendingSessionIds` 写入 `state.json`，`/sync status` 显示数量），关闭该会话后下一轮自动应用；不会覆盖 live session 的内存日志。
- **工作区标题**：仓库 `meta/workspaces.json` 记录来源设备；导入/导出时标题追加 ` · <device>`，本机也可通过 `realtime.workspaceDeviceLabel=false` 关闭。

---

## 9. 冲突与数据安全

### 9.1 冲突策略

`onConflict` 影响 **Git 合并冲突**以及**导入阶段“本机与远端都改”的冲突**；`workspace.json` 和 patch 文件始终按条目语义合并。

| 取值 | 行为 | 适用场景 |
|---|---|---|
| `keep-local`（默认） | 其他文件冲突时保留本机版本，对方版本写入仓库 `.dsh-sync/conflicts/<device>/<时间戳>/`，并告警；导入阶段保留本机 + 远端版本副本 | 绝大多数情况；最安全 |
| `prefer-remote` | 其他文件冲突时选择远端版本：Git 合并阶段把本机版本写入仓库冲突副本；导入阶段先备份本机文件再采用远端版本，并记入冲突列表 | 你明确希望以另一台设备为准 |
| `fail` | 仅当双方都改动了同一文件（真正冲突）时直接报错并中止本次同步，不做保留/覆盖，需人工处理 | 严格审计场景；日常建议 `keep-local` |

补充：导入阶段如果发现“本机文件在本次同步期间又被修改”（例如 DSH 正在写会话），`keep-local` 会**保留本机版本**并把远端版本存成冲突副本；`prefer-remote` 会先备份本机文件，再采用远端版本；`fail` 则直接报错中止。`workspace.json` 始终做语义合并；patch 文件按行 id 合并（同 id 行按上表策略，`fail` 时保留本机并告警，不会因此中止整个同步）。

### 9.2 备份与冲突副本

| 位置 | 内容 | 何时产生 |
|---|---|---|
| `$DSH_HOME/github-sync/backups/<时间戳>/...` | 被远端版本覆盖或被远端删除前的本机文件（按 home 相对路径保存） | `backup.enabled=true` 且发生覆盖/删除 |
| `$DSH_HOME/github-sync/conflicts/<时间戳>/...` | 导入阶段 `keep-local` 冲突时，**远端版本**的本机副本 | 仅导入阶段 keep-local 冲突 |
| 仓库 `.dsh-sync/conflicts/<device>/<时间戳>/...` | 冲突中未保留一方的原始文件：Git 合并冲突的对方版本；导入阶段 keep-local 冲突的远端版本也会在这里存一份 | Git 合并冲突 / 导入 keep-local 冲突；随提交推送到仓库 |
| `$DSH_HOME/github-sync/repo` | 完整快照工作区，可用 `git log`/`git show` 查看历史版本 | 始终 |

备份自动清理超过 `backup.keepDays` 天的目录；冲突副本目录**不会自动清理**，确认无用后可手动删除。`prefer-remote` 在导入阶段覆盖本机时，本机旧版本在 `backups/`（不在 `conflicts/`）。

> 仓库路径里的 `<device>` 是**发起这次同步的本机设备名**（`github-sync.json` 的 `deviceName`），不是冲突对方的设备名；排查时先看分支提交者是哪台设备，再按 `deviceName` 定位对应设备的冲突副本。

### 9.3 同一会话在两台设备同时继续会分叉

DSH 的会话日志是“向文件末尾追加 zstd 帧”，并依赖单写者/连续 `seq` 契约。如果 A、B 同时打开并继续同一个会话，两边都会追加自己的事件，形成两条分叉历史：

- 插件**不会自动合并**分叉（不重编号、不拼接事件）；
- 如果两条日志是严格追加/前缀关系（例如先同步再继续），会自动采用较长的一份，不产生冲突；
- 真分叉时按 `onConflict` 保留一方，另一方整份日志进入冲突副本，并告警；你可能看到会话长度/内容与预期不同。

**建议**：不要在两台设备上同时继续同一个会话；需要切换时先关闭另一端的该会话，再让同步完成。真出现分叉时，从冲突副本人工找回内容（冲突副本就是原始 zstd 会话文件），或保留内容更完整的一份，必要时手动 fork 成新会话。

### 9.4 回滚

发生误覆盖/路径映射错误时：

1. **完全退出 DSH Desktop**（避免 DSH 在内存中重写工作区/设置）；
2. 找到备份目录：
   ```powershell
   Get-ChildItem "$env:USERPROFILE\.dsh\github-sync\backups" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
   ```
3. 把需要的文件按相对路径复制回 `$DSH_HOME`（例如 `backups\<时间戳>\storages\workspace.json` → `%USERPROFILE%\.dsh\storages\workspace.json`）；
4. 重新打开 DSH。

如需回滚仓库历史，优先用 `git revert`（生成新提交，插件下次同步会推送）；不要随意 `reset --hard` 后强推，否则其他设备会在下次同步时把旧内容又合并回来。

### 9.5 试运行（dry run）

`github_sync` 工具 `dryRun: true` 或 CLI `sync --dry-run`：

- 只做“导出”规划：读取本机数据并与现有快照仓库工作区比较，报告会导出多少文件、其中多少相对当前快照有变化；
- **不写本机 DSH 数据、不创建/修改快照仓库、不提交、不 fetch/merge、不 push**；
- 用于同步前确认同步范围与变更量。

### 9.6 打开中的会话（pending）

当远端更新到达，而本机对应的会话**正在 DSH 中打开**时：

- 插件不会覆盖该会话文件：DSH 的 live session 只读内存日志并持有单写者租约，覆盖会破坏一致性；
- 更新被记为 **pending**（`state.json` 的 `pendingSessionIds`，`/sync status` 显示“待应用（本机打开中的会话）：N 个”）；
- 关闭并重新打开该会话（或重启 DSH）后，下一轮同步会自动应用远端更新；
- A 端在 B 端打开该会话期间继续写入时，也遵循同一规则：A 看到的是自己的 live 内存状态，重新打开后才看到合并后的日志。

### 9.7 会话日志的追加合并（append-only）

`realtime.mergeAppendOnlySessions=true`（默认）时，Git 合并阶段对 `home/sessions/**` 的冲突会先比较两条日志：

1. 字节完全相同 → 任取一份；
2. 一条是另一条的严格字节前缀 → 取较长的一份（没有丢事件）；
3. 否则按物理 JSONL 行逐行比较：一条是另一条的严格行前缀 → 取较长的一份；
4. 否则判定为**分叉**（两端各自追加了不同事件）→ 不自动合并，按 `onConflict` 保留一方，另一方整份写入冲突副本并告警。

该规则只处理“先同步、后继续”的正常追加；它不会重编号、不会把两条分叉历史拼成一条。

---

## 10. 常见问题

更完整的排查步骤（含命令与错误信息对照）见 [docs/troubleshooting.md](docs/troubleshooting.md)。这里列出高频问题：

| 现象 | 处理 |
|---|---|
| `Git 认证失败` | 确认 `DSH_SYNC_GITHUB_TOKEN` 已在 **DSH 进程**里生效（设置用户环境变量后完全重启）；确认 token 有仓库 Contents 读写权限；或改用 GCM/SSH |
| `无法连接 GitHub（网络问题）` | 检查网络/代理；给 git 配置代理（`git config --global http.proxy ...`）；必要时用 CLI 在能联网的环境先同步 |
| `找不到可用的 git` | 安装 Git for Windows，或在配置里设 `git.path` 为 `git.exe` 绝对路径 |
| 同步成功但侧栏没有工作区/会话 | 等 3–6 秒让实时轮询跑完；确认 `/sync status` 中实时同步为“开启”；若刚安装/升级插件，先重启一次 DSH；仍不显示时看插件日志中的热应用告警 |
| 新会话/工作区不出现 | 确认两端 realtime 均开启、网络/认证正常；`/sync status` 看最近同步时间与错误；必要时手动 `/sync sync`；老版本插件需升级并重启一次 |
| 工作区标题没有 `· 设备名` | 确认 `realtime.workspaceDeviceLabel=true`；仓库 `meta/workspaces.json` 需要至少一次来自来源设备的同步；本机旧标题会在后续同步中补齐 |
| 会话打不开/标题消失 | 检查 `pathMappings` 是否配置正确、是否在首次同步前就配好；从 `github-sync\backups` 回滚；查看仓库中会话文件是否存在 |
| 已打开的会话不刷新消息 | 预期行为：live session 不会被覆盖，更新在 pending 队列；关闭并重新打开该会话（或重启 DSH）后可见；`/sync status` 显示待应用数量 |
| 仓库越来越大 | 会话 zstd 每次追加都会重写整个文件；建议使用私有仓库、定期换新仓库或清理历史（插件不内置 LFS；如自行启用 LFS，请确保所有设备一致） |
| 两台设备同时自动同步 | 可能出现 `push rejected` / 忙；插件会自动 fetch+merge 重试 3 轮；`prefer-remote`/`keep-local` 决定冲突取舍，错开操作或关闭一端的实时同步 |
| 实时轮询太频繁/担心限流 | 调大 `realtime.intervalSeconds` / `idleIntervalSeconds`，或把某台设备的 `realtime.enabled` 设为 `false`；Git 端点不占 REST 5000/h，但受二级限流，建议每设备 ≤15 次/分钟 |
| 提示“另一个同步任务正在进行中” | 手动触发与自动同步重叠；等当前同步结束再试 |
| 会话文件被占用被跳过 | 同步时 DSH 正在写该会话；下次同步会自动重试 |
| 插件升级/卸载 | `dsh plugin --profile desktop add/remove ...` 后重启；卸载不会删除已同步数据 |

---

## 11. 安全与隐私

1. **仓库必须私有。** 插件不会检查仓库可见性；对话正文、工具输出、附件、技能指令都可能包含敏感信息，公开仓库等于公开这些内容。
2. **token 不落盘。** 插件只从环境变量读取 token，作为临时 HTTP header 传给 git；不写入配置文件、远程 URL 或日志，错误信息会脱敏。不要把 token 拼进仓库 URL（如 `https://token@github.com/...`），也不要把它提交到任何文件。
3. **凭据不同步。** `.credentials.yaml`（DSH 登录态、模型 API key 等）永远不同步；B 设备需要自己登录 DSH、配置模型服务商 key。
4. **设备身份不同步。** `.anonymous-user-id` 不同步，两台设备保持独立的遥测 identity。
5. **附件会同步。** `scopes.attachments=true` 时，会话中引用的图片/文件会进入私有仓库；如果附件包含敏感内容，可关闭该范围。
6. **本机快照与备份是明文数据。** `$DSH_HOME/github-sync/repo`、`backups`、`conflicts` 都包含你的数据副本，注意磁盘/备份软件的访问权限。
7. **最小权限与撤销。** PAT 只授权一个私有仓库、设置过期时间；设备丢失时立即撤销 token。使用 SSH 时同样注意私钥保护。
8. **历史无法轻易抹除。** Git 提交会保留历史；如果曾把敏感数据推送到仓库，删除文件不等于从历史删除，需要重写历史或更换仓库。

---

## 12. 限制与未验证项

以下内容基于当前代码与 `0.2.1-rc.2` 调研事实，如实列出：

1. **首次安装/升级插件需要重启 DSH 一次。** 之后运行期的近实时同步、工作区/会话热应用都不需要重启。只有在运行时缺少 DSH registry/session 服务（例如纯 CLI 或最小 profile）时，才回退到文件写入，需重启才能看到工作区变化。
2. **已打开的会话不会实时刷新消息。** DSH live session 只读内存、没有 reload API；远端更新会进入 pending，关闭并重新打开该会话（或重启 DSH）后才可见；`/sync status` 显示待应用数量。
3. **同一会话两端同时写会分叉。** 插件只对“严格追加/前缀”日志自动取较长一份，不重编号、不自动合并分叉；分叉按 `onConflict` 保留一方，另一方整份进冲突副本。避免同时打开同一会话。若某台设备在 DSH 中重开并改写过该会话的日志，之后远端再更新会持续按 `keep-local` 冲突处理、不会自动收敛——这是有意的数据安全行为；需要在冲突设备上关闭会话、手动选择保留哪一份（或把该会话复制成新会话继续）。
4. **Windows 长路径风险。** 快照仓库已设置 `core.longpaths=true`，但系统未启用长路径支持（注册表 `LongPathsEnabled`）时，深层会话目录仍可能超过 260 字符而失败。建议仓库放在较短路径下（默认 `%USERPROFILE%\.dsh\github-sync\repo` 通常没问题）。
5. **DSH 版本漂移。** 会话格式当前为 v4、workspace 域为 v2；插件按字节复制会话、按结构语义合并 workspace，**不校验数据格式版本**。两台设备 DSH 版本差异较大时，可能导入本机 DSH 无法识别的数据。升级 DSH 前先同步并保留备份，升级后先在一台设备上验证会话可打开。
6. **退出 DSH 前不会自动同步。** DSH 退出阶段无法可靠等待同步完成；请依赖实时/定时同步，或在关闭 DSH 前手动执行一次 `/sync sync`。
7. **实时/定时配置的生效范围不同。** `realtime.intervalSeconds`/`idleIntervalSeconds`/`activeWindowSeconds`/`workspaceDeviceLabel`/`mergeAppendOnlySessions` 每轮读取，通常下一轮生效；`realtime.enabled`/`pushDebounceSeconds` 与 `auto.*` 在插件加载时建立，修改后建议重启一次 DSH。
8. **没有跨设备锁。** 单飞锁只保证“同一台机器同一进程内不并发”；两台设备仍可能同时同步，靠 fetch/merge/push 重试收敛。
9. **仓库会持续膨胀。** 会话日志每次追加都会让整个 zstd 文件变化，Git 每次存新版本。插件不内置 LFS 或历史清理；长期使用建议定期换新仓库（旧仓库归档）或自行清理历史。
10. **实时轮询会产生持续 Git 流量。** 空轮询约 1 KB/次、有变更约 3–10 KB/次；Git smart HTTP 不占 GitHub REST 5000 次/小时配额，但受二级限流约束。默认配置远低于每设备 15 次/分钟的建议值；多设备或大仓库可调大间隔，或关闭某台设备的 `realtime`。
11. **没有图形化设置页。** 配置通过编辑 `github-sync.json`、`/sync init` 或 `github_sync` 工具完成。
12. **本文以 Windows + DSH Desktop 为准。** 代码使用 Node 标准 API（`node:fs`、`node:zlib`、`child_process`），理论上跨平台，但 macOS/Linux 未实测。
13. **未验证项**（来自调研资料）：Desktop 下 HMR 对 `link:` 插件的实际重载行为、Desktop 代理设置是否被 git 子进程继承、桌面插件页对 Git URL 安装的具体凭据流程。遇到问题优先用重启和 CLI 排查。

---

## 13. 路径速查

| 用途 | 路径 / 命令 |
|---|---|
| DSH home | `%USERPROFILE%\.dsh`（或 `$env:DSH_HOME`） |
| 本机同步配置 | `%USERPROFILE%\.dsh\github-sync.json` |
| 快照仓库 | `%USERPROFILE%\.dsh\github-sync\repo` |
| 状态文件 | `%USERPROFILE%\.dsh\github-sync\state.json` |
| 备份 | `%USERPROFILE%\.dsh\github-sync\backups\<时间戳>\` |
| 冲突副本 | `%USERPROFILE%\.dsh\github-sync\conflicts\<时间戳>\` |
| 仓库内冲突副本 | `.dsh-sync/conflicts/<device>/<时间戳>/` |
| 工作区来源映射（仓库） | `meta/workspaces.json` |
| 待应用会话 | `/sync status` 的“待应用（本机打开中的会话）”一行 |
| 插件目录 | `<插件目录>` |
| Desktop dsh 垫片 | `%APPDATA%\DSH Desktop\host-commands\desktop\generations\<hash>\bin\dsh.cmd` |
| 查看快照历史 | `git -C "$env:USERPROFILE\.dsh\github-sync\repo" log --oneline -20` |
| 状态 | `/sync status` 或 `node bin\dsh-github-sync.mjs status` |
| 自检 | `node bin\dsh-github-sync.mjs doctor` |

---

## 14. 文档索引

- [安装与首次配置](docs/installation.md) — PAT、Windows 环境变量、三种安装方式、重启一次、升级/卸载
- [配置参考](docs/configuration.md) — 所有字段（含实时同步 `realtime`）、默认值、范围、路径映射与 scope 细节
- [故障排查](docs/troubleshooting.md) — 认证、网络、实时同步/新会话不出现、pending、标题设备名、回滚、仓库膨胀、多设备冲突
- [设计说明](docs/design.md) — 架构、实时轮询与热应用、数据投影、workspace 合并、会话 zstd/追加合并、冲突模型、限制
- [English README](README.md)
