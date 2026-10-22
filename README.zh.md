# dsh-plugin-github-sync v0.2.0 · 完整使用手册

> 用一条 `/sync` 命令，把本机 DSH 的设置、对话记录、工作区注册表、技能、附件同步到你自己的 **GitHub 私有仓库**，让多台设备在数秒内互相看到对方的变化。

- **插件版本**：`v0.2.0`（近实时多设备版）。首次安装或升级后**重启一次 DSH**，之后运行期同步不需要再重启。
- **适用环境**：DSH `0.2.1-rc.2` Desktop；Windows / PowerShell 为主。插件是纯 Node ESM Host 插件，无第三方运行时依赖。
- **DSH home**：默认 `%USERPROFILE%\.dsh`（可用环境变量 `DSH_HOME` 覆盖）。
- **入口**：`/sync` 斜杠命令、`github_sync` 模型工具、`bin/dsh-github-sync.mjs` 独立 CLI、默认开启的近实时后台同步。
- **本文档**：完整使用手册。想快速跑起来看 [TL;DR](#tldr三步--30-秒检查清单)；遇到问题直接看 [故障排查大全](#11-故障排查大全) 和 [注意点与坑](#15-注意点与坑按严重程度)。

---

## 0. 五个必须知道的警告

1. 🔴 **必须使用 GitHub 私有仓库。** 对话正文、工具输出、附件、技能内容都会进入 Git 历史；公开仓库等于公开这些数据。插件不会检查仓库可见性。
2. 🔴 **`.credentials.yaml` 永远不同步。** DSH 登录态、模型 API key 等只留在本机；B 设备需要自己登录 DSH、配置模型服务商 key。
3. 🔴 **不同步工作区里的项目文件。** 插件只同步 DSH 的 `$DSH_HOME` 数据（工作区注册表、会话日志、附件等），**不会同步你的项目代码/文件**；项目请用 git、网盘或其它工具另行同步。
4. 🔴 **首次安装或升级插件后必须重启一次 DSH。** v0.2.0 的实时轮询/热应用接线在插件加载时建立；之后运行期才不需要重启。
5. 🔴 **已打开的会话不会实时刷新；同一会话两端同时写会分叉。** DSH live session 只读内存日志，远端更新会进入 pending，关闭重开/重启后才可见；两边同时继续同一会话时插件不自动合并，默认保留一方 + 整份冲突副本。

> 其中「私有仓库、credential 不同步、项目文件不同步、首次/升级重启、live/分叉」是本插件最容易踩的五类问题，下文会反复就地提醒。

---

## TL;DR：三步 + 30 秒检查清单

### 三步跑起来

```powershell
# 1) 建私有仓库（空仓库即可），并设置用户级 PAT（永久；用 SSH 则跳过）
[Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')

# 2) 安装插件（Desktop 的 dsh 垫片；也可用插件页或 scripts/install.mjs）
dsh plugin --profile desktop add link:<插件目录>

# 3) 完全退出并重启 DSH Desktop，然后在对话里执行：
/sync init https://github.com/<you>/dsh-sync.git
```

如果使用 SSH（推荐长期使用，见第 4 节），第 1 步改为配好 SSH key，第 3 步改用 SSH 仓库地址：

```text
/sync init git@github.com:<you>/dsh-sync.git
```

### 30 秒检查清单

安装前/首次同步前，逐条确认：

```powershell
# 工具链
git --version
node --version                                  # CLI 需要 ^22.19.0 || >=24.0.0

# 凭据方式二选一
[Environment]::GetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'User')   # PAT 方式
ssh -T git@github.com                           # SSH 方式，出现 authenticated 即可

# 配置与安装
Test-Path "$env:USERPROFILE\.dsh\github-sync.json"
$profilePath = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
(Get-Content $profilePath -Raw | ConvertFrom-Json).dependencies.'dsh-plugin-github-sync'
```

在 DSH 里再确认：

```text
/sync help
/sync status
```

- `/sync help` 能返回用法 → 插件已加载；
- `/sync status` 显示仓库、实时同步模式、工作区设备标签、最近同步时间 → 配置已生效；
- 模型侧能看到/调用 `github_sync` → 工具注册成功；
- 刚安装/升级过但没有这些 → 先完全重启一次 DSH。

---

## 目录

- [0. 五个必须知道的警告](#0-五个必须知道的警告)
- [1. 它到底同步什么、不同步什么](#1-它到底同步什么不同步什么)
- [2. 运行原理](#2-运行原理)
- [3. 前置条件与安全模型](#3-前置条件与安全模型)
- [4. Git SSH 配置完整教程（Windows）](#4-git-ssh-配置完整教程windows)
- [5. 安装（三种方式）](#5-安装三种方式)
- [6. 首次配置与多设备](#6-首次配置与多设备)
- [7. 实时行为（v0.2）](#7-实时行为v02)
- [8. 命令、工具与 CLI](#8-命令工具与-cli)
- [9. 配置字段完整参考](#9-配置字段完整参考)
- [10. 冲突与数据安全](#10-冲突与数据安全)
- [11. 故障排查大全](#11-故障排查大全)
- [12. 卸载与恢复](#12-卸载与恢复)
- [13. 安全与隐私](#13-安全与隐私)
- [14. 限制与未验证项](#14-限制与未验证项)
- [15. 注意点与坑（按严重程度）](#15-注意点与坑按严重程度)
- [16. 路径速查与 FAQ](#16-路径速查与-faq)
- [17. 附录：本机示例配置](#17-附录本机示例配置)
- [18. 文档索引](#18-文档索引)

---

## 1. 它到底同步什么、不同步什么

### 1.1 同步的内容（默认开启六类）

| 范围 | 仓库内路径 | 内容与行为 |
|---|---|---|
| `settings` | `home/storages/**`、`home/cordis.patch.yml`、`home/cordis.yml`、`profiles/<profileName>/cordis.patch.yml` | DSH 设置：`storages` 下的 JSON 域（如 `schedule.json`、`settings.json`）、home/profile 用户设置层。patch 文件会剔除本插件自己的行，避免 A 的本机插件配置覆盖 B |
| `sessions` | `home/sessions/**` | 会话日志 `session.v4.jsonl.zstd`（zstd 多帧 JSONL）。路径不变时按字节复制；`pathMappings` 生效时逐帧重写 `header.cwd` 与事件中的路径；支持严格追加关系自动合并 |
| `workspaces` | `home/storages/workspace.json`、`meta/workspaces.json` | 工作区注册表语义合并；`meta/workspaces.json` 记录每个工作区的来源设备，用于侧栏标题 `名称 · 设备名` |
| `skills` | `home/skills/**`、`home/AGENTS.md`、`home/agents.md` | **仅 DSH home 下**的用户级技能与全局 Agent 指令 |
| `attachments` | `home/attachments/**` | 会话引用的图片/文件内容寻址对象库；关掉后另一台设备上历史图片/文件可能读不到 |
| `market` | `home/storages/community_market/global.json`、`community_market/sources/**` | 插件市场源注册（用户意图）；目录缓存不同步 |

### 1.2 默认关闭、需要时才打开的两类

| 范围 | 默认 | 仓库内路径 | 说明 |
|---|---|---|---|
| `projections` | `false` | `home/storages/session_projcache/**` | 会话投影缓存（标题/todo/goal 等 UI 缓存），纯派生、可重建；通常没必要同步 |
| `plugins` | `false` | `profiles/<profileName>/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`compatibility.json`、`.npmrc` | 插件清单/依赖锁。打开后会用 A 的插件清单覆盖 B，可能改变 B 的插件环境，慎用 |

### 1.3 永远不同步 / 明确排除的内容

| 内容 | 位置/说明 | 原因 |
|---|---|---|
| **工作区里的项目文件本身** | 你在 DSH 里打开的项目目录（如 `E:\projects\foo` 下的代码、文档、图片） | 插件只投影 `$DSH_HOME`；**不会同步项目文件**。项目代码请用 git/网盘/其它同步工具 |
| `.credentials.yaml` | `$DSH_HOME/.credentials.yaml` | 明文凭据：DSH 登录 token、模型 API key 等 |
| `.anonymous-user-id` | `$DSH_HOME/.anonymous-user-id` | 设备级遥测身份，两台设备应各自独立 |
| `~/.agents/skills`、`~/.agents/AGENTS.md` | 位于 DSH home **之外**的用户级共享目录 | 不在插件受管路径内；如需共享请另行同步 |
| 项目内 `.dsh/skills`、`.agents/skills` | 工作区目录里的项目级技能 | 属于项目文件，不归 DSH home 管，插件不读取 |
| `cache/` | `$DSH_HOME/cache/**` | 请求图片转码等缓存，可重建 |
| `session_projcache/` | `$DSH_HOME/storages/session_projcache/**` | 默认不同步（除非 `scopes.projections=true`） |
| 市场目录缓存 | `community_market/catalog_cache/**` | 派生缓存 |
| `node_modules/`、`.dsh-module-fallback/` | profile 目录下 | 平台相关安装产物，应在目标设备自行安装 |
| `dsh-runtimes/`、`agents-anywhere/` | `$DSH_HOME` 下 | 随包运行时 / 远程访问桥，机器本地 |
| DSH home 下未被上述 scope 覆盖的目录（如媒体/缓存衍生目录） | 任意未知路径 | 插件只遍历明确列出的受管路径，不会同步未知目录 |
| `profiles/*/cordis.yml`、`settings.yaml.imported` | 生成物/旧版遗留 | 不是用户设置 |
| `$DSH_HOME/logs/**` | 日志 | 机器本地诊断 |
| `$DSH_HOME/github-sync/**` | 插件自己的快照仓库、状态、备份、冲突副本 | 自引用 |
| 仓库里的 `.dsh-sync/**` | 冲突副本目录 | 导入时忽略 |
| `session.lock`、`*.tmp`、迁移临时文件、符号链接 | 会话目录内 | 锁/临时/非普通文件 |
| 超过 `limits.maxFileMB` 的文件 | 任意 scope | 单文件上限保护，跳过并告警 |

> ⚠️ **再次强调：项目文件不同步。** 本插件同步的是“DSH 如何看这些项目”（工作区注册表、会话历史、附件），不是项目内容本身。在 B 设备上要看到项目文件，请先用 git clone / 网盘 / 其它方式准备好目录，再让插件同步 `workspace.json` 和会话。

### 1.4 为什么这样设计

- DSH 的数据都在 `$DSH_HOME` 下；工作区目录只是“外部引用”，通常很大、属于项目自己的版本管理；
- `.credentials.yaml` 是明文密钥，绝不能进入 Git 历史；
- `~/.agents`、项目 `.dsh/skills` 与 DSH home 的布局/生命周期不同，插件不越界处理；
- 会话是追加写的 zstd 二进制，插件只做安全的前缀合并和冲突副本，不尝试理解对话语义。

---

## 2. 运行原理

### 2.1 三层结构

```text
┌──────────────────────────── DSH Desktop host 进程 ─────────────────────────────┐
│                                                                                │
│  /sync 命令     github_sync 工具     近实时轮询/会话事件监听                    │
│       └───────────────┬───────────────────────┘                                │
│                       ▼                                                        │
│              同步引擎 runSync                                                  │
│     ┌───────────────┼────────────────┬──────────────────┐                      │
│     ▼               ▼                ▼                  ▼                      │
│  lib/snapshot    lib/git          lib/sessions       lib/runtime               │
│  （投影/导入）   （fetch/merge）  （zstd/追加合并）  （workspace/session 热应用）  │
│     │               │                                                  │       │
└─────┼───────────────┼──────────────────────────────────────────────────┼───────┘
      ▼               ▼                                                  ▼
 $DSH_HOME       $DSH_HOME/github-sync/repo                      浏览器界面
 （本机数据）      （快照 git 工作区）                          workspace/follow
      │               │                                        api-session/*
      └──── 私有 GitHub 仓库（branch，如 main）◄──── push ─────┘
```

- **快照仓库**：本机 `$DSH_HOME/github-sync/repo` 是一个普通 git 工作区，内容投影了 `$DSH_HOME`；
- **远端**：GitHub 私有仓库的 `branch`（默认 `main`）；
- **本机状态**：`$DSH_HOME/github-sync/state.json`，记录上次同步哈希、pending 会话、最近错误等；
- **运行时**：Host 插件通过 DSH 服务把导入结果热应用到侧栏，不需要重启。

### 2.2 私有仓库里的布局

```text
<repo>/
├─ .gitattributes                 ← 首同步生成；会话按二进制处理，文本统一 LF
├─ home/
│  ├─ sessions/<projectKey(cwd)>/<会话 id>/session.v4.jsonl.zstd
│  ├─ storages/workspace.json
│  ├─ storages/**                 ← 其它设置域
│  ├─ cordis.patch.yml
│  ├─ skills/<skill>/SKILL.md
│  ├─ AGENTS.md
│  └─ attachments/v1/objects/...
├─ profiles/desktop/
│  ├─ cordis.patch.yml
│  └─ package.json 等（仅 scopes.plugins）
├─ meta/
│  └─ workspaces.json             ← 工作区来源设备（标题 `名称 · 设备名`）
└─ .dsh-sync/
   └─ conflicts/<device>/<时间戳>/...   ← 合并冲突的另一方版本
```

`.gitattributes` 由插件创建：

```text
* -text
*.json text eol=lf
*.jsonl text eol=lf
*.yml text eol=lf
*.yaml text eol=lf
*.md text eol=lf
```

这样会话 zstd 不会被 Git 做行尾转换，JSON/YAML 仍可正常 diff。

### 2.3 一次 tick 的完整流程

实时模式下每一轮（默认活跃 3 秒 / 空闲 15 秒；有写入约 2 秒后提前触发）大致是：

```text
[1] 读取配置 + state.json（pending 非空会禁用“无变化快路径”）
        │
[2] fetch 远端分支
        │
[3] 导出本机数据到快照工作区（含 meta/workspaces.json）
        │
[4] commit（dsh-sync[<device>]: export ...）
        │
[5] merge：本地落后 → fast-forward；双方分叉 → merge
        │    └─ 会话可做 append-only 前缀合并；其余冲突按 onConflict
        ▼
[6] import 到本机：
        ├─ live 会话 → 跳过文件，记 pending
        ├─ workspace.json → 有 registry 时 defer
        └─ 其它文件 → 备份/冲突策略
        │
[7] runtime 热应用：
        ├─ workspaceRegistry create/setTitle/attachSession
        │     → domain/changed → workspace/follow → 侧栏即时更新
        └─ api-session/added|activity|removed → 会话列表更新
        │
[8] 再导出（让合并结果规范化）+ 应用工作区设备标题
        │
[9] push；被拒则重新 fetch/merge，最多 3 轮
        │
[10] 写 state.json（pendingSessionIds / mappingKey），清理过期备份
```

- **无变化快路径**：本机没有新提交、远端没有前进、没有 pending 时，只 fetch/比较后返回，不做昂贵导入。
- **失败退避**：连续失败按 5s → 10s → 20s → 40s → 60s 退避（上限 60s）并加 ±20% 抖动；成功后清零。
- **单飞**：轮询、写后触发、手动 `/sync sync`、工具、CLI 共享同一把进程内锁，重叠请求会被跳过。

### 2.4 实时轮询与写后触发（v0.2）

| 状态 | 间隔/行为 |
|---|---|
| 活跃（最近 90 秒内有会话活动） | 约每 3 秒一轮 |
| 空闲 | 约每 15 秒一轮 |
| 本机收到 `session/event` | 约 2 秒后触发一轮（`realtime.pushDebounceSeconds`） |
| 连续失败 | 指数退避到 60 秒 + 抖动 |

关闭 `realtime` 后回退到旧模式：启动约 15 秒后同步一次，之后按 `auto.intervalMinutes`（默认 10 分钟）；会话写入按 `auto.sessionDebounceSeconds`（默认 120 秒）触发。

### 2.5 热应用：为什么不需要重启

- **工作区**：Host 中存在 `workspaceRegistry` 时，导入不直接写 `workspace.json`，而是由 `lib/runtime.js` 调用 registry 的 `create` / `setTitle` / `attachSession`；registry 的 `domain/changed` 驱动 Web 客户端 `workspace/follow`，侧栏立即更新。
- **会话**：新导入会话 emit `api-session/added`，更新/删除 emit `api-session/activity` / `api-session/removed`，浏览器会话列表即时更新。
- **标题**：导入/导出都按 `meta/workspaces.json` 装饰 `名称 · 设备名`；本机也会在同步后应用一次。
- **兜底**：在没有这些服务的环境（CLI、最小 profile）中回退为文件写入，需要重启 DSH 才能看到工作区变化。

### 2.6 live 闸门与 pending

本机 `ctx.get('sessions').list()` 中正在打开的会话：

- 远端更新不会覆盖其文件（DSH live session 只读内存，没有 reload API）；
- 文件更新被记为 **pending**（`state.pendingSessionIds`，`/sync status` 显示数量）；
- 关闭并重新打开该会话（或重启 DSH）后，下一轮同步自动应用；
- pending 非空会让“无变化快路径”失效，因此每轮都会重试。

### 2.7 会话 append-only 合并与分叉

DSH 会话日志是“向文件末尾追加 zstd 帧”。合并时：

1. 两份字节完全相同 → 任取一份；
2. 一份是另一份的严格字节前缀 → 取较长的一份；
3. 否则逐帧解压、按 JSONL 行比较公共前缀：严格前缀 → 取较长的一份；
4. 否则判定 **分叉**（两端各自追加了不同事件）→ 不自动合并，按 `onConflict` 保留一方，另一方整份写入 `.dsh-sync/conflicts/`。

插件不重编号、不拼接两条分叉历史；`realtime.mergeAppendOnlySessions=false` 可关闭自动前缀合并。

### 2.8 冲突副本与备份

| 位置 | 内容 | 何时产生 |
|---|---|---|
| `$DSH_HOME/github-sync/backups/<时间戳>/...` | 被覆盖/删除前的本机文件，按 home 相对路径保存 | 覆盖或删除本机文件时 |
| `$DSH_HOME/github-sync/conflicts/<时间戳>/...` | 导入阶段 `keep-local` 冲突时，**远端版本**的本机副本 | 本机文件在同步期间又被修改，且远端内容不同 |
| 仓库 `.dsh-sync/conflicts/<device>/<时间戳>/...` | Git 合并冲突中未保留一方的原始文件；导入 keep-local 冲突的远端版本也存一份 | Git 合并冲突 / 导入冲突 |
| `$DSH_HOME/github-sync/repo` | 完整快照工作区，可用 `git log` / `git show` 查看历史版本 | 始终 |

> 仓库冲突副本路径里的 `<device>` 是**发起这次同步的本机 `deviceName`**，不是冲突对方的设备名；排查时先看提交者/设备，再定位对应目录。

备份目录按 `backup.keepDays`（默认 30 天）清理；冲突副本**不会自动清理**，确认无用后手动删除。

---

## 3. 前置条件与安全模型

### 3.1 软件与账号

| 条件 | 要求 | 检查 |
|---|---|---|
| Git | Git for Windows（插件通过 `git` CLI 工作） | `git --version` |
| GitHub 仓库 | **必须私有**；空仓库或已有仓库均可；建议至少一个提交/默认分支 | 浏览器创建 |
| Node.js（仅 CLI） | `^22.19.0 || >=24.0.0`（依赖 `node:zlib` 的 zstd API） | `node --version` |
| DSH | Desktop `0.2.1-rc.2`；profile 默认 `desktop` | `dsh --version` |
| 凭据 | PAT 或 SSH key 二选一 | 见第 4 节 / 3.3 |

### 3.2 GitHub 私有仓库与容量

- **必须私有**。插件不检查仓库可见性，公开仓库等于公开你的对话、附件和技能内容。
- GitHub 对**单个文件**有 100 MiB 硬限制；插件默认 `limits.maxFileMB=100`，超过会跳过并告警。
- 仓库过大（数百 MB 起）会明显拖慢 fetch/clone/push；建议把仓库控制在 1 GB 以内，并定期换新仓库。
- 会话是 zstd 二进制、整文件变化；Git 每次提交存新版本，长期使用仓库历史增长通常比原始数据大 **3–7 倍**（经验估算，取决于对话频率）。
- 仓库容量不是“只存一份”：备份/冲突副本只在本地，**不在**仓库里（`.dsh-sync/conflicts/` 里的冲突副本除外）。

### 3.3 PAT 还是 SSH？

| 方式 | 优点 | 注意 |
|---|---|---|
| **SSH（推荐长期）** | 不把 token 放进环境变量；Deploy Key 可只授权单个仓库；适合自动化 | 需要配 key；Windows ACL/端口 22 可能有问题，见第 4 节 |
| **PAT（HTTPS）** | 配环境变量即可；插件把 token 作为临时 HTTP header，不落盘 | token 会出现在环境变量中；需 Contents 读写权限；过期需轮换 |

二选一即可：

- PAT 方式：`repo` 用 `https://github.com/<you>/<repo>.git`，设置 `DSH_SYNC_GITHUB_TOKEN`；
- SSH 方式：`repo` 用 `git@github.com:<you>/<repo>.git`，配置好 SSH；**SSH 下插件不会使用 token**。

### 3.4 token 安全模型

- token 只从环境变量读取（默认 `DSH_SYNC_GITHUB_TOKEN`，fallback `GH_TOKEN` / `GITHUB_TOKEN`）；
- 仅 HTTPS 远端时，插件把 token 作为**临时** `http.extraHeader`（`x-access-token:<token>` 的 Basic 认证）传给 git；
- 不写入配置文件、远程 URL、`.git/config`、提交信息或日志；错误信息会脱敏；
- **不要把 token 拼进仓库 URL**（如 `https://token@github.com/...`），也不要提交到任何文件。

### 3.5 `.credentials.yaml` 不同步

`.credentials.yaml` 永远不同步。B 设备需要：

1. 自己登录 DSH（DeepSeek 账号/客户端登录）；
2. 自己配置模型服务商 API key（Models 页等）；
3. 如需定时提醒/市场源等，另行确认对应数据是否在同步范围内。

### 3.6 仓库里是明文数据

- 会话正文、工具输出、附件、技能/AGENTS.md 会以明文（会话是 zstd 压缩明文）进入私有仓库；
- 获得仓库读权限的人可以读取全部历史；
- 请使用强账号安全（2FA）、最小权限 PAT/Deploy Key、可信的协作者；
- 备份、冲突副本、本机快照仓库同样是明文副本，注意磁盘安全。

---

## 4. Git SSH 配置完整教程（Windows）

> 如果使用 PAT + HTTPS，可以跳过本节，直接看 4.9。长期使用建议 SSH + Deploy Key。

### 4.1 检查/生成 ed25519 key

```powershell
# Windows 10/11 通常自带 OpenSSH
ssh -V

# 生成专用 key（不要复用到其它用途；带 passphrase 更安全）
ssh-keygen -t ed25519 -C "dsh-sync" -f "$env:USERPROFILE\.ssh\id_ed25519_dsh"
```

生成后得到：

- 私钥：`C:\Users\<you>\.ssh\id_ed25519_dsh`（不要外传）
- 公钥：`C:\Users\<you>\.ssh\id_ed25519_dsh.pub`（粘贴到 GitHub）

### 4.2 启动 ssh-agent 并加载私钥（有 passphrase 时）

```powershell
# 管理员 PowerShell（只需设置一次）
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent

# 普通 PowerShell：加载私钥
ssh-add "$env:USERPROFILE\.ssh\id_ed25519_dsh"
```

> 插件在 `git.batchMode=true` 下用 `ssh -o BatchMode=yes` 运行，**不能交互输入 passphrase**；所以要么 key 无 passphrase，要么用 ssh-agent 提前加载。

### 4.3 配置 `~/.ssh/config`（22 端口受限时走 443）

创建/编辑 `C:\Users\<you>\.ssh\config`：

```text
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile C:\Users\<you>\.ssh\id_ed25519_dsh
  IdentitiesOnly yes
```

说明：

- GitHub 的 SSH 默认 22 端口；公司/学校/部分网络封 22 时，用 `ssh.github.com:443`；
- 如果 22 可用，也可以去掉 `HostName` / `Port` 两行；
- `IdentitiesOnly yes` 避免 agent 里有太多 key 时选错。

### 4.4 验证 SSH

```powershell
ssh -T git@github.com
```

成功会显示类似：

```text
Hi <you>! You've successfully authenticated, but GitHub does not provide shell access.
```

Deploy Key 的提示可能显示仓库名，只要出现 “successfully authenticated” 即可。若第一次连接提示 host key 指纹，确认后输入 `yes`。

### 4.5 Deploy Key vs 账号 SSH Key

| 对比 | Deploy Key（推荐给单仓库） | 账号 SSH Key |
|---|---|---|
| 绑定对象 | 单个仓库 | 你的 GitHub 账号 |
| 权限范围 | 仅该仓库（可勾选写权限） | 账号可访问的所有仓库（受账号权限约束） |
| 适合 | 每台设备/每个同步仓库独立授权 | 个人账号多仓库管理 |
| 配置位置 | 仓库 **Settings → Deploy keys** | 账号 **Settings → SSH and GPG keys** |
| 写权限 | 添加时必须勾选 **Allow write access**，否则只能拉取 | 取决于账号权限 |

**Deploy Key 步骤**：

1. 打开同步仓库 → **Settings** → **Deploy keys** → **Add deploy key**；
2. Title 填设备名（如 `jackfruit-dsh-sync`）；
3. Key 粘贴 `id_ed25519_dsh.pub` 的全部内容；
4. 勾选 **Allow write access**（插件需要 push）；
5. 保存。

**账号 key 步骤**：

1. GitHub 右上头像 → **Settings** → **SSH and GPG keys** → **New SSH key**；
2. 粘贴公钥，保存。

### 4.6 把配置切到 SSH

修改 `$DSH_HOME/github-sync.json`：

```json
{
  "repo": "git@github.com:<you>/<repo>.git"
}
```

- SSH 不需要 `DSH_SYNC_GITHUB_TOKEN`；如果环境里仍有 token，也**不会**用于 SSH；
- 切换后可以保留 token 环境变量，不会影响 SSH；
- 切换仓库 URL 后执行一次 `/sync sync`，让快照仓库的 remote 更新。

### 4.7 Windows `.ssh` ACL 坑（`Bad owner or permissions`）

如果 `ssh -T git@github.com` 报：

```text
Bad owner or permissions on C:\\Users\\<you>/.ssh/config
```

原因是私钥/目录的 Windows ACL 太宽（包含旧 SID、Users 组等）。修复：

```powershell
$ssh = "$env:USERPROFILE\.ssh"
$me = whoami

# 1) 去掉继承的权限
icacls $ssh /inheritance:r
icacls "$ssh\config" /inheritance:r
icacls "$ssh\id_ed25519_dsh" /inheritance:r

# 2) 只授予当前用户 + SYSTEM + Administrators（用 SID 避免中英文组名差异）
icacls $ssh /grant:r "${me}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls "$ssh\config" /grant:r "${me}:F" "*S-1-5-18:F" "*S-1-5-32-544:F"
icacls "$ssh\id_ed25519_dsh" /grant:r "${me}:F" "*S-1-5-18:F" "*S-1-5-32-544:F"

# 3) 如果输出里还有旧 SID，逐个移除：
# icacls $ssh /remove:g "S-1-5-21-..."
# icacls $ssh /remove:d "S-1-5-21-..."
```

如果 owner 本身不对：

```powershell
# 管理员 PowerShell
takeown /f "$env:USERPROFILE\.ssh" /r /d y
icacls "$env:USERPROFILE\.ssh" /reset
# 然后重新执行上面的 inheritance/grant
```

> 建议对 `.ssh` 目录、`config`、私钥文件都做同样处理；处理完重新打开 PowerShell 再测试 `ssh -T`。不要在网盘/共享目录放 `.ssh`。

### 4.8 Git Credential Manager TLS/凭证失败（`安全包中没有可用的凭证`）

部分 Windows/代理/企业 TLS 环境下，GCM 可能报类似：

```text
fatal: 安全包中没有可用的凭证
```

替代路径（优先级从高到低）：

1. **改用 SSH**：按本节配置 key，`repo` 改成 `git@github.com:...`；插件对 SSH 完全走系统 OpenSSH；
2. **HTTPS + 环境变量 PAT**：插件会把 token 作为临时 `http.extraHeader` 传给 git，通常可以绕过 GCM 的交互/凭证问题：
   ```powershell
   [Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')
   ```
   设置后完全重启 DSH Desktop；
3. 尝试重新登录 GCM（只在交互环境）：
   ```powershell
   git credential-manager github login
   ```
   若仍报 TLS/安全包错误，不要反复重试，直接使用 SSH。

### 4.9 PAT + HTTPS 方式

不想配 SSH 时：

1. 创建 Fine-grained PAT：目标私有仓库 **Contents: Read and write**（或 classic token 勾 `repo`）；
2. 设置用户环境变量 `DSH_SYNC_GITHUB_TOKEN`；
3. `repo` 用 `https://github.com/<you>/<repo>.git`；
4. 完全重启 DSH Desktop 让进程继承环境变量；
5. `/sync status` 应能正常同步。

---

## 5. 安装（三种方式）

> 下文 `<插件目录>` 指本仓库克隆/解压后的目录；安装或升级后**重启一次** DSH。

### 5.1 方式 A：桌面「插件」页

1. 侧栏 **插件** → **添加插件** / **安装第三方插件**；
2. 输入本地绝对路径 `<插件目录>`，或插件的 Git 仓库地址；
3. 该入口只接受声明了 `dsh.bundle.patch` 的 bundle；本插件已声明，安装后会自动插入 `id: github-sync` 的插件行并启用；
4. 完全退出并重启 DSH Desktop。

### 5.2 方式 B：Desktop 自带 `dsh` 垫片

```powershell
# 找最新的 dsh 垫片（generations 下可能有多份）
$dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
$dsh

& $dsh plugin --profile desktop add link:<插件目录>
```

如果 `dsh` 已在 PATH：

```powershell
dsh plugin --profile desktop add link:<插件目录>
```

- `link:` 不复制代码，改插件源码后重启 DSH 生效；`file:` 复制安装，适合固定版本；
- 路径有空格时给 `link:...` 整体加引号；
- 卸载：`& $dsh plugin --profile desktop remove dsh-plugin-github-sync`，然后重启。

> 🔴 **npm 版 `dsh` 会拒绝 `--profile desktop`**。管理 desktop profile 必须用 Desktop 垫片或桌面插件页。

### 5.3 方式 C：安装脚本 `scripts/install.mjs`

插件自带脚本，自动查找 Desktop 垫片并执行 `add link:`：

```powershell
cd <插件目录>
node scripts\install.mjs                          # 默认 desktop
node scripts\install.mjs --profile desktop --print
npm run install:profile
```

适合本机开发/升级；找不到垫片时会提示改用桌面插件页。

### 5.4 安装后必须重启一次

v0.2.0 的实时轮询、热应用接线在插件加载时建立：

- 首次安装：必须完全退出并重启 DSH Desktop；
- 升级插件：同样重启一次；
- 之后运行期的同步/热应用**不需要**再重启。

### 5.5 如何确认已安装

（1）DSH 内：

```text
/sync help
/sync status
```

（2）profile 清单：

```powershell
$profilePath = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
$pkg = Get-Content $profilePath -Raw | ConvertFrom-Json
$pkg.dependencies.'dsh-plugin-github-sync'
$pkg.dsh.profile.bundles
```

应能看到 `link:<插件目录>` 依赖，以及 `dsh-plugin-github-sync` 在 bundles 中（具体字段名以你安装后的 profile 为准）。

（3）模型工具：模型中能看到 `github_sync`，或让它执行 `action="status"`。

（4）配置预览（可选，注意副作用）：

```powershell
dsh --profile desktop --dump-config
```

> ⚠️ `--dump-config` 可能会初始化/改写 profile（详见 DSH 文档），执行前先备份 profile。它只证明配置组合，不证明 `apply` 成功。

（5）插件日志：DSH 启动日志/运行日志中搜索 `github-sync`；启动失败诊断通常在 `$DSH_HOME\logs\`。

---

## 6. 首次配置与多设备

### 6.1 配置文件位置

**机器本地**、不参与同步：

```text
%USERPROFILE%\.dsh\github-sync.json
```

若设置了 `DSH_HOME`，则是 `$env:DSH_HOME\github-sync.json`。

### 6.2 最小配置

```json
{
  "repo": "git@github.com:<you>/<repo>.git",
  "branch": "main",
  "deviceName": "workstation-a"
}
```

其余字段使用默认值。也可以直接执行：

```text
/sync init git@github.com:<you>/<repo>.git
```

### 6.3 完整配置示例（含 realtime）

```json
{
  "$schema": "https://github.com/deepseek-harness/dsh-plugin-github-sync#configuration",
  "version": 1,
  "enabled": true,
  "repo": "git@github.com:<you>/<repo>.git",
  "branch": "main",
  "remoteName": "origin",
  "deviceName": "workstation-a",
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
  "auto": {
    "startup": true,
    "intervalMinutes": 10,
    "sessionDebounceSeconds": 120
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

说明：

- JSON 中 Windows 路径要写成双反斜杠：`"E:\\projects\\foo"`；
- 用 SSH 时 `repo` 填 `git@github.com:...`，token 环境变量可以留空/不设；
- 用 HTTPS 时 `repo` 填 `https://...`，并设置 `DSH_SYNC_GITHUB_TOKEN`；
- 文件保存 UTF-8（可带 BOM，插件会处理）。

### 6.4 `/sync init`

```text
/sync init https://github.com/<you>/<repo>.git
```

它会保留已有配置字段，写入 `repo`、`branch`、`deviceName`、`profileName`，然后立即执行首次同步。

等价的 CLI：

```powershell
cd <插件目录>
node bin\dsh-github-sync.mjs init --repo https://github.com/<you>/<repo>.git --device workstation-a
```

> 已配置过仓库时，`/sync init <新地址>` 会直接用新地址覆盖 `repo`，请确认再执行。

### 6.5 `pathMappings`：A、B 路径不同

A 的工作区在 `E:\projects\foo`，B 上放在 `D:\projects\foo`。在 **B** 的 `github-sync.json`：

```json
"pathMappings": [
  { "from": "E:\\projects\\foo", "to": "D:\\projects\\foo" }
]
```

- `from` = 仓库中保存的规范路径（通常就是 A 的路径）；
- `to` = 本机路径；
- 支持多条，前缀最长优先；Windows 下大小写不敏感；
- 也接受对象写法 `{ "E:\\projects\\foo": "D:\\projects\\foo" }`；
- B 首次同步前**建议先创建目标目录**（插件在 `createMissingWorkspaceDirs=true` 时也会自动创建，但权限/网络盘可能失败）；
- **不要用 junction/符号链接**代替映射：DSH 用 `realpath` 比对，链接会解析成真实目标，容易导致会话匹配不上工作区。

B 首次同步会先导入远端数据，其中与路径相关的处理：

1. 创建/规范化 `to` 目录（`realpath`）；
2. 改写 `workspace.json` 里的 `path`；
3. 重写会话 `header.cwd` 与事件文本中的旧路径（单/双反斜杠、正斜杠都覆盖）；
4. 把会话目录从 A 的 `projectKey`（如 `--E-projects-foo--`）改为 B 的 `projectKey`；
5. 之后再导出时把 B 的路径映射回 A 的规范路径。

### 6.6 A → B 多设备步骤（推荐顺序）

**A 设备（已有数据）：**

1. 安装插件并重启一次；
2. 配好 PAT 或 SSH；
3. `/sync init <repo>`（或编辑配置后 `/sync sync`）；
4. `/sync status` 确认实时同步开启、最近同步时间更新；
5. 确认 GitHub 仓库出现 `home/`、`profiles/desktop/`、`meta/workspaces.json`。

**B 设备：**

1. 安装插件并重启一次（v0.2.0 首次必须）；
2. 配好 B 自己的 PAT/SSH（不要复用 A 的凭据文件）；
3. 编辑 B 的 `github-sync.json`：`repo` 相同、`deviceName` 不同、路径不同时加 `pathMappings`；
4. 建议先创建 `pathMappings.to` 目标目录；
5. 执行首次同步（`/sync sync` 或 CLI `sync`）；首次同步会**先把远端导入本机**，再导出本机新增内容；
6. 首次同步/路径映射完成后**建议重启 DSH 一次**，让工作区、会话、标题在侧栏稳定出现；v0.2 热应用后通常数秒也能看到，但首次映射建议重启兜底；
7. 之后 A/B 同时运行时，新工作区/新会话通常 3–6 秒内互相可见，**不再需要重启**。

**首次同步时 B 的合并策略：**

- `workspace.json`：语义合并（本机工作区保留，远端工作区/会话并入）；
- `cordis.patch.yml`：按行 id 合并（远端行 + 本机独有行都保留，同 id 按 `onConflict`，默认保留本机）；
- 其它不透明设置（如 `schedule.json`）：默认保留本机 + 远端版本存冲突副本；`prefer-remote` 时备份本机后覆盖；全新 home 则远端优先；
- 会话：远端会话按路径映射导入，本机会话保留。

### 6.7 首次同步成功的标志

- `/sync status` 显示仓库、设备、实时同步模式、最近同步时间；
- 本机出现 `%USERPROFILE%\.dsh\github-sync\repo`；
- 仓库出现 `home/`、`profiles/desktop/`、`meta/workspaces.json` 与 `dsh-sync[<device>]: export ...` 提交；
- 首次可能较慢（上传会话/附件），受 `limits.maxTotalMB`（默认 4 GB）限制。

---

## 7. 实时行为（v0.2）

### 7.1 时间线

- 本机有会话写入后约 **2 秒**触发一轮；
- 活跃时每约 **3 秒**、空闲时每约 **15 秒**轮询；
- 对端的新工作区/新会话通常 **3–6 秒**内出现在侧栏（受网络、GitHub 延迟影响）；
- 工作区标题显示为 `名称 · 设备名`（如 `wwa · jackfruit`），来源记录在仓库 `meta/workspaces.json`。

### 7.2 B 在 A 的工作区/会话里操作

- B 新建会话、追加事件 → A 在数秒内收到；
- A **未打开**该会话 → 文件自动更新，并出现在会话列表；
- A **已打开**该会话 → 不会实时刷新消息；远端更新进入 pending，关闭重开/重启后可见；`/sync status` 显示待应用数量；
- A 继续在该会话里写入时，以自己的 live 内存日志为准；关闭后才会看到合并/冲突处理结果。

### 7.3 工作区标题的设备后缀

- 默认开启：`realtime.workspaceDeviceLabel=true`；
- 标题形如 `wwa · jackfruit`；
- 关闭：本机设 `false` 后**不再新增**后缀；已经带 ` · 设备名` 的标题不会自动剥离，需要手动改名；建议所有设备统一关闭；
- sidecar `meta/workspaces.json` 即使关闭标签也会维护，方便以后重新开启。

### 7.4 已打开的会话不会实时刷新

DSH 的 live session 只读内存日志，没有 reload API。插件不会覆盖它：

- 更新被记为 pending（`state.pendingSessionIds`）；
- 关闭并重新打开该会话（或重启 DSH）后，下一轮同步自动应用；
- 不要尝试删除/替换 live 会话文件来“强制刷新”，会丢事件。

### 7.5 同一会话两端同时写会分叉

- DSH 依赖单写者 + 连续 `seq`；两端各自追加会产生两条历史；
- 插件只自动合并**严格追加/前缀**关系（先同步、后继续）；
- 分叉时不会重编号、不会自动拼接：默认保留本机整份 + 远端整份写入 `.dsh-sync/conflicts/...`，并告警；
- 处理：比较两份日志，保留需要的一份；必要时手动 fork 成新会话；
- 预防：不要在两台设备上同时打开同一会话；切换设备前先关闭另一端的该会话。

### 7.6 轮询流量、二级限流与退避

- 空轮询约 1 KB/次；有变更约 3–10 KB/次；
- Git smart HTTP 端点**不消耗** GitHub REST 的 5000 次/小时配额，但受**二级限流**约束；
- 建议每设备 **≤15 次/分钟**；默认 3s/15s 配置在活跃时接近该值，空闲时远低于；
- 连续失败按 5s → 10s → 20s → 40s → 60s（上限 60s）退避 + 抖动；
- 需要降流量：
  - 调大 `realtime.intervalSeconds` / `idleIntervalSeconds`；
  - 或某台设备 `realtime.enabled=false`（回退到 `auto.intervalMinutes`，默认 10 分钟）；
  - 或只在一台设备开启实时，另一台手动/低频同步。
- 出现 429/限流日志时，先关闭部分设备的实时同步，等待后再恢复。

### 7.7 仓库增长与换仓库

- 会话 zstd 是整文件布局：每次追加都改变整个文件，Git 每次存新版本；
- 历史膨胀通常是原始会话数据量的 **3–7 倍**（经验估算）；
- 插件**不内置 LFS**、不自动压缩历史；
- 建议：
  1. 保持 `limits.maxFileMB` / `maxTotalMB` 合理；
  2. 定期换新私有仓库：新建 → 所有设备更新 `repo` → 第一台同步推送完整快照 → 其它设备同步（先采用远端历史再合并）→ 旧仓库归档；
  3. 换仓库时务必**所有设备**都改 `repo`，漏改的设备会继续往旧仓库推。

---

## 8. 命令、工具与 CLI

### 8.1 `/sync` 子命令

| 命令 | 作用 |
|---|---|
| `/sync` / `/sync status` | 查看状态：仓库、分支、设备、profile、同步范围、实时模式（活跃/空闲间隔、写后延迟）、工作区标签、路径映射、git、快照 HEAD、最近同步/错误、pending 数、最近冲突、本机会话数、配置提示 |
| `/sync sync` | 立即执行一次完整同步（别名 `/sync push`、`/sync pull`、`/sync now`） |
| `/sync init <repo>` | 写入/更新本机配置并立即执行首次同步 |
| `/sync help` | 显示用法 |

`/sync status` 输出示例（版本/设备不同会有差异）：

```text
DSH GitHub 同步状态
仓库：git@github.com:you/dsh-sync.git
分支：main　设备：workstation-a　profile：desktop
配置文件：C:\Users\you\.dsh\github-sync.json
同步范围：settings, sessions, workspaces, skills, attachments, market
实时同步：开启（活跃 3s / 空闲 15s 轮询；写后约 2s 推送）
工作区设备标签：开启（标题形如「wwa · workstation-a」）
本地快照仓库 HEAD：a1b2c3d4e5f6
最近同步：2026-10-22T08:00:00.000Z
待应用（本机打开中的会话）：1 个 — 关闭这些会话后自动拉取远端更新
最近冲突（1）：home/storages/schedule.json
可用命令：/sync status | /sync sync | /sync init <仓库地址>
```

同步完成摘要示例：

```text
✅ DSH GitHub 同步完成（设备 workstation-a，分支 main）
仓库：git@github.com:you/dsh-sync.git
提交：a1b2c3d4e5f6
方向：拉取远端更改 / 已推送
文件：导出 42 个；本机写入 0 个、更新 3 个、删除 0 个
```

命令结果只显示在 UI，不写入模型消息；生命周期事件会记录在会话日志。

### 8.2 `github_sync` 模型工具

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `status` \| `sync` \| `init` | 必填 |
| `repo` | string | `init` 时使用，GitHub 仓库 URL |
| `branch` | string | `init` 时使用，默认沿用当前配置 |
| `dryRun` | boolean | `sync` 时试运行：只规划导出，不改本机/快照仓库、不提交、不推送 |

工具返回 `{ ok, summary, conflicts? }`；`summary` 与命令摘要一致。可以让模型在对话里检查/触发同步，无需 shell。

### 8.3 CLI

```powershell
cd <插件目录>

node bin\dsh-github-sync.mjs status                # 状态
node bin\dsh-github-sync.mjs sync                  # 同步
node bin\dsh-github-sync.mjs sync --dry-run        # 试运行
node bin\dsh-github-sync.mjs init --repo git@github.com:<you>/<repo>.git `
  --branch main --device workstation-a --profile desktop
node bin\dsh-github-sync.mjs doctor                # 自检（git/token/配置）
node bin\dsh-github-sync.mjs paths                 # 打印路径
node bin\dsh-github-sync.mjs help                  # 用法
```

要点：

- CLI 与插件共享同一份配置、state、快照仓库；
- 适合首次配置、DSH 无法启动时恢复、计划任务、自检；
- Node 需要 `^22.19.0 || >=24.0.0`；
- 同步/init 失败退出码 1；参数错误 2；`doctor` 有阻塞问题 1；
- `--dry-run` 只做导出规划与统计：不写本机、不创建/修改快照仓库、不提交、不 fetch/merge/push；
- CLI 与运行中的 DSH 同时操作时，注意同一会话可能被 live 闸门保护；CLI 不会知道 DSH 的 live session（由 CLI 直接同步文件），建议在 DSH 关闭或空闲时做首次/恢复操作。

### 8.4 `doctor` 与 `paths`

`doctor` 检查 DSH home、Node、配置文件、repo、git、token 环境变量、最近同步/错误，并给出结论；`paths` 打印 DSH home、配置文件、状态文件、冲突/备份目录、快照仓库。

### 8.5 试运行（dry-run）

- 工具 `github_sync`：`{"action":"sync","dryRun":true}`；
- CLI：`sync --dry-run`；
- `/sync` 命令没有 dry-run 参数；
- dry-run 不修改仓库/本机，但会读取全部本机数据，可能较慢。

---

## 9. 配置字段完整参考

配置文件：`$DSH_HOME/github-sync.json`。

**合并顺序**（后者覆盖前者）：

1. 内置默认值（`lib/config.js` 的 `defaultConfig()`）；
2. profile patch 行 `config:`（安装 bundle 时默认只有 `enabled: true`）；
3. 本机 JSON。

规则：对象递归合并；数组整体替换；未知字段保留但不使用；未知 `scopes.*` / 非法 `onConflict` 会给出配置提示。

### 9.1 顶层字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `$schema` | 内置 URL | 仅编辑器提示，可删 |
| `version` | `1` | 配置格式版本；当前无迁移逻辑 |
| `enabled` | `true` | 是否启用后台同步（实时/自动）。`repo` 为空时强制视为 `false`；手动 `/sync sync` 不受限 |
| `repo` | `""` | 必填。私有仓库完整 URL：`https://...`、`git@...`、`ssh://...`；不支持 `owner/name` 简写 |
| `branch` | `"main"` | 分支；空仓库首次同步会创建；已有仓库应与默认分支一致 |
| `remoteName` | `"origin"` | 快照仓库 remote 名 |
| `deviceName` | 主机名 | 设备标识；清理为 `[A-Za-z0-9._-]`，最长 48；多设备必须不同 |
| `profileName` | `"desktop"` | 同步的 DSH profile；只处理 `profiles/<profileName>/` |
| `pathMappings` | `[]` | 路径映射，见 9.2 |
| `rewriteSessionPaths` | `true` | 重写会话 `header.cwd` 与事件文本；使用映射时必须为 true |
| `createMissingWorkspaceDirs` | `true` | 导入时创建映射目标目录并 `realpath`；建议保持 true |
| `onConflict` | `"keep-local"` | 冲突策略：`keep-local` / `prefer-remote` / `fail`，见第 10 节 |
| `excludeSessionIds` | `[]` | 导出时跳过这些会话 id（匹配 header `id`）；只影响导出 |
| `excludeWorkspacePaths` | `[]` | 不同步这些本机工作区（精确匹配路径，不含子路径；Windows 不区分大小写；填本机路径）；不删除本机数据，也不清理仓库历史 |
| `backup.enabled` | `true` | 覆盖/删除本机文件前备份 |
| `backup.keepDays` | `30` | 备份保留天数（1–3650）；成功同步后清理旧备份 |
| `limits.maxFileMB` | `100` | 单文件上限（0.1–4096 MB），超过跳过 |
| `limits.maxTotalMB` | `4096` | 单次导出总量上限（1–1048576 MB） |
| `limits.maxSessions` | `0` | 最多导出会话数（0–1,000,000），0 不限 |
| `commit.messagePrefix` | `"dsh-sync"` | 提交信息前缀 |
| `realtime` | 见 9.3 | 近实时同步设置（v0.2 默认开启） |
| `auto` | 见 9.4 | 启动同步与 realtime 关闭时的兜底 |

### 9.2 `pathMappings`

```json
"pathMappings": [
  { "from": "E:\\projects\\foo", "to": "D:\\projects\\foo" }
]
```

- `from`：仓库中保存的规范路径（A 的路径）；
- `to`：本机路径；
- 前缀匹配、最长优先、Windows 大小写不敏感；
- 支持对象写法；
- 路径会规范化为绝对路径并去尾部分隔符；导入时再 `realpath`。

### 9.3 `realtime`（v0.2，默认开启）

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `enabled` | `true` | boolean | 是否开启近实时轮询；false 回退到 `auto.intervalMinutes` |
| `intervalSeconds` | `3` | 1–3600 | 活跃轮询间隔（秒） |
| `idleIntervalSeconds` | `15` | 1–3600 | 空闲轮询间隔（秒） |
| `activeWindowSeconds` | `90` | 5–3600 | 最后一次会话活动后保持活跃的时长 |
| `pushDebounceSeconds` | `2` | 0–600 | 会话写入后延迟触发同步；0 不因写入额外触发 |
| `workspaceDeviceLabel` | `true` | boolean | 工作区标题追加 ` · 设备名` |
| `mergeAppendOnlySessions` | `true` | boolean | 会话日志严格追加/前缀时自动采用较长一份 |

生效/重启：

- `enabled`、`pushDebounceSeconds` 在插件加载时注册轮询/事件监听，修改后**建议重启**；
- `intervalSeconds`、`idleIntervalSeconds`、`activeWindowSeconds`、`workspaceDeviceLabel`、`mergeAppendOnlySessions` 每轮读取，下一轮生效。

### 9.4 `auto`（启动同步 + realtime 关闭时兜底）

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `startup` | `true` | boolean | 启动后先跑一轮：realtime 开启时约 5 秒后；关闭时约 15 秒后 |
| `intervalMinutes` | `10` | 0–1440 | 仅 realtime 关闭时的定时间隔；0 关闭 |
| `sessionDebounceSeconds` | `120` | 0–3600 | 仅 realtime 关闭时，会话写入后延迟触发；0 关闭 |

`auto.*` 在插件加载时读取，修改后需重载/重启。

### 9.5 `scopes`

```json
{
  "settings": true,
  "sessions": true,
  "workspaces": true,
  "skills": true,
  "attachments": true,
  "market": true,
  "projections": false,
  "plugins": false
}
```

| 字段 | 同步内容 |
|---|---|
| `settings` | `home/storages/**`（工作区/projcache/市场除外）、home patch、profile patch |
| `sessions` | `home/sessions/**`；live 会话导入暂缓 |
| `workspaces` | `home/storages/workspace.json` + `meta/workspaces.json` |
| `skills` | `home/skills/**`、`home/AGENTS.md`、`home/agents.md` |
| `attachments` | `home/attachments/**` |
| `market` | `community_market/global.json`、`sources/**` |
| `projections` | `session_projcache/**`（默认关） |
| `plugins` | profile 的 `package.json`/lock/workspace/compatibility/.npmrc（默认关） |

### 9.6 `git`

| 字段 | 默认 | 说明 |
|---|---|---|
| `path` | `"git"` | git 可执行名/绝对路径；找不到会尝试 Windows 常见路径 |
| `timeoutMs` | `180000` | 单条 git 命令超时（5000–3600000） |
| `tokenEnv` | `"DSH_SYNC_GITHUB_TOKEN"` | 首选 token 环境变量 |
| `fallbackTokenEnvs` | `["GH_TOKEN","GITHUB_TOKEN"]` | 备用 token 环境变量 |
| `batchMode` | `true` | 非交互：`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、SSH `BatchMode=yes` |
| `authorName` / `authorEmail` | `DSH GitHub Sync` / `dsh-sync@localhost` | 提交作者 |

token 仅用于 `https://` 远端；`git@` / `ssh://` 不使用 token。

### 9.7 `commit`、`backup`、`limits`、排除项

| 字段 | 默认 | 说明 |
|---|---|---|
| `commit.messagePrefix` | `"dsh-sync"` | 提交信息前缀；提交形如 `dsh-sync[<device>]: export <ISO> (+n ~n -n)` |
| `backup.enabled` | `true` | 覆盖/删除本机文件前是否写入 `github-sync/backups/` |
| `backup.keepDays` | `30` | 备份保留天数（1–3650）；成功同步后清理更早的备份目录 |
| `limits.maxFileMB` | `100` | 单文件上限（0.1–4096 MB）；超过跳过并告警 |
| `limits.maxTotalMB` | `4096` | 单次导出总量上限（1–1048576 MB） |
| `limits.maxSessions` | `0` | 最多导出会话数（0–1,000,000），0 不限 |
| `excludeSessionIds` | `[]` | 导出时跳过这些会话 id；只影响导出，仓库已有会话仍可能被导入 |
| `excludeWorkspacePaths` | `[]` | 不同步这些本机工作区（精确匹配，填本机路径）；不删除本机数据，也不清理仓库历史 |

### 9.8 生效时机汇总

| 改动 | 生效 |
|---|---|
| `repo`、`branch`、`scopes`、`pathMappings`、`onConflict`、`limits`、`backup`、`git.*`、`commit.*` | 下一轮同步/状态查询 |
| realtime 的间隔/窗口/标签/追加合并 | 下一轮 |
| `realtime.enabled`、`realtime.pushDebounceSeconds` | 建议重启（加载时注册） |
| `auto.*` | 需重载/重启 |
| 环境变量 token | 需完全重启 DSH |
| 插件代码/版本 | 重启一次 |

### 9.9 v0.1 → v0.2 升级差异

- 新增 `realtime` 配置段，默认开启近实时轮询/写后触发；
- 旧 `auto` 保留为 realtime 关闭时的兜底，默认行为变化（realtime 优先）；
- 新增运行时热应用（workspaceRegistry / api-session），工作区/会话免重启；
- 新增 `meta/workspaces.json` 来源设备 sidecar 与标题 `名称 · 设备名`；
- 新增 live 闸门 / `pendingSessionIds`；
- 新增会话 append-only 前缀合并；
- 配置向后兼容：v0.1 的 `github-sync.json` 不需要迁移，重启一次即可；旧仓库首次同步会自动生成 `meta/workspaces.json`。

---

## 10. 冲突与数据安全

### 10.1 `onConflict` 三种策略

| 值 | Git 合并冲突行为 | 导入阶段发现“本机与远端都改” |
|---|---|---|
| `keep-local`（默认） | 保留本机；对方版本写仓库 `.dsh-sync/conflicts/` | 保留本机；远端版本写本机 `conflicts/` + 仓库 `.dsh-sync/conflicts/` |
| `prefer-remote` | 保留远端；本机版本写仓库冲突副本 | 先备份本机，再采用远端版本，记入冲突列表 |
| `fail` | 报错中止，需人工处理 | 报错中止 |

例外：

- `workspace.json`：始终按工作区 path/id 语义合并；
- `patch` 文件：始终按 entry id 行合并（同 id 按 `onConflict`；`fail` 时保留本机并告警，不会中断整次同步）；
- `meta/workspaces.json`：按 path 并集合并；
- `home/sessions/**`：先做 append-only 比较，严格追加关系直接取较长一份；分叉才走 `onConflict`；
- 打开中的 live 会话：不会进入覆盖分支，而是 pending。

### 10.2 `workspace.json` 语义合并

- 以 canonical path 为第一身份、workspace id 为第二身份；
- 同路径不同 id → 合并到本机记录、保留本机 id；
- 同 id 不同路径 → 保留本机 path/title，`sessionIds` 取并集，时间戳取更宽范围；
- 只存在于远端的记录 → 映射后加入；
- 一个 session 只能归属一个 workspace；
- `workspaceIds` 重建顺序；归档/置顶取并集且互斥；
- 合并后 `mkdir` + `realpath`，再校验 DSH 不变量；校验失败**不写入**，保留本机并告警。

### 10.3 patch 按行 id 合并

- 剔除本插件自己的行（`id: github-sync` / `name: dsh-plugin-github-sync`）；
- 远端行为基础，本机独有行追加；同 id 冲突按 `onConflict`；
- 最后追加本机自己的插件行；
- 避免整文件覆盖导致另一台设备插件配置丢失。

### 10.4 会话 append-only / 分叉

见 2.7 / 7.5：严格前缀取较长一份；分叉不自动合并，冲突副本保留另一方整份日志。

> 补充经验：如果某台设备在 DSH 中重开并改写过该会话的日志，之后远端再更新会持续按 `keep-local` 冲突处理、不会自动收敛——这是有意的数据安全行为。需要在冲突设备上关闭会话、手动选择保留哪一份，或把该会话复制成新会话继续。

### 10.5 冲突副本与备份位置

见 2.8。要点：

- 备份/本机冲突副本在 `$DSH_HOME/github-sync/{backups,conflicts}/<时间戳>/`；
- 仓库冲突副本在 `.dsh-sync/conflicts/<device>/<时间戳>/`，随提交推送；
- 用 `Get-ChildItem` 按时间倒序查看；
- 冲突副本不会自动清理；备份按 `keepDays` 清理。

### 10.6 回滚

1. 完全退出 DSH Desktop；
2. 找到备份：
   ```powershell
   Get-ChildItem "$env:USERPROFILE\.dsh\github-sync\backups" | Sort-Object LastWriteTime -Descending | Select-Object -First 10
   ```
3. 把备份按相对路径复制回 `$DSH_HOME`；
4. 重启 DSH。

回滚仓库历史优先 `git revert`：

```powershell
git -C "$env:USERPROFILE\.dsh\github-sync\repo" log --oneline -20
git -C "$env:USERPROFILE\.dsh\github-sync\repo" revert <bad-commit>
```

不要随意 `reset --hard` 后强推，否则其他设备下次同步会把旧内容合并回来。

### 10.7 恢复 state.json

`state.json` 记录 managed 文件哈希、pending、最近结果。**不建议删除**：

- 删除后 `state.managed` 为空，下一次同步按“首次同步”处理；如果本机已有会话/工作区，则保留本机 + 远端副本，不会直接清空，但会产生较多副本/告警；
- 如果确实要重置，先备份。

### 10.8 在另一台设备恢复

1. 安装插件并重启一次；
2. 配好凭据，填同一个 `repo`；
3. 路径不同就配 `pathMappings`，必要时先创建目标目录；
4. 首次同步会导入远端内容（工作区/会话/设置按上面的合并规则）；
5. 需要时从 `github-sync/backups` / 仓库 `.dsh-sync/conflicts` 找回旧版本；
6. 首次映射/首次同步后建议重启一次，之后实时热应用。

### 10.9 dry-run

见 8.5：只规划，不写、不提交、不推送；适合同步前确认范围/变更量。

### 10.10 pending 会话

`/sync status` 显示“待应用（本机打开中的会话）：N 个”时：

- 找到对应会话，关闭并重新打开，或重启 DSH；
- 下一轮同步会自动应用；
- 不要删除 pending 的会话文件强制刷新。

---

## 11. 故障排查大全

### 11.1 快速诊断

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }

# 状态/自检
cd <插件目录>
node bin\dsh-github-sync.mjs status
node bin\dsh-github-sync.mjs doctor
node bin\dsh-github-sync.mjs paths

# 配置/历史/远端
Get-Content "$dshHome\github-sync.json" -Raw
git -C "$dshHome\github-sync\repo" remote -v
git -C "$dshHome\github-sync\repo" log --oneline -20
git -C "$dshHome\github-sync\repo" status --short

# 备份/冲突
Get-ChildItem "$dshHome\github-sync\backups" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
Get-ChildItem "$dshHome\github-sync\conflicts" -Recurse -File | Select-Object FullName, Length
```

DSH 内：`/sync status`；插件/桌面日志搜 `github-sync`。

### 11.2 SSH/ACL/端口/代理/GCM

| 现象 | 原因/处理 |
|---|---|
| `Bad owner or permissions on .ssh/config` | Windows ACL 太宽；按 4.7 用 `icacls` 去继承、只留当前用户/SYSTEM/Administrators；必要时 `takeown` |
| `Permission denied (publickey)` | key 未加到 GitHub / 选错 key / passphrase 未由 agent 加载；`ssh -vT git@github.com` 看用了哪个 key，`ssh-add` |
| `Connection timed out` / 22 端口被封 | `~/.ssh/config` 改用 `ssh.github.com:443`，见 4.3 |
| `Host key verification failed` | 首次连接确认指纹，或修复 known_hosts（不要盲目删除，先核对） |
| `安全包中没有可用的凭证`（HTTPS/GCM） | 改用 SSH，或 HTTPS + `DSH_SYNC_GITHUB_TOKEN`，见 4.8 |
| 代理相关 `Failed to connect` | 给 git 配代理：`git config --global http.proxy http://127.0.0.1:7890`；SSH 走 443；或用 CLI 在可联网环境先同步 |
| SSH 正常但插件仍认证失败 | 检查 `repo` 是否还是 https；SSH 地址应为 `git@github.com:...`；确认插件进程能读 `~/.ssh` |

### 11.3 git 找不到 / 超时

- 提示 `找不到可用的 git` → 安装 Git for Windows；或配置 `git.path` 到 `git.exe` 绝对路径；
- 单条命令超时 → 调大 `git.timeoutMs`；大仓库首次 fetch 较慢，可先手工 fetch 预热；
- 检查 `git --version` 在 DSH 进程的 PATH 中是否可见（GUI 启动可能 PATH 不同）。

### 11.4 认证失败 / 私有仓库 404

- `Repository not found`：仓库地址/owner/repo 是否拼错；PAT 是否授权该私有仓库；Deploy Key 是否加在**该仓库**且勾选 write；SSH key 是否挂到正确账号/仓库；
- SSH 成功但 push 403：Deploy Key 没勾 Allow write access，或账号无写权限；
- token 过期/权限不足：重新生成 PAT，Contents Read and write（classic 勾 `repo`）；
- **不要**把 token 拼进 URL；只放环境变量。

### 11.5 沙箱环境提示

如果在 DSH 的沙箱工具（agent shell）里运行 CLI 遇到 `EACCES`、网络拒绝、无法创建文件等：

- 插件 Host 代码本身不受 agent 沙箱限制，但**通过工具启动的 CLI 受工具沙箱约束**；
- 请在普通 PowerShell（系统终端）里执行安装/首次同步/doctor；
- 或在 DSH 内用 `/sync`、`github_sync` 工具。

### 11.6 同步成功但侧栏没有新工作区/会话

v0.2 正常无需重启：

1. 等 3–6 秒；`/sync status` 的“最近同步”是否更新；
2. 确认 `realtime.enabled` 为 true，且插件版本 v0.2；
3. 看 pending：如果显示待应用，关闭重开对应会话；
4. 看日志热应用告警（`受控工作区热应用失败`、`推送会话事件失败`）；
5. 若刚安装/升级，重启一次 DSH；
6. 检查本机文件/路径：`Get-ChildItem "$dshHome\sessions"`、`workspace.json` 的 `path`/`sessionIds`、`realpath` 是否匹配（junction/大小写/短路径）；
7. 如果 `workspace.json` 损坏且无法合并：完全退出 DSH，备份后删除它，让 DSH bootstrap（会丢顺序/置顶/归档）；
8. 兜底：完全重启 DSH。

### 11.7 工作区标题没有 ` · 设备名`

- `realtime.workspaceDeviceLabel` 是否为 true；
- 仓库 `meta/workspaces.json` 是否有该工作区的来源设备（旧版本导出的工作区要等来源设备下一次同步补上）；
- 关闭后重启不会自动剥离旧后缀，需手动改名；
- 所有设备统一设置后再期待一致行为。

### 11.8 已打开的会话不刷新 / pending 不消失

- 预期行为：live 会话不覆盖；pending 会在关闭重开/重启后应用；
- pending 数量持续不降：确认会话确实已关闭（DSH 侧栏/进程），或重启 DSH；
- 不要删除 pending 会话文件，会丢事件。

### 11.9 冲突副本怎么处理

- 本机 `github-sync\conflicts\<时间戳>\...` 是导入时远端版本；
- 仓库 `.dsh-sync/conflicts\<device>\<时间戳>\...` 是 Git 合并未保留一方；
- 需要时关闭 DSH，按相对路径复制回去；会话文件是 zstd，注意目录名与 `header.cwd` 一致；
- 处理后删除副本目录；插件不会自动清理。

### 11.10 推送被拒 / 两台设备同时同步

- `推送失败：远端分支在多次重试后仍被其他设备更新`：稍后自动/手动重试；错开操作；
- 频繁冲突：避免同时改同一文件/会话；可让一台关闭 realtime 或调大间隔；
- `另一个同步任务正在进行中`：实时轮询/写后触发/手动重叠，等一轮即可。

### 11.11 空仓库 / 分支不匹配

- 空仓库受支持：fetch 空仓库不会失败，首次 push 自动创建 `branch`；
- 如果远端默认分支是 `master` 而配置是 `main`，插件会在远端新建 `main`；建议把 `branch` 设为远端默认分支，或统一命名。

### 11.12 Windows 长路径

- 仓库已设 `core.longpaths=true`，系统仍需启用长路径支持（`LongPathsEnabled=1`）；
- 保持仓库在短路径（默认 `%USERPROFILE%\.dsh\github-sync\repo`）；
- 避免非常深的工作区目录；遇到 `Filename too long` 先启用系统长路径再重试。

### 11.13 DSH 版本漂移

- 会话格式当前 v4、workspace v2，会随 DSH 升级 bump；
- 插件按字节/结构处理，不校验版本；
- 两台设备尽量同版本；升级 DSH 前先同步并备份，升级后先在一台验证会话可打开；
- 升级插件到 v0.2 后重启一次 DSH。

### 11.14 会话打不开 / corrupt

- 检查 `pathMappings` 是否在首次同步前配置、`rewriteSessionPaths=true`；
- 检查会话目录名与本机 `header.cwd` 的 `projectKey` 是否一致；
- 从 `backups/` 或仓库历史恢复；
- 不要手改 zstd 二进制；不确定时保留冲突副本。

### 11.15 插件加载失败（第三方插件只是 optional warning）

- 第三方 Host 插件失败通常只记 warning，不影响 DSH 启动；
- 检查 `/sync` 是否存在、插件页是否启用、日志 `github-sync`；
- 重新安装 + 重启；`--dump-config` 可确认行是否存在（注意副作用）；
- 报错含 `cannot get property "tools" without inject` 等时，说明插件加载环境异常，升级/重装。

### 11.16 `/sync` 无响应 / 实时/定时不触发

- 首次同步/大仓库可能很慢，先看日志与 `state.lastAttemptAt`；
- `enabled` 是否为 true、`repo` 是否为空、`realtime.enabled` 是否为 true；
- 刚从 false 改 true 需要重启（加载时注册）；
- DSH 睡眠/休眠会暂停轮询，唤醒后继续；
- 手动 `/sync sync` 验证链路；仍失败用 CLI 看具体错误。

### 11.17 卸载/重装后异常

- 卸载后重启；重装后重启一次；
- 配置/数据目录保留，不会自动丢；
- 若残留旧插件行/依赖，检查 profile `package.json` 与 `cordis.patch.yml`（必要时手动清理，参考 DSH 文档）。

---

## 12. 卸载与恢复

### 12.1 卸载插件

```powershell
$dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
& $dsh plugin --profile desktop remove dsh-plugin-github-sync
```

然后重启 DSH。卸载只移除插件，不会删除：

- `$DSH_HOME/github-sync.json`；
- `$DSH_HOME/github-sync/`（快照仓库、state、备份、冲突）；
- GitHub 私有仓库及其历史。

如果插件是通过本地目录 `link:` / `file:` 安装的，可再手动删除插件目录；`remove` 通常会清理 profile `package.json` 里的依赖/bundles，若仍有残留，检查 `profiles/desktop/package.json` 与 `cordis.patch.yml` 并手动移除旧行。

**只会停用实时、保留插件：** 在配置中设：

```json
{
  "realtime": { "enabled": false }
}
```

然后重启一次 DSH。

### 12.2 彻底清理

确认不再需要数据后，完全退出 DSH，手动删除：

- `$DSH_HOME/github-sync.json`
- `$DSH_HOME/github-sync/`
- （可选）GitHub 私有仓库

删除前确认已备份；删除 `github-sync/repo` 会让下次同步重新初始化快照仓库。

### 12.3 重装/恢复

1. 重新安装插件并重启一次；
2. 配置仍在则直接 `/sync status`/`/sync sync`；
3. 配置丢了就用备份或重新 `/sync init <repo>`；
4. 首次同步会按第 6 节的合并策略导入远端数据。

---

## 13. 安全与隐私

1. **私有仓库是硬要求**：插件不检查可见性；公开仓库会泄露对话/附件/技能。
2. **token 不落盘**：只从环境变量读取，HTTPS 时作为临时 header，不写入配置/URL/日志，错误信息脱敏；不要把 token 放进仓库 URL。
3. **SSH key/Deploy Key**：私钥只在本机；Deploy Key 只授权单个仓库并勾选 write；设备丢失时撤销 key/PAT。
4. **`.credentials.yaml` 不同步**：B 设备自行登录 DSH、配置模型 key；不要把凭据文件手动复制进仓库。
5. **附件会同步**：`attachments=true` 时图片/文件进入私有仓库；敏感附件可关闭该 scope。
6. **明文副本**：本机快照仓库、备份、冲突副本、GitHub 历史都是明文/可解压明文；注意磁盘与账号安全。
7. **历史不可轻易抹除**：Git 提交保留历史；如曾推送敏感内容，删除文件不等于从历史删除，需要重写历史或更换仓库。
8. **最小权限**：PAT 只给目标仓库 Contents 读写；classic 只勾 `repo`；不要在组织全域授权。

---

## 14. 限制与未验证项

### 14.1 已知限制

1. **首次安装/升级需要重启一次 DSH**；之后运行期热应用无需重启。缺少 registry/session 服务的环境回退文件写入，需要重启。
2. **已打开的会话不会实时刷新**；更新 pending，关闭重开/重启后可见。
3. **同一会话两端同时写会分叉**；只自动合并严格追加/前缀，分叉不重编号、不自动拼接。
4. **不同步项目文件**；项目代码/文件请用其它工具同步。
5. **不同步 `.credentials.yaml` / `~/.agents` / 项目 `.dsh/skills`**；只同步 `$DSH_HOME` 受管路径。
6. **DSH 数据格式会变**：插件不校验 session v4 / workspace v2 版本；跨大版本可能导入不兼容数据。
7. **Windows 长路径**：系统未启用长路径时可能失败。
8. **无跨设备锁**：同一会话双端写只能事后处理。
9. **无 LFS/历史清理**：仓库会膨胀（3–7 倍经验值）。
10. **实时轮询有持续流量与二级限流风险**；建议每设备 ≤15 次/分钟。
11. **无图形设置页**：配置靠 JSON/命令/工具。
12. **Windows + DSH Desktop 为验证环境**；macOS/Linux 未实测。

### 14.2 未验证项（来自调研）

- Desktop HMR 对 `link:` 插件的实际重载行为（建议升级后重启一次）；
- Desktop 代理是否被 git 子进程继承（只保证进程环境 + git 自身配置）；
- 桌面插件页对 Git URL 安装的凭据流程；
- `api-session/*` 在浏览器端的最终渲染细节由 DSH 客户端决定，插件只负责 emit 正确载荷。

---

## 15. 注意点与坑（按严重程度）

> 🔴 严重：会导致数据泄露/丢失或功能不可用；🟠 中等：常见踩坑；🟡 提示。

| 级别 | 注意点 | 说明/处理 |
|---|---|---|
| 🔴 | 仓库必须私有 | 公开仓库会泄露对话/附件/技能；插件不检查可见性 |
| 🔴 | `.credentials.yaml` 不同步 | B 设备必须自行登录 DSH/配置模型 key |
| 🔴 | 项目文件不同步 | 只同步工作区注册表/会话/附件；项目代码用 git/网盘另行同步 |
| 🔴 | 首次安装/升级后重启一次 | 实时/热应用接线在加载时建立；之后才免重启 |
| 🔴 | 已打开会话不实时刷新 + 同会话双端写会分叉 | live 闸门 pending；分叉不自动合并，保留一方 + 冲突副本 |
| 🔴 | token/key 不要外泄 | 不放 URL/配置/日志/仓库；Deploy Key 勾 write 但仅单仓库 |
| 🟠 | `pathMappings` 首次同步前配好 | from=A 规范路径，to=B 本机路径；不要用 junction |
| 🟠 | Deploy Key 未勾 Allow write access | 只能拉不能推；push 403 |
| 🟠 | Windows `.ssh` ACL | `Bad owner or permissions` 用 icacls 修；见 4.7 |
| 🟠 | 22 端口被封 | `ssh.github.com:443`，见 4.3 |
| 🟠 | GCM TLS 失败 | 用 SSH 或 PAT 环境变量，别反复重试，见 4.8 |
| 🟠 | `workspaceDeviceLabel=false` 不剥离旧后缀 | 只阻止新增；旧标题需手动改名 |
| 🟠 | `realtime.enabled` / `pushDebounceSeconds` 改后需重启 | 加载时注册；其余 realtime 字段下一轮生效 |
| 🟠 | 实时流量/二级限流 | 每设备 ≤15 次/分钟；可调间隔/关闭 realtime |
| 🟠 | 仓库增长 | 整文件 zstd 历史 3–7 倍；定期换仓库/清理 |
| 🟡 | `auto` 是兜底 | 仅 realtime 关闭时生效；`auto.startup` 也影响启动首轮 |
| 🟡 | 删除 state.json 不可取 | 会按首次同步处理，产生副本/告警；先备份 |
| 🟡 | dry-run 只规划 | 不写本机/快照仓库、不提交/推送 |
| 🟡 | DSH 版本漂移 | 两台设备尽量同版本；升级前备份 |
| 🟡 | 长路径 | 系统启用 LongPathsEnabled；仓库路径尽量短 |
| 🟡 | 冲突副本不自动清理 | 确认无用后手动删 |
| 🟡 | 沙箱内跑 CLI | 用普通 PowerShell；Host 插件不受 agent 沙箱限制 |

---

## 16. 路径速查与 FAQ

### 16.1 路径速查

| 用途 | 路径/命令 |
|---|---|
| DSH home | `%USERPROFILE%\.dsh`（或 `$env:DSH_HOME`） |
| 本机配置 | `%USERPROFILE%\.dsh\github-sync.json` |
| 快照仓库 | `%USERPROFILE%\.dsh\github-sync\repo` |
| 状态文件 | `%USERPROFILE%\.dsh\github-sync\state.json` |
| 备份 | `%USERPROFILE%\.dsh\github-sync\backups\<时间戳>\` |
| 本机冲突副本 | `%USERPROFILE%\.dsh\github-sync\conflicts\<时间戳>\` |
| 仓库冲突副本 | `.dsh-sync/conflicts/<device>/<时间戳>/` |
| 仓库来源设备 | `meta/workspaces.json` |
| 插件目录 | `<插件目录>` |
| Desktop `dsh` 垫片 | `%APPDATA%\DSH Desktop\host-commands\desktop\generations\<hash>\bin\dsh.cmd` |
| profile 清单 | `%USERPROFILE%\.dsh\profiles\desktop\package.json` |
| 查看历史 | `git -C "$env:USERPROFILE\.dsh\github-sync\repo" log --oneline -20` |
| 状态 | `/sync status` 或 `node bin\dsh-github-sync.mjs status` |
| 自检 | `node bin\dsh-github-sync.mjs doctor` |

### 16.2 FAQ

**Q1. 会同步我的项目代码吗？**  
不会。只同步 DSH home 的工作区注册表/会话/附件等；项目代码用 git/网盘另行同步。

**Q2. 可以用公开仓库吗？**  
不可以，必须私有。对话/附件/技能会进入 Git 历史。

**Q3. B 设备还需要登录 DSH 吗？**  
需要。`.credentials.yaml` 不同步；B 要自己登录 DSH、配置模型 key。

**Q4. 为什么新会话在另一端没立刻出现？**  
等 3–6 秒；检查 `/sync status` 实时模式、最近同步、pending；刚安装/升级需重启一次。

**Q5. 为什么已打开的会话不刷新？**  
DSH live session 只读内存，插件不覆盖；关闭重开/重启后应用。pending 数量在 `/sync status` 显示。

**Q6. 两台设备能同时继续同一个会话吗？**  
不建议。会分叉，插件不自动合并；默认保留一方 + 整份冲突副本。切换前先关闭另一端的该会话。

**Q7. 工作区标题 ` · 设备名` 怎么去掉？**  
`realtime.workspaceDeviceLabel=false`，建议所有设备统一；已带后缀的标题需要手动改名。

**Q8. 怎么换同步仓库？**  
新建私有仓库 → 所有设备更新 `repo` → 第一台同步推送完整快照 → 其它设备同步 → 旧仓库归档。漏改的设备会继续推旧仓库。

**Q9. 能用 Git LFS 吗？**  
插件不内置 LFS；可以自行在快照仓库配置，但所有设备要一致，且插件不管理 LFS 行为。更推荐定期换仓库/清理历史。

**Q10. 如何只关闭实时、保留插件？**  
`realtime.enabled=false` 并重启一次；仍可手动 `/sync sync`。

**Q11. 备份/冲突副本在哪？**  
`$DSH_HOME/github-sync/backups/`、`.../conflicts/`、仓库 `.dsh-sync/conflicts/`；见 2.8/10.5。

**Q12. `doctor` 显示 token 未设置但 SSH 能用？**  
正常。`doctor` 只检查环境变量 token；SSH 方式不需要 token。

---

## 17. 附录：本机示例配置

> 下面是**示例**（deviceName=`jackfruit`、私有仓库 `git@github.com:initSummer/work_with_yan.git`、SSH 已配置、realtime 开启）。请把账号/仓库/设备名替换成你自己的；**不要写任何 token**。

```json
{
  "$schema": "https://github.com/deepseek-harness/dsh-plugin-github-sync#configuration",
  "version": 1,
  "enabled": true,
  "repo": "git@github.com:initSummer/work_with_yan.git",
  "branch": "main",
  "remoteName": "origin",
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
  "auto": {
    "startup": true,
    "intervalMinutes": 10,
    "sessionDebounceSeconds": 120
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

配套检查：

```powershell
ssh -T git@github.com
git ls-remote git@github.com:initSummer/work_with_yan.git
```

- 能列出 ref → SSH 与仓库权限 OK；
- `repo` 用 SSH 时不需要 `DSH_SYNC_GITHUB_TOKEN`；
- 若 `pathMappings` 为空，表示 B 上也使用与 A 相同的绝对路径；不同则按 6.5 配置。

---

## 18. 文档索引

- [安装与首次配置](docs/installation.md) — PAT/SSH、三种安装方式、重启一次、升级/卸载
- [配置参考](docs/configuration.md) — 所有字段（含 realtime）、默认值/范围、路径映射、scope 细节
- [故障排查](docs/troubleshooting.md) — 认证/SSH/ACL/GCM、实时同步、pending、标题、回滚、仓库膨胀
- [设计说明](docs/design.md) — 架构、实时轮询/热应用、投影、workspace 合并、append-only、冲突模型、限制
- [English README](README.md)

---

*最后更新：v0.2.0。文档与代码不一致时以代码为准；遇到未覆盖问题，先用 `/sync status` + `node bin\dsh-github-sync.mjs doctor` 收集信息。*
