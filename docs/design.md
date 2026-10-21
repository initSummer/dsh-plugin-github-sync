# 设计说明

本文描述 `dsh-plugin-github-sync` 的架构、数据投影、同步算法、冲突模型与已知限制，供维护者和想深入排查的用户阅读。事实以当前代码（`lib/`）与 DSH `0.2.1-rc.2` 的实际数据格式为准。

---

## 1. 目标与非目标

### 目标

- 用一个**私有 GitHub 仓库**作为多台设备之间 DSH 数据的传输层；
- 同步设置、对话记录、工作区注册表、技能、附件；
- 设备路径不同也能继续历史会话（通过 `pathMappings` 重写路径）；
- 冲突时不静默丢数据：默认保留本机版本，另一方进入冲突副本；
- 插件零第三方运行时依赖，纯 ESM，可直接以 `link:` / bundle 方式安装。

### 非目标

- 不做实时协作/多写者并发合并（同一会话同时继续会分叉）；
- 不管理 DSH 进程内的 workspace 注册表 API（通过文件投影实现，因此需要重启生效）；
- 不做 Git LFS、历史压缩或 GitHub API 操作；
- 不提供图形设置页；
- 不同步凭据、设备身份、运行时和缓存。

---

## 2. 架构

```text
┌────────────────────────────── DSH Desktop host 进程 ──────────────────────────────┐
│                                                                                    │
│  Cordis loader                                                                     │
│    └─ dsh-plugin-github-sync (lib/index.js)                                        │
│         ├─ /sync 命令        (lib/commands.js)                                     │
│         ├─ github_sync 工具  (lib/tools.js)                                        │
│         └─ 后台定时器/会话事件 (lib/index.js)                                       │
│                    │                                                               │
│                    ▼                                                               │
│           同步引擎 runSync (lib/sync.js)                                            │
│             ├─ 配置      lib/config.js                                             │
│             ├─ 路径映射  lib/paths.js                                               │
│             ├─ 快照投影  lib/snapshot.js  ←→  lib/sessions.js / lib/workspace.js    │
│             ├─ patch 行  lib/patch.js                                              │
│             ├─ Git 封装  lib/git.js                                                │
│             └─ 本机状态  lib/state.js                                              │
│                    │                                                               │
│         ┌──────────┴───────────┐                                                   │
│         ▼                      ▼                                                   │
│  $DSH_HOME（本机数据）   $DSH_HOME/github-sync/repo（快照 git 工作区）              │
│                                  │                                                 │
│                                  ▼                                                 │
│                         GitHub 私有仓库（branch）                                   │
└────────────────────────────────────────────────────────────────────────────────────┘

独立 CLI：bin/dsh-github-sync.mjs → 复用 lib/*（同一配置、状态、快照仓库）
```

### 模块职责

| 模块 | 职责 |
|---|---|
| `lib/index.js` | Cordis 插件入口：注册命令/工具、启动自动同步定时器与会话事件监听、清理 disposer |
| `lib/commands.js` | `/sync [status\|sync\|init\|help]`，输出面向用户的中文结果 |
| `lib/tools.js` | 模型工具 `github_sync`（`action=status/sync/init`） |
| `lib/sync.js` | 同步引擎：单飞锁、完整流程编排、Git 冲突处理、状态汇总、`/sync init` 写入配置 |
| `lib/snapshot.js` | 把本机 home 导出到仓库树、把仓库树导入本机（含备份/安全删除/冲突判定） |
| `lib/sessions.js` | zstd 帧扫描/解压/重压、读取会话 header、路径文本重写 |
| `lib/workspace.js` | `workspace.json` 解析/序列化/路径映射/语义合并/排除/不变量校验 |
| `lib/patch.js` | `cordis.patch.yml` 的按行（按 entry id）处理：剔除本插件自己的行、追加本机行、冲突合并 |
| `lib/git.js` | Git CLI 封装：非交互环境、token 注入、fetch/merge/push/commit、错误解释与脱敏 |
| `lib/config.js` | 默认值、配置合并/校验、token 读取、远端 URL 脱敏 |
| `lib/paths.js` | DSH home/配置/状态/仓库路径、`encodeSegment`/`projectKey`、`PathMapper` |
| `lib/state.js` | `state.json`：managed 文件表、最近结果、历史 |
| `lib/errors.js` | `SyncError` / `SyncConfigError` / `SyncConflictError` |
| `lib/fsutil.js` | 原子写、哈希、备份、安全遍历、文件占用判断 |
| `bin/dsh-github-sync.mjs` | 独立 CLI：`status/sync/init/doctor/paths` |

