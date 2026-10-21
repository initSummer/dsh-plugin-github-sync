# 配置参考

本插件所有行为都由一份**机器本地**配置文件驱动：

```text
$DSH_HOME/github-sync.json
```

其中 `$DSH_HOME` 的解析顺序：环境变量 `DSH_HOME` → `%USERPROFILE%\.dsh`（Windows 上的默认值）。

> 这份文件**不会被同步**。每台设备的 `repo`、`deviceName`、`pathMappings`、token 环境变量名等都可以不同。

---

## 1. 配置从哪里来、谁覆盖谁

加载顺序（后者覆盖前者）：

1. 插件内置默认值（见 `lib/config.js` 的 `defaultConfig()`）；
2. profile patch 行 `config:`（即 `cordis.patch.yml` 中 `id: github-sync` 那一行的 `config`，安装 bundle 时默认只有 `enabled: true`）；
3. 本机 `$DSH_HOME/github-sync.json`。

合并规则：

- 对象递归合并；
- **数组整体替换**，不会追加；
- 未知字段会被保留但不使用；未知的 `scopes.*` 或非法 `onConflict` 会给出配置提示。

因此推荐把**所有机器相关的配置**都写在 `github-sync.json`，不要把仓库地址/路径映射写进会被同步的 `cordis.patch.yml`。

---

## 2. 最小配置

```json
{
  "repo": "https://github.com/<you>/dsh-sync.git",
  "branch": "main",
  "deviceName": "workstation-a"
}
```

其余字段使用默认值。也可以不手工编辑，直接执行：

```text
/sync init https://github.com/<you>/dsh-sync.git
```

---

## 3. 完整配置示例

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

- JSON 中 Windows 路径必须转义：`"E:\\work_with_yan"`；
- 文件保存为 UTF-8 即可（读取时会去掉 BOM）；
- 修改后不需要重新安装插件。除 `auto.*` 外的字段在下一次同步/状态查询时生效。

---

## 4. 顶层字段

### 4.1 基本

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `$schema` | string | 内置 URL | 仅用于编辑器提示，可删 |
| `version` | number | `1` | 配置格式版本；当前没有迁移逻辑，保持默认即可 |
| `enabled` | boolean | `true` | 是否启用**自动同步**。`repo` 为空时会被强制视为 `false`。手动 `/sync sync`、工具 `action=sync`、CLI `sync` 只要有 `repo` 就会执行，不受此字段阻止 |
| `repo` | string | `""` | **必填**。GitHub 私有仓库完整 URL：`https://github.com/<you>/<repo>.git`、`git@github.com:<you>/<repo>.git` 或 `ssh://...`。不接受 `owner/name` 简写 |
| `branch` | string | `"main"` | 同步分支。空仓库首次同步会自动创建该分支；已有仓库应填远端默认分支名 |
| `remoteName` | string | `"origin"` | 快照仓库里的 remote 名；通常不用改 |
| `deviceName` | string | 主机名 | 设备标识（提交信息、冲突副本目录）。会清理为 `[A-Za-z0-9._-]`，去首尾 `-`，最长 48；为空时回退到清理后的主机名 |
| `profileName` | string | `"desktop"` | 要同步的 DSH profile。插件只处理 `profiles/<profileName>/`，仓库里其它 profile 目录会被忽略 |

### 4.2 路径映射与重写

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `pathMappings` | array / object | `[]` | 仓库规范路径 ↔ 本机路径的映射，见第 5 节 |
| `rewriteSessionPaths` | boolean | `true` | 是否重写会话中的路径：`header.cwd`、目录名、以及事件文本里的旧路径。使用 `pathMappings` 时必须为 `true`，否则需要重写的会话会被跳过并告警 |
| `createMissingWorkspaceDirs` | boolean | `true` | 导入时自动创建映射后的工作区目录，并用 `realpath` 规范化，保证与 DSH 记录的 `workspace.path` 一致。关闭后目录不存在时工作区可能不显示，不建议关 |