### 运行环境假设

- 插件运行在 DSH host 进程内，拥有 `ctx.tools`、`ctx.commands`（`inject = ['tools','commands']`）；`ctx.sessions` 等通过可选方式使用；
- 运行环境 Node 需支持 `node:zlib` 的 zstd API（DSH Desktop 自带 Node 24；独立 CLI 要求 `^22.19.0 || >=24.0.0`）；
- Git 通过 `child_process.execFile` 直接调用（不经 shell），并设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、可选 `GIT_SSH_COMMAND=ssh -o BatchMode=yes`。

---

## 3. 仓库投影

### 3.1 布局

仓库是一个普通 Git 工作树（本地路径 `$DSH_HOME/github-sync/repo`），内容按 `home/`（对应 `$DSH_HOME`）和 `profiles/<profileName>/` 投影：

```text
<repo>/
├─ .gitattributes
├─ home/
│  ├─ sessions/<projectKey(canonical cwd)>/<sessionDir>/session.v4.jsonl.zstd
│  ├─ storages/workspace.json
│  ├─ storages/**                     ← 其它设置域
│  ├─ cordis.patch.yml / cordis.yml   ← 若本机存在
│  ├─ skills/**、AGENTS.md
│  ├─ attachments/**
│  └─ ...
├─ profiles/<profileName>/
│  ├─ cordis.patch.yml
│  └─ package.json 等（仅 scopes.plugins）
└─ .dsh-sync/conflicts/<device>/<timestamp>/**   ← 冲突副本，导入时忽略
```

`.gitattributes` 由 `ensureRepo` 创建：

```text
* -text
*.json text eol=lf
*.jsonl text eol=lf
*.yml text eol=lf
*.yaml text eol=lf
*.md text eol=lf
```

目的是让会话 zstd 二进制不被行尾转换，同时让设置/JSON 保持可读 diff。同时设置 `core.autocrlf=false`、`core.longpaths=true`、`core.quotepath=false`。

### 3.2 导出时收集什么

`collectLocalEntries` 按 scope 遍历：

- **sessions**：`sessions/<project>/<session>/session[.vN].jsonl[.zstd]`。读取会话 header（只解第一帧）拿到 `id` 与 `cwd`；按 `cwd` 计算规范路径与 `projectKey`，需要时重写会话内容；
- **workspaces**：`storages/workspace.json`，路径规范化为仓库路径空间，并按 `excludeWorkspacePaths` 剔除记录；
- **settings**：`storages/**`（工作区、`session_projcache/`、`community_market/` 除外）、home 级 `cordis.patch.yml`/`cordis.yml`、profile `cordis.patch.yml`（后两者会剔除本插件自己的行）；
- **skills**：`skills/**`、`AGENTS.md`、`agents.md`；
- **attachments**：`attachments/**`；
- **market**：`community_market/global.json`、`community_market/sources/**`；
- **projections**（默认关）：`session_projcache/**`；
- **plugins**（默认关）：profile 的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`compatibility.json`、`.npmrc`。

每个文件在导出前会：
1. 检查大小上限（`limits.maxFileMB`）与总大小上限（`limits.maxTotalMB`）；
2. 读取内容并转换（workspace 路径规范化、patch 过滤本插件行、会话路径重写）；
3. 计算 SHA-256，与仓库工作区现有文件比较；不同才写入（原子写）。

导出还会删除“上一次由本机写入、但本机文件已消失”的仓库文件——但仅当：
- `state.managed` 中记录该路径的 writer 为 `local`；
- 本机对应文件确实不存在；
- **本机父目录仍然存在**（避免磁盘未挂载/路径映射变化被误判为批量删除）。

### 3.3 导入时接受什么

`importRepoToLocal` 对 `git ls-files` 列出的文件做分类（`classifyRepoRel`）：

- `.dsh-sync/**`、`home/.credentials.yaml`、`home/.anonymous-user-id`、`home/github-sync/**`、`home/cache/**` 永远忽略；
- 只接受当前 `profileName` 的 `profiles/<name>/` 文件；
- scope 未开启的类别跳过。

导入顺序：
1. 先读仓库中的 `workspace.json`，把每个工作区路径映射到本机并 `realpath`，建立 `canonical → local` 映射（用于后续会话路径解析）；
2. 按仓库路径字典序遍历所有可导入文件：
   - 会话：映射 `header.cwd` → 本机路径，必要时重写、放到 `sessions/<projectKey(本机路径)>/<id>/`；文件被占用时跳过并告警；
   - `workspace.json`：与本地注册表语义合并（见第 5 节）；
   - patch：按行 id 合并（过滤本插件自己的行后）：远端行与本机独有行都保留，同 id 内容不同按 `onConflict`（`keep-local` 默认本机、`prefer-remote` 远端、`fail` 时保留本机并告警），最后重新追加本机自己的插件行；
   - 其它文件：按 `home/` / `profiles/` 映射到本地路径，检测“本机在同步期间是否被修改”后决定覆盖/保留/冲突；普通冲突按 `onConflict`：`keep-local` 保留本机 + 远端副本、`prefer-remote` 备份本机 + 采用远端、`fail` 抛错；全新 home 与已有本地数据的默认取舍不同；
3. 处理删除：仅当 `state.managed` 记录 writer 为 `remote`、且本机文件哈希仍等于上次同步记录时，才删除本机文件；否则保留并告警。

首次同步会先做一次**预导入**：当 `detectFreshInstall` 判定本机是全新安装（没有会话、没有已登记工作区、profile patch 没有有效行）时，`preferRemoteUnknown=true` 让本机同名的不透明设置文件以**远端版本为准**（覆盖前备份），避免新设备用本地默认值覆盖远端已有内容；如果本机已有本地数据，则 `workspace.json` 做语义合并、patch 做行 id 合并，其它不透明设置默认保留本机版本并把远端版本写冲突副本（`prefer-remote` 时备份本机后采用远端版本），同时导入远端独有文件。

### 3.4 备份与冲突副本

- 覆盖/删除本机文件前（`backup.enabled=true`）复制到 `$DSH_HOME/github-sync/backups/<timestamp>/<相对路径>`；
- 导入阶段发现“本机文件在导出后又被修改”（DSH 正在写）且远端也提供了不同内容时，保留本机版本，把**远端版本**写到：
  - 本机 `$DSH_HOME/github-sync/conflicts/<timestamp>/<repoRel>`；
  - 仓库 `.dsh-sync/conflicts/<device>/<timestamp>/<repoRel>`（随提交推送，其他设备可见）。
- Git 合并冲突中未保留的一方只写到仓库冲突副本目录。
- 备份目录按 `backup.keepDays` 清理；冲突副本不自动清理。

---

## 4. 同步算法

`runSync` 是单飞（`activeSync` 模块级锁）。一次完整同步（非 dry-run）：