### 4.3 冲突与备份

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `onConflict` | string | `"keep-local"` | 冲突策略（Git 合并冲突 + 导入阶段双方都改的冲突）：`keep-local` / `prefer-remote` / `fail`（也接受 `local`、`remote` 别名）。未知值告警并回退 `keep-local` |
| `backup.enabled` | boolean | `true` | 覆盖或删除本机文件前是否备份到 `$DSH_HOME/github-sync/backups/<时间戳>/` |
| `backup.keepDays` | number | `30` | 备份保留天数（1–3650）；成功同步后清理更早的备份目录。冲突副本目录不会自动清理 |

`onConflict` 的准确语义：

| 值 | Git 合并冲突（同一文件双方都改） | 导入阶段发现本机文件在同步期间被修改 |
|---|---|---|
| `keep-local` | 保留本机版本；对方版本写入仓库 `.dsh-sync/conflicts/<device>/<时间戳>/` | 保留本机版本；远端版本同时写入本机 `conflicts/` 与仓库 `.dsh-sync/conflicts/` |
| `prefer-remote` | 保留远端版本；本机版本写入仓库冲突副本 | 先备份本机文件，再采用远端版本，并记入冲突列表（本机旧版本在 `backups/`） |
| `fail` | 立即报错中止，不做保留/覆盖 | 立即报错中止 |

远端正常更新一个本机未修改的文件不属于冲突：会先备份本机旧文件，再写入远端版本（`fail` 也不会因此报错）。

`workspace.json` 和 patch 文件有专门的合并逻辑，不走上面的整文件冲突：

- `workspace.json` 始终按工作区 path/id 做语义合并（本机记录保留、远端记录/会话并入），合并后校验 DSH 不变量；校验失败则保留本机注册表并告警。
- `cordis.patch.yml` 按 entry id 行合并：远端行与本机独有行都保留；同 id 行按 `onConflict`（默认保留本机）；`fail` 时保留本机并告警，不会因此中断整次同步。

### 4.4 排除项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `excludeSessionIds` | string[] | `[]` | 导出时跳过这些会话 id（按会话 header 的 `id` 匹配）。只影响导出；仓库中已存在的这些会话仍可能被导入，如需彻底排除请同时从仓库删除 |
| `excludeWorkspacePaths` | string[] | `[]` | 不同步这些本机工作区（精确匹配工作区路径，不含子路径；Windows 下不区分大小写；填写**本机路径**）。效果：该工作区的会话不导出/不导入；仓库 `workspace.json` 中对应记录会被剔除并重建不变量（`workspaceIds`、`defaultWorkspaceId`、归档/置顶集合等）。**不会删除本机数据** |

示例：

```json
"excludeSessionIds": ["session-0d1e90f3-..."],
"excludeWorkspacePaths": ["C:\\Users\\me\\scratch", "D:\\secret-project"]
```

排除是“本机视角”的：只在读取/写入本机时跳过，不会从仓库历史中删除已经上传的数据；如需彻底移除，请在仓库中删除对应文件/记录并提交（注意其他设备仍可能持有副本）。

### 4.5 其它

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `commit.messagePrefix` | string | `"dsh-sync"` | 提交信息前缀。实际格式：`dsh-sync[<device>]: export <ISO 时间> (+n ~n -n)`、`dsh-sync[<device>]: 合并远端更改`、`dsh-sync[<device>]: retry ...` |
| `limits.maxFileMB` | number | `100` | 单文件上限（0.1–4096 MB）。超过的文件跳过并给出提示；很大的会话/附件可能触发 |
| `limits.maxTotalMB` | number | `4096` | 单次导出的总大小上限（1–1048576 MB），超出后剩余文件跳过并告警 |
| `limits.maxSessions` | number | `0` | 最多导出会话数（0–1,000,000），`0` 表示不限 |

---

## 5. `pathMappings` 详解

### 5.1 语义

```json
"pathMappings": [
  { "from": "E:\\work_with_yan", "to": "D:\\wwa" }
]
```

- `from`：**仓库中保存的规范路径**（通常是最早那台设备 A 上的路径，`/sync status` 会把映射打印出来）；
- `to`：**当前设备**上的真实路径；
- 前缀匹配，最长前缀优先；Windows 下大小写不敏感；
- 也接受对象写法：

  ```json
  "pathMappings": { "E:\\work_with_yan": "D:\\wwa" }
  ```