1. **读取状态与配置**：`state.json` + `github-sync.json`；`state.managed` 为空时本次视为 `firstSync`；
2. **定位 Git**：`git.path` → `git` → Windows 常见安装路径；
3. **确保快照仓库**：不存在则 `git init -b <branch>`；设置 `.gitattributes`、`core.*`、remote URL；
4. **首次/新设备采用远端历史**：如果仓库刚创建或还没有任何提交，先 `fetch`；若远端分支存在，`reset --hard origin/<branch>`，让后续 merge 有共同祖先；
5. **首次同步预导入**：`firstSync` 时先 `fetch`（必要时 reset 到远端分支），把远端内容导入本机。此时 `workspace.json` 语义合并、patch 按行 id 合并、远端会话按路径映射导入；若 `detectFreshInstall` 判定 home 是全新安装（无会话、无工作区、profile 无有效设置），则不透明设置文件远端优先（覆盖前备份），否则按 `onConflict` 处理（默认保留本机 + 远端副本，`prefer-remote` 备份本机后覆盖）；
6. **导出 + 提交**：`exportLocalToRepo` → `commitAll`（`dsh-sync[<device>]: export <iso> (+n ~n -n)`）；
7. **fetch + merge**：`fetchRemote`（不带 refspec）；若 `behind > 0` 调 `mergeRemote`：
   - 远端已包含在本机 → 无需动作；
   - 本机落后（仅远端前进）→ `git merge --ff-only origin/<branch>` 快进，worktree 更新；
   - 双方分叉 → `git merge --no-ff --allow-unrelated-histories`；
8. **解决冲突**：workspace/patch 语义合并；其它文件按 `onConflict`；写冲突副本并 `git add`；提交 `合并远端更改`；
9. **导入本机**：`importRepoToLocal`（备份/冲突保护/安全删除）；快进或 merge 后的 worktree 已包含远端新文件；
10. **再次导出 + 提交**：让语义合并后的 workspace/patch 在仓库中规范化（`merge-local`）；
11. **push**：`git push origin HEAD:refs/heads/<branch>`；非 fast-forward 时重新 fetch/merge/import/export/commit，最多 3 轮；仍失败抛 `PUSH_REJECTED`；
12. **收尾**：写 `state.json`、清理过期备份。

失败时（`NOT_CONFIGURED`、`GIT_MISSING`、`SYNC_CONFLICT`、`PUSH_REJECTED`、其它异常）会把错误写入 `state.lastError`，返回结构化结果，摘要以 `❌` 开头；不会抛出到 DSH 的 `session/flush`（后台同步只记日志）。

### Dry-run

`runSync({ dryRun: true })` 走独立分支：`planExport` 只读取本机数据并与现有快照工作区比较哈希，返回“将导出 N 个文件、其中 M 个相对当前快照有变化”，**不初始化/修改快照仓库**、不提交、不 fetch/merge/push、不写本机、不改 state。

### 自动同步时机

插件 `apply` 时读取一次配置并启动：

- `auto.startup`：加载后 15 秒执行一次（reason=`startup`）；
- `auto.intervalMinutes`：`setInterval` 周期执行（reason=`timer`）；
- `auto.sessionDebounceSeconds`：监听 `session/event`（`{global:true}`），首次事件后 120 秒执行一次（reason=`session`）；窗口内后续事件不重复排期；同步完成后的新事件会再次排期；
- 定时器/监听器在插件 disposer 中清理；`interval.unref()` 不阻止进程退出；
- 自动同步与手动同步共用 `runSync` 单飞锁；重叠请求返回 `busy/skipped`，不排队；
- `auto.*` 只在启动时读取，修改需要重载插件/重启 DSH；
- 没有退出时同步（DSH 退出阶段无法可靠 await 异步同步）。

---

## 5. `workspace.json` 语义合并

`workspace.json` 是 DSH 的 `storage-json` 单文件域（`unit.name=workspace, version=2`），启动时校验强不变量。同步引擎不使用整文件覆盖，而是：

1. 解析远端文档，按 `pathMappings` 映射到本机路径空间，再按 `excludeWorkspacePaths` 剔除记录；
2. `mergeWorkspaceDocs(local, remote)`：
   - 以 **canonical path** 为第一身份、**workspace id** 为第二身份匹配记录；
   - 同路径不同 id：合并到本机记录，保留本机 id，并给出提示；
   - 同 id 不同路径：保留本机 path/title，`sessionIds` 取并集、`createdAt` 取更早、`updatedAt` 取更晚；
   - 只存在于远端的记录：映射后加入；
   - 重复路径防御性合并；
   - 一个 session id 只能归属一个工作区（保留先出现者）；
   - `workspaceIds` = 本机顺序 + 本机表键 + 远端表键 + 远端顺序（去重、去掉无记录项）；
   - `archivedSessionIds` / `pinnedSessionIds` 取并集，且只保留仍存在归属的会话，pinned 与 archived 互斥；
   - `defaultWorkspaceId`：本机优先，其次远端，再其次第一个；
   - `initialized` 为 false 时根据远端/记录置 true；丢弃 `pendingMutation`（崩溃恢复标记跨设备无意义）；
3. 对合并后的每个 path 执行 `mkdir` + `realpath`（受 `createMissingWorkspaceDirs` 控制），确保与 DSH 的 `realpath(header.cwd)` 逐字一致；
4. `validateWorkspaceDoc` 校验不变量：`workspaceIds` ↔ 记录一一对应、路径唯一、session 唯一归属、归档与置顶不重叠；
5. 校验失败则**不写入**本机 `workspace.json`，保留本机注册表并告警；
6. 写入前备份本机文件，原子写 `workspace.json`。

副作用：在 DSH 运行中导入 `workspace.json` 不会立即被 UI 读取；重启 DSH 后才生效，且重启前在 UI 改工作区可能被内存状态覆盖。

---

## 6. 会话 zstd 处理

### 6.1 文件格式事实（DSH 0.2.1-rc.2）

- 会话日志是**多个独立 zstd 帧顺序拼接**；
- 第一帧必须恰好是一行 header（`{"type":"session",...}`），之后每帧是一批 JSONL 事件，帧明文以 `\n` 结束；
- 最后一帧允许撕裂（崩溃残留）；
- 目录名 `projectKey(header.cwd)` 与 header 的 `cwd` 必须一致，否则 DSH 读取时报 corrupt；工作区成员判定要求 `realpath(header.cwd)` 等于 `workspace.json` 的 `path`。

### 6.2 插件的处理策略

- **不需要改路径时**：直接按字节读取/写入，不重新压缩，保留原帧结构和撕裂尾部；
- **需要改路径时**（`pathMappings` 生效）：
  1. 结构扫描所有完整帧（magic、descriptor、block header、checksum）；
  2. 逐帧解压为文本；
  3. 校验首帧是“恰好一行 header”、其它帧以 `\n` 结束；不满足则**跳过重写**并告警（避免写出 DSH 不接受的容器）；
  4. 对每帧文本做路径替换（见 6.3），重新压成独立帧（带 checksum），按原帧顺序拼接；
  5. 撕裂尾部原样追加，不重压。
- 读取 header 时只解第一帧；无法解析的远端会话跳过并告警。

### 6.3 路径替换规则

`rewritePathText` 同时匹配四种写法：

- 原始路径（`E:\work_with_yan`）；
- JSON 转义写法（`E:\\work_with_yan`）；
- 正斜杠写法（`E:/work_with_yan`）；
- JSON 转义 + 正斜杠。

Windows 下大小写不敏感；替换按路径长度从长到短匹配，避免短前缀先替换。这会同时覆盖 `header.cwd`、`tool/result.meta.cwd/path`、`tool/call.arguments`、`user/message` 运行上下文、`assistant/message` 文本等事件数据中的绝对路径。

不变量：会话 id、seq、time、事件类型、`parentSession`、附件 `sha256:` 引用等都不改。

---

## 7. Patch 文件处理

`cordis.patch.yml` 是 YAML 数组，按 entry id 定位。本插件自己会插入 `id: github-sync` 的行，而该行的 `config` 是**机器本地**的（虽然目前默认只有 `enabled: true`，但用户可能写仓库地址等），因此：

- **导出**时，从 home/profile patch 文本中剔除本插件自己的行（`id: github-sync` 或包含 `dsh-plugin-github-sync`），再写入仓库；
- **导入**时，先剔除双方文本中本插件自己的行，再按顶层 entry 的 id 合并：远端行为基础，本机独有行追加在后；同 id 内容不同时按 `onConflict`（`keep-local` 默认本机、`prefer-remote` 远端、`fail` 时保留本机并告警），最后重新追加本机自己的行，保证每台设备的插件行不被对方覆盖；
- **Git 合并冲突**时复用同一个 `mergePatchTexts`：远端行在前、本机新增行追加；同 id 冲突按 `onConflict`（`fail` 抛冲突）；合并结果重新 `git add`；
- 空文件/只剩 `[]` 的场景由 `appendPatchRows` 处理，保证是合法的顶层数组。