- 两条路径都会被规范化为绝对路径并去掉末尾分隔符。

### 5.2 三个设备、三种路径

```json
"pathMappings": [
  { "from": "E:\\work_with_yan", "to": "D:\\wwa" },
  { "from": "E:\\other", "to": "D:\\projects\\other" }
]
```

可以写多条，互不重叠；嵌套路径时最长前缀生效。

### 5.3 导入/导出时插件做了什么

导出（本机 → 仓库）：

1. 把 `workspace.json` 中每个工作区 `path` 经 `to → from` 映射回规范路径；
2. 读取会话 header 的 `cwd`，映射为规范路径；
3. 需要时逐帧解压/重压会话 zstd，重写 `header.cwd` 和事件文本中的路径（同时覆盖单反斜杠、双反斜杠、正斜杠写法）；
4. 按规范路径的 `projectKey` 生成会话目录名（如 `--E-work_with_yan--`）。

导入（仓库 → 本机）：

1. 把 `workspace.json` 记录映射到本机路径，按需创建目录并 `realpath`；
2. 会话 header 路径映射到本机路径，重写后写入；
3. 会话目录名按本机路径的 `projectKey` 生成（如 `--D-wwa--`）。

### 5.4 注意事项

- **首次同步前就配好映射**。否则插件会以为 A 的路径就是本机路径，可能在本机创建 `E:\work_with_yan`（若 `createMissingWorkspaceDirs=true` 且有权限），或导入的会话路径与 B 的实际目录不一致。
- **不要用 junction / symlink 代替映射**：DSH 使用 `realpath` 比对，链接会被解析成真实目标，导致工作区/会话匹配失败。
- 映射只影响路径，不改会话 id、附件哈希、`parentSession` 链。

---

## 6. `auto`：自动同步

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `auto.startup` | `true` | boolean | 插件加载后约 **15 秒**触发一次启动同步 |
| `auto.intervalMinutes` | `10` | 0–1440 | 定时同步间隔（分钟）；`0` 关闭 |
| `auto.sessionDebounceSeconds` | `120` | 0–3600 | 有会话写入事件后约 120 秒触发一次同步；窗口内后续事件不会重复排期；`0` 关闭 |

行为细节：

- 自动同步只在插件加载时读取一次这些值；修改后需要**重载插件或重启 DSH** 才生效。
- 自动同步与手动同步共享单飞锁：同一进程内同时只允许一个同步，重叠请求会被跳过（结果提示“另一个同步任务正在进行中”）。
- **退出 DSH 时不会自动同步**（退出阶段无法可靠等待同步完成）。请依赖定时同步，或在关闭 DSH 前手动 `/sync sync`。
- 只读设备（不想推送）可以设 `auto.startup=false`、`auto.intervalMinutes=0`、`auto.sessionDebounceSeconds=0`，需要时再手动同步。

---

## 7. `scopes`：同步范围

默认值：

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