---

## 8. 冲突模型

| 阶段 | 触发条件 | 处理 |
|---|---|---|
| Git 合并 | 同一文件在两条历史中都被修改 | `workspace.json` / patch 语义合并；其它文件按 `onConflict`：保留一方，另一方写入仓库 `.dsh-sync/conflicts/<device>/<timestamp>/`；`fail` 抛 `SyncConflictError` |
| 导入 workspace 合并 | 本机与远端都有 `workspace.json` | 语义合并（path/id），本机工作区保留、远端记录并入；不变量校验失败则保留本机 |
| 导入 patch 合并 | 本机与远端 patch 内容不同 | 按 entry id 合并：远端行为基、本机独有行追加、同 id 按 `onConflict`；`fail` 时保留本机并告警 |
| 首次同步（全新 home） | `firstSync` 且 `detectFreshInstall` 为真（无会话/无工作区/无有效 profile 设置） | 不透明设置文件远端优先（覆盖前备份）；workspace/patch 仍按上面两种语义/行合并处理 |
| 首次同步（已有本地数据） | `firstSync` 但本机已有会话/工作区/设置 | workspace 语义合并、patch 行合并；其它不透明设置默认保留本机 + 远端副本（`prefer-remote` 时备份本机后覆盖）；远端会话/独占文件导入 |
| 导入冲突（keep-local） | 本机不透明设置文件在本次导出后又被修改，或普通同步中本机已有该文件但上次同步未记录（如远端新出现且本机已有同名文件） | 保留本机，远端版本写本机 `conflicts/` + 仓库 `.dsh-sync/conflicts/`，记入冲突列表 |
| 导入冲突（prefer-remote） | 同上 | 备份本机到 `backups/` 后采用远端版本，记入冲突列表并告警 |
| 导入冲突（fail） | 同上 | 抛 `SyncConflictError`，中止本次同步 |
| 正常更新 | 本机文件自上次同步未变、远端有新版本 | 备份本机旧文件 → 写入远端版本 |
| 安全删除 | 远端删除某文件；本机文件仍等于上次同步记录 | 备份后删除；若本机已修改则保留并告警 |

设计取舍：

- **默认（`keep-local`）不静默丢本机数据**，宁可多留冲突副本；`prefer-remote` 覆盖前也会备份本机文件。
- 会话日志是追加写的二进制，Git 无法行级合并，因此“同一会话双方都追加”只能判定为冲突。
- `workspace.json` 不采用 Git 冲突解决（JSON 数组/对象冲突体验差），而是读出双方文档做语义合并；合并失败则保留本机注册表。
- patch 文件用“行级 + id”合并，避免整文件覆盖导致另一台设备的插件配置丢失。

---

## 9. 状态与删除传播

`state.json` 保存：

- `managed`：仓库路径 → `{ hash, localPath, localHash, kind, writer }`；
- `deviceId`（首次同步生成的随机 id）、`deviceName`；
- `lastSyncAt` / `lastAttemptAt` / `lastPushAt` / `lastPullAt` / `lastCommit` / `lastError` / `lastSummary`；
- `history`（最近 20 条结果）、`conflicts`（最近 50 条冲突路径）。

删除传播是双向且保守的：

- **导出删除仓库文件**：仅对“上次由本机写、本机文件已消失、本机父目录仍存在”的路径执行；
- **导入删除本机文件**：仅对“上次由远端写、本机文件哈希仍等于记录值”的路径执行；
- 任何“本机已修改”的情况都保留本机并告警。

因此卸载磁盘、临时改路径映射不会造成批量删除；手工删除 `state.json` 也不会被误判为“用户主动删除一切”，但会让下一次同步按**首次同步**处理（先导入远端；不透明设置是否远端优先取决于是不是全新 home，覆盖前备份），所以仍不建议随意删除。

---

## 10. 并发、锁与错误模型

- **进程内单飞**：`runSync` 用模块级 Promise 锁；自动/手动/工具/命令共享。重叠返回 `busy/skipped`。
- **跨设备无锁**：两台设备可同时同步；通过 fetch/merge/push 重试（最多 3 轮）收敛；仍失败抛 `PUSH_REJECTED` 并提示错开自动同步。
- **Git 子进程**：非交互、超时（`git.timeoutMs`）、`maxBuffer` 64 MiB；失败时把 stderr 末尾几行转成用户可读中文建议（认证/网络/SSH/通用）。
- **错误分类**：`NOT_CONFIGURED`、`GIT_MISSING`、`SYNC_CONFLICT`、`PUSH_REJECTED`、`SYNC_CONFIG`、其它 `SYNC_FAILED`；结果不会抛出到会话持久化路径。
- **文件占用**：Windows 上会话文件被 DSH 写入时可能 `EBUSY/EPERM/EACCES`；会话导入捕获后跳过并告警，下次重试。

---

## 11. 安全模型

- **只信任私有仓库**；插件不检查仓库可见性。
- token 只从进程环境读取；HTTPS 场景以 `http.extraHeader=AUTHORIZATION: basic base64("x-access-token:<token>")` 作为**临时 `git -c` 参数**传递，不写 `.git/config`、不写入 remote URL；错误信息与日志对 token 做替换脱敏。
- 固定排除 `.credentials.yaml`、`.anonymous-user-id`、cache、`github-sync/` 自身、`.dsh-sync/` 冲突目录；`node_modules`/运行时不会被遍历（不在收集路径中）。
- `workspace.json` 合并前做不变量校验，失败不写入，避免让 DSH 启动失败。
- 备份/冲突副本包含明文数据，需自行保护磁盘。

---

## 12. 容量与限制

- 单文件 `limits.maxFileMB`（默认 100 MB）、单次总导出 `limits.maxTotalMB`（默认 4 GB）、可选会话数上限；超限跳过并告警。
- 会话是 zstd 二进制，每次追加都会重写整个文件；Git 仓库会随对话增长。插件不提供 LFS/历史清理。
- 会话/附件多时首次同步可能较慢；`git.timeoutMs` 可按网络调大。
- 深层路径 + Windows 长路径限制：仓库设置 `core.longpaths=true`，系统仍需启用长路径支持。

---

## 13. 已知限制与未验证项

### 已知限制

1. **导入后需重启 DSH**：workspace 注册表/会话扫描只在启动时进行；运行期间外部写入不触发 UI 刷新。
2. **同一会话并发继续会分叉**：不做会话级自动合并；冲突副本保留一方。
3. **自动同步配置需重载**：`auto.*` 只在插件加载时读取。
4. **退出不同步**：DSH 退出阶段不做同步。
5. **DSH 数据格式版本变化**：插件不校验 session v4 / workspace v2 版本；跨大版本同步可能导入不兼容数据。
6. **无跨设备锁**：依赖 Git 冲突与重试收敛。
7. **无 LFS/历史清理**：仓库会膨胀。
8. **无图形设置页**：配置靠 JSON/命令/工具。
9. **Windows 长路径**：系统未启用长路径时可能失败。

### 未验证项（来自 DSH 调研资料）

- Desktop 下 HMR 对 `link:` 插件的实际重载行为（文档建议重启）；
- Desktop 的代理设置是否被 git 子进程继承（插件只继承进程环境与 git 自身配置）；
- 桌面插件页对 Git URL 安装的凭据流程；
- 在 DSH 运行期间导入 `workspace.json` 的具体覆盖时序（因此要求导入后尽快重启、重启前不改工作区）。

### 可扩展方向

- 跨设备“会话 lease/owner”以避免分叉；
- 可选的 LFS 或按会话快照策略；
- DSH 数据格式版本检测与迁移提示；
- 图形化配置页（host HTTP 页面或 client 插件）；
- 更细粒度的 scope（例如按工作区/按会话标签）。