| 字段 | 同步内容 | 备注 |
|---|---|---|
| `settings` | `home/storages/**`（工作区、projcache、community_market 除外）、`home/cordis.patch.yml`、`home/cordis.yml`、`profiles/<profileName>/cordis.patch.yml` | patch 文件会剔除本插件自己的行（`id: github-sync` / `name: dsh-plugin-github-sync`），避免把 A 的本机配置带到 B |
| `sessions` | `home/sessions/**` | 只处理 `session[.vN].jsonl[.zstd]` 日志文件；跳过锁/临时文件/符号链接 |
| `workspaces` | `home/storages/workspace.json` | 语义合并，见主 README |
| `skills` | `home/skills/**`、`home/AGENTS.md`、`home/agents.md` | 用户级技能与全局指令 |
| `attachments` | `home/attachments/**` | 会话附件对象；关闭后 B 上历史图片/文件可能读不到 |
| `market` | `home/storages/community_market/global.json`、`community_market/sources/**` | 只同步权威来源注册，不同步目录缓存 |
| `projections` | `home/storages/session_projcache/**` | 纯派生缓存，可重建；一般保持关闭 |
| `plugins` | `profiles/<profileName>/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`compatibility.json`、`.npmrc` | 打开后会同步插件清单，可能改变 B 的插件环境，慎用 |

常见组合：

- **只要设置，不要对话**：`sessions=false`、`workspaces=false`、`attachments=false`。
- **只要对话/工作区**：`settings=false`、`skills=false`、`market=false`。
- **完全手动**：关闭所有 `auto.*`，只用 `/sync sync`。

注意：关闭 `workspaces` 但保留 `sessions` 时，导入的会话不会自动登记到工作区；关闭 `sessions` 但保留 `workspaces` 时，远端工作区可能指向缺失会话。插件会在状态中提示。

---

## 8. `git` 与 token

| 字段 | 默认 | 说明 |
|---|---|---|
| `git.path` | `"git"` | `git` 可执行文件名或绝对路径。找不到时会尝试 `C:\Program Files\Git\cmd\git.exe` 等常见路径 |
| `git.timeoutMs` | `180000` | 单条 git 命令超时（5 秒–1 小时） |
| `git.tokenEnv` | `"DSH_SYNC_GITHUB_TOKEN"` | 首选 token 环境变量名 |
| `git.fallbackTokenEnvs` | `["GH_TOKEN", "GITHUB_TOKEN"]` | 备用 token 环境变量 |
| `git.batchMode` | `true` | 非交互模式：`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、SSH `BatchMode=yes`，避免后台同步卡在提示上 |
| `git.authorName` / `git.authorEmail` | `DSH GitHub Sync` / `dsh-sync@localhost` | 提交作者信息 |

token 查找顺序与使用方式：

1. 依次检查 `git.tokenEnv` 和 `git.fallbackTokenEnvs` 中的环境变量，取第一个非空值；
2. 仅当 `repo` 是 `https://` 地址时，把 token 作为临时 `http.extraHeader`（`x-access-token:<token>` 的 Basic 认证）传给 git；
3. token 不写入 git 配置、远程 URL、提交或日志；错误输出会脱敏；
4. `git@` / `ssh://` 地址不使用 token。

若使用 HTTPS 但不想配 token，可依赖 Git Credential Manager 或系统凭据。

---

## 9. 改配置的生效时机

| 改动 | 生效方式 |
|---|---|
| `repo`、`branch`、`remoteName`、`scopes`、`pathMappings`、`rewriteSessionPaths`、`createMissingWorkspaceDirs`、`onConflict`、`backup`、`limits`、`excludeSessionIds`、`excludeWorkspacePaths`、`git.*`、`commit.*` | 每次同步/状态查询都会重新读取 `github-sync.json`，**下一次操作即生效**（token 环境变量本身需 DSH 重启后才进入进程环境） |
| `auto.*` | 插件加载时读取一次，需要重载插件/重启 DSH |
| `deviceName` / `profileName` | 下一次操作生效；`deviceName` 会体现在之后提交的信息/冲突目录名中 |
| 插件代码/版本 | 重启 DSH（`link:` 安装时） |

`/sync init` 会写回配置文件（保留其它字段），之后的同步会重新读取。

---

## 10. 配置错误会怎样

- 配置文件不是合法 JSON：读取失败，错误信息包含文件路径，同步不会执行；修正 JSON 即可。
- `repo` 为空：插件仍加载，但 `enabled` 被视为 `false`，自动同步不启动；`/sync status` 会提示未配置。
- `onConflict` 非法：告警并回退 `keep-local`。
- `scopes` 未知键：告警并忽略。
- 数值越界：自动收敛到允许范围（例如 `intervalMinutes` 大于 1440 会按 1440 处理）。
- `pathMappings` 结构不合法（缺少 `from`/`to`、不是对象）：加载时报错，提示 `pathMappings` 需要 `{from,to}` 或对象映射。
- `git` 不可用：同步返回 `找不到可用的 git`，按提示安装或设置 `git.path`。

更多排查见 [troubleshooting.md](troubleshooting.md)。
