# 故障排查

本文按“先定位 → 再修复”的顺序组织。所有命令都可以在 PowerShell 中直接执行；`$dshHome` 若使用默认路径可省略设置。

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
```

---

## 1. 先做三件事

1. 在 DSH 里执行 `/sync status`，看仓库、分支、设备、最近错误、最近冲突。
2. 在插件目录运行 CLI 自检：

   ```powershell
   cd <插件目录>
   node bin\dsh-github-sync.mjs doctor
   node bin\dsh-github-sync.mjs status
   ```

3. 看快照仓库状态与历史：

   ```powershell
   git -C "$dshHome\github-sync\repo" remote -v
   git -C "$dshHome\github-sync\repo" status --short
   git -C "$dshHome\github-sync\repo" log --oneline -20
   ```

如果 `/sync` 命令本身不存在，直接跳到第 12 节。

---

## 2. Git 认证失败

**典型提示**：

```text
Git 认证失败。请为这台设备配置 GitHub 凭据，任选其一：
1) 设置环境变量 DSH_SYNC_GITHUB_TOKEN（或 GH_TOKEN / GITHUB_TOKEN）...
2) 使用 Git Credential Manager 登录（git credential-manager github login）；
3) 把远端换成 SSH 地址并配置好 ssh key。
```

排查顺序：

1. **确认 token 在当前 DSH 进程里可见。**
   - 设置用户环境变量后，必须**完全退出并重启 DSH Desktop**；
   - 可用 CLI 验证（在同一窗口设置 token 后运行）：
     ```powershell
     $env:DSH_SYNC_GITHUB_TOKEN = "github_pat_xxxxxxxx"
     node bin\dsh-github-sync.mjs doctor
     ```
     `doctor` 会显示“环境变量 xxx 已设置”，不会打印内容。
2. **确认 token 权限**：Fine-grained 需要目标仓库 **Contents: Read and write**；classic 需要 `repo` scope。token 过期也会认证失败。
3. **确认仓库地址**：`https://github.com/<you>/dsh-sync.git`。不要用 `owner/name` 简写；不要把 token 拼进 URL。
4. **GCM 方式**：`git credential-manager github login`，然后不设 token 再试。
5. **SSH 方式**：仓库地址用 `git@github.com:<you>/dsh-sync.git`；`ssh -T git@github.com` 验证；插件默认 `BatchMode=yes`，需要 ssh-agent 且私钥不要交互口令。
6. 仍然失败时，手工执行一次 fetch 看原始错误（会使用系统凭据，不会打印 token）：
   ```powershell
   git -C "$dshHome\github-sync\repo" fetch --prune --no-tags origin
   ```

---

## 3. 网络 / 代理问题

**典型提示**：

```text
无法连接 GitHub（网络问题）。请检查网络/代理后重试。
```

- 先确认浏览器/`git ls-remote` 能否访问 GitHub：
  ```powershell
  git ls-remote https://github.com/<you>/dsh-sync.git
  ```
- 需要代理时，让 Git 自己走代理（插件子进程继承当前进程环境，但不保证继承 Desktop 的代理设置）：
  ```powershell
  # 全局配置（写入用户 git 配置）
  git config --global http.proxy http://127.0.0.1:7890
  git config --global https.proxy http://127.0.0.1:7890

  # 或只对本次会话生效
  $env:HTTPS_PROXY = "http://127.0.0.1:7890"
  $env:HTTP_PROXY  = "http://127.0.0.1:7890"
  ```
- 取消代理：
  ```powershell
  git config --global --unset http.proxy
  git config --global --unset https.proxy
  ```
- 大仓库首次同步可能因为超时失败（单条 git 命令默认 180 秒）：
  ```json
  "git": { "timeoutMs": 600000 }
  ```
  或先手工在 `$dshHome\github-sync\repo` 里 `git fetch` 预热。

---

## 4. 找不到 git / git 命令失败

**典型提示**：

```text
找不到可用的 git。请安装 Git（https://git-scm.com/），或在 $DSH_HOME/github-sync.json 的 git.path 中填写 git 可执行文件路径。
```

- 安装 [Git for Windows](https://git-scm.com/download/win)，确保 `git --version` 可用。
- 若 DSH 是从图形界面启动、PATH 里没有 Git，可在配置里写绝对路径：
  ```json
  "git": { "path": "C:\\Program Files\\Git\\cmd\\git.exe" }
  ```
- 单条 git 命令超时：调大 `git.timeoutMs`。
- 查看具体失败命令：错误信息里包含 `git ...` 和 stderr 末尾几行；也可以用 CLI 复现，日志同样会脱敏 token。

---

## 5. 仓库 / 分支 / 配置错误

| 现象 / 提示 | 原因 | 处理 |
|---|---|---|
| `尚未配置同步仓库` | `repo` 为空 | 编辑 `github-sync.json`，或 `/sync init <url>` |
| `仓库地址看起来不合法` | 用了 `owner/name` 或错误协议 | 改成 `https://...` / `git@...` / `ssh://...` |
| 首次同步后远端多了一个分支 | `branch` 与远端默认分支不一致 | 让 `branch` 等于远端默认分支，或把该分支设为默认 |
| 空仓库首次同步 | 已支持：fetch 空仓库不报错，首次 push 自动创建分支 | 正常等待完成即可 |
| `无法读取配置文件 ...` | JSON 语法错误 | 用编辑器校验 JSON；路径见错误信息 |
| `推送失败：远端分支在多次重试后仍被其他设备更新` | 两台设备同时推送 | 等另一台同步完再试；错开自动同步时间；见第 10 节 |
| `pathMappings must be an array...` | 映射结构不对 | 用 `[{"from":"...","to":"..."}]` 或对象写法 |
| 设备名显示成 `device`/奇怪字符 | `deviceName` 被清理/为空 | 显式设置一个 ASCII 名称，如 `workstation-a` |

---

## 6. 同步成功但侧栏没有工作区 / 会话

这是最常见的问题，**先重启 DSH Desktop**。

原因：DSH 在启动时读取 `storages/workspace.json` 并扫描 `sessions/`；运行中的进程不会因为外部文件变化而重新加载。插件同步完成后，需要完全退出并重启 DSH 才能在侧栏看到导入的工作区与会话。

重启后仍不显示时，按顺序检查：

1. **本机文件是否存在**
   ```powershell
   Get-ChildItem "$dshHome\sessions" -Directory | Select-Object Name
   Get-Content "$dshHome\storages\workspace.json" -Raw
   ```
   看会话目录是否按本机路径生成了 `--D-wwa--` 一类目录；`workspace.json` 里是否有对应记录、`path` 是否为本机真实路径、`sessionIds` 是否包含该会话。
2. **路径是否与 `realpath` 一致**
   - 工作区路径必须是已存在的目录；
   - Windows 大小写、短路径（8.3）、junction、`\\?\` 前缀都可能导致不一致；
   - 不要用 junction 代替 `pathMappings`。
3. **是否在 DSH 运行期间被覆盖**
   导入后、重启前，如果你在 UI 里改动过工作区，DSH 可能用内存状态覆盖刚导入的 `workspace.json`。重新同步一次，然后立即重启。
4. **看本次同步是否有告警**
   重新执行 `/sync sync`（或 CLI `sync`），读结果里的“提示/警告”；常见的有：
   - `workspace.json 合并后未通过 DSH 不变量校验，已保留本机注册表不写入：...`
   - `路径映射需要 rewriteSessionPaths=true ...已跳过该会话`
   - `会话文件正被占用，稍后重试：...`
5. **检查 DSH 日志**中是否有 workspace/session 相关 warn（如 `canonical cwd ... differs from workspace path ...`）。

如果 `workspace.json` 已损坏且无法合并，可以**完全退出 DSH**，备份后删除 `$dshHome\storages\workspace.json`，让 DSH 在下次启动时按会话 header 的 `cwd` 自动 bootstrap 工作区（代价：工作区顺序、置顶、归档信息可能丢失）。

---

## 7. 会话打不开 / 路径映射错误

### 7.1 症状

- 打开会话提示损坏（corrupt）或会话从列表消失；
- 会话出现在错误的项目分组下；
- 模型历史里仍显示旧设备路径；
- 工作区存在但会话不归入其中。

### 7.2 原因

- 首次同步前没有在 B 上配置 `pathMappings`，导致会话 header/目录名仍指向 A 的路径；
- 配置了映射但 `rewriteSessionPaths=false`，插件跳过了需要重写的会话（同步结果会告警）；
- 映射 `to` 路径不存在、不是目录，或实际 `realpath` 与写入值不一致（junction/大小写/短路径）；
- 手工改过 `workspace.json`/会话文件，破坏了 DSH 的路径身份校验。

### 7.3 修复

1. 完全退出 DSH Desktop。
2. 修正 B 的 `github-sync.json`：
   ```json
   "pathMappings": [
     { "from": "E:\\my-workspace", "to": "D:\\wwa" }
   ],
   "rewriteSessionPaths": true,
   "createMissingWorkspaceDirs": true
   ```
   确认 `D:\wwa` 存在且是普通目录（不要用 junction）。
3. 从备份回滚被改坏的文件（见第 8 节），或删除本机导入错误的工作区/会话目录后重新同步。
4. 重新 `/sync sync`，完全重启 DSH。

### 7.4 验证路径

```powershell
# 本机会话目录（应体现本机路径，如 --D-wwa--）
Get-ChildItem "$dshHome\sessions" -Directory | Select-Object Name

# 工作区注册表（path 应为真实路径、sessionIds 应含目标会话）
Get-Content "$dshHome\storages\workspace.json" -Raw
```

会话文件本身是 zstd 容器，不能直接用记事本检查；如果需要看内容，使用插件代码里的 `lib/sessions.js`（`readSessionHeaderBytes`、`scanZstdFrames`）或你在项目中已有的会话检查脚本。

---

## 8. 回滚与数据恢复

### 8.1 通用原则

- **先完全退出 DSH Desktop**，避免它在内存中重写 `workspace.json` / patch 文件。
- 先备份当前状态，再恢复旧文件。
- 先恢复单个文件/目录，不要一键清空整个 home。

### 8.2 从备份恢复

> 首次同步（本机还没有同步状态）时，插件会先把远端版本导入本机：`workspace.json` 做语义合并（本机工作区保留、远端工作区/会话并入），`cordis.patch.yml` 按行 id 合并（双方独有行都保留，同 id 行按 `onConflict`，默认保留本机）；其它不透明设置文件若本机已有数据，默认保留本机并把远端版本存为冲突副本（`prefer-remote` 会先备份本机再采用远端）；如果本机是全新 DSH home（没有会话、没有工作区、设置基本为空），则不透明设置以远端为准，覆盖前自动备份。若你希望保留本机版本，请在同步前先备份，或先确认以哪边为准。

```powershell
Get-ChildItem "$dshHome\github-sync\backups" | Sort-Object LastWriteTime -Descending | Select-Object -First 10
```

每个备份目录下的结构与 `$DSH_HOME` 相同，例如：

```text
github-sync\backups\2026-10-22_06-30-00-000\storages\workspace.json
github-sync\backups\2026-10-22_06-30-00-000\sessions\--D-wwa--\session-xxx\session.v4.jsonl.zstd
```

恢复示例：

```powershell
$stamp = "2026-10-22_06-30-00-000"
Copy-Item "$dshHome\github-sync\backups\$stamp\storages\workspace.json" `
          "$dshHome\storages\workspace.json" -Force
```

恢复后重新打开 DSH 验证。

### 8.3 冲突副本

- 本机导入冲突：`$dshHome\github-sync\conflicts\<时间戳>\...`（远端版本）。
- 仓库合并冲突：`$dshHome\github-sync\repo\.dsh-sync\conflicts\<device>\<时间戳>\...`（随提交推送到远端，也可在 GitHub 网页查看）。

```powershell
Get-ChildItem "$dshHome\github-sync\conflicts" -Recurse -File | Select-Object FullName, Length, LastWriteTime
git -C "$dshHome\github-sync\repo" log --oneline -- .dsh-sync
```

确认要采用冲突副本时：关闭 DSH，把它复制回对应位置（保持相对路径），重启后再同步。会话文件是 zstd 二进制，复制后仍需保证目录名与 header 路径一致；不确定时先保留副本，不要覆盖唯一可用的会话。

### 8.4 回滚仓库历史

```powershell
git -C "$dshHome\github-sync\repo" log --oneline -20
git -C "$dshHome\github-sync\repo" revert <bad-commit>
```

`revert` 会生成新提交，插件下次同步会正常推送。**不要**随意 `reset --hard` 后强推：其他设备会在下一次同步时把旧内容合并回来，反而更乱。

### 8.5 状态文件

`$dshHome\github-sync\state.json` 记录本机“上次同步后各仓库路径的哈希/本机路径”。**不建议随意删除**：删除后 `state.managed` 为空，下一次同步会被当作**首次同步**——会先把远端导入本机；如果本机已有会话/工作区，仍保留本机同名文件、把远端版本存为冲突副本，但会产生较多副本与告警。若确实要重置，先备份该文件。

---

## 9. 冲突

### 9.1 看到冲突提示

同步结果里出现：

```text
冲突：N 个文件发生冲突，已按 onConflict=<policy> 处理；另一方版本/本机备份见仓库 .dsh-sync/conflicts/ 与 $DSH_HOME/github-sync/（backups/、conflicts/）
```

这是**预期行为**：默认策略下插件保留本机版本，不覆盖你的数据；对方版本保存在冲突副本里。

### 9.2 处理步骤

1. 找到冲突副本（见 8.3），确认对方版本是否包含你需要的内容。
2. 如需采用对方版本，关闭 DSH，把副本复制回对应位置；或直接编辑/重命名工作区后重新同步。
3. 处理后删除不再需要的冲突副本目录（插件不会自动清理）。
4. 如果希望远端总是赢，可临时把 `onConflict` 设为 `"prefer-remote"`；如果希望严格人工处理，设为 `"fail"`（仅真正冲突时报错，适合审计场景）。

### 9.3 同一会话分叉

同一会话在两台设备同时继续会产生两条追加历史，插件不会自动合并。冲突副本里保留的是其中一方；请：

- 比较两份会话文件的大小/时间，保留内容更完整的一份；
- 或接受分叉，手工整理需要的对话内容；
- 之后养成“切换设备前先 `/sync sync`”的习惯。

---

## 10. 多设备同时同步 / push 被拒 / 忙

| 现象 | 说明 | 处理 |
|---|---|---|
| `另一个同步任务正在进行中，本次请求已跳过` | 同一进程内自动同步与手动同步重叠 | 等当前同步结束再试；无需处理 |
| `推送失败：远端分支在多次重试后仍被其他设备更新` | 两台设备几乎同时推送，重试 3 轮仍未成功 | 稍后重试；错开自动同步时间；切换设备前手动同步 |
| 同步结果里有 `拉取远端更改` | 正常：本次合并了另一台设备的提交 | 无需处理 |
| 两台设备频繁冲突 | 自动间隔太接近或同时改同一文件 | 给设备设置不同自动间隔（或一台关闭自动同步）；避免同时编辑同一工作区/会话 |
| 设备名相同 | 冲突副本目录/提交信息混在一起 | 给每台设备设置不同 `deviceName` |

---

## 11. 会话文件被占用

**提示**：

```text
会话文件正被占用，稍后重试：sessions/--D-wwa--/session-xxx/session.v4.jsonl.zstd
```

原因：DSH 正在写该会话文件，Windows 未允许覆盖。本次同步会跳过该文件，其它文件照常处理；下一次同步会自动重试。也可以：

- 等当前对话/工具执行结束后手动 `/sync sync`；
- 或完全退出 DSH 后用 CLI `node bin\dsh-github-sync.mjs sync` 同步。

---

## 12. `/sync` 命令不存在 / 插件没加载

1. 确认插件已安装并在插件页启用：
   - 侧栏 **插件** → 搜索 `github-sync` / `dsh-plugin-github-sync`；
2. 完全退出并重启 DSH Desktop；
3. 查看 DSH 启动日志中是否有 `github-sync` 相关错误（启动失败诊断目录通常为 `$dshHome\logs\`，运行日志在 Desktop 的日志目录）；
4. 用 `dsh --profile desktop --dump-config` 确认插件行是否存在（注意：该命令可能初始化/改写 profile，执行前备份；详见 DSH 文档）；
5. 重新安装：
   ```powershell
   $dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
     Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
   & $dsh plugin --profile desktop add link:<插件目录>
   ```

---

## 13. 仓库膨胀 / Git 历史太大

原因：会话是 zstd 二进制，DSH 每次追加都会重写整个文件，Git 每次提交一个新版本；长期使用仓库会快速变大。

建议：

- 保持 `limits.maxFileMB` / `limits.maxTotalMB` 合理，避免把超大附件/会话推上去；
- 定期换新仓库：
  1. 新建一个空的私有仓库；
  2. 在**所有设备**上更新 `repo`（重要：漏改的设备会继续往旧仓库推）；
  3. 第一台设备先同步一次（推送完整快照）；
  4. 其它设备同步（会先采用远端历史再合并本机数据）；
  5. 旧仓库归档。
- 需要保留历史但压缩空间时，自行用 `git gc` 或历史重写工具处理快照仓库；插件不管理 Git 历史。

---

## 14. 升级 / 卸载

### 升级

```powershell
$dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
& $dsh plugin --profile desktop add link:<插件目录>
```

完全重启 DSH；先 `/sync status` 再 `/sync sync` 验证。`link:` 安装修改代码后重启即可；`package.json` 的 `main`/`exports` 变更需要重新安装。

### 卸载

```powershell
& $dsh plugin --profile desktop remove dsh-plugin-github-sync
```

重启 DSH。卸载**不会**删除：

- `$dshHome\github-sync.json`
- `$dshHome\github-sync\`（快照仓库、状态、备份、冲突副本）
- GitHub 上的同步数据

彻底清理需完全退出 DSH 后手动删除上述内容（先确认已备份）。

---

## 15. 长路径 / DSH 版本差异

### Windows 长路径

快照仓库已设置 `core.longpaths=true`，但系统级别还需启用长路径支持（组策略/注册表 `LongPathsEnabled=1`），否则深层路径仍可能失败。建议：

- 保持默认仓库位置（`%USERPROFILE%\.dsh\github-sync\repo`）；
- 避免非常深的工作区目录（会体现在会话项目目录名和文件路径里）；
- 遇到 `Filename too long` / `path too long` 时，先启用系统长路径，再重试同步。

### DSH 版本不同

- 会话格式（当前 v4）、workspace 域版本（当前 v2）会随 DSH 升级 bump；
- 插件按字节复制会话、按结构合并 workspace，**不校验版本**；
- 两台设备尽量保持相同 DSH 版本；升级前先同步并保留备份，升级后先在一台设备验证会话可打开，再让另一台同步。

---

## 16. 速查表

| 想看什么 | 命令/位置 |
|---|---|
| 同步状态 | `/sync status`；`node bin\dsh-github-sync.mjs status` |
| 自检 | `node bin\dsh-github-sync.mjs doctor` |
| 相关路径 | `node bin\dsh-github-sync.mjs paths` |
| 配置文件 | `$dshHome\github-sync.json` |
| 备份 | `$dshHome\github-sync\backups\` |
| 本机冲突副本 | `$dshHome\github-sync\conflicts\` |
| 仓库冲突副本/历史 | `$dshHome\github-sync\repo`（`git log`、`.dsh-sync/`） |
| 状态文件 | `$dshHome\github-sync\state.json` |
| 强制重试一次 | `/sync sync`（或关闭 DSH 后 CLI `sync`） |
| 试运行看变更量 | `/sync sync` 前用 CLI `sync --dry-run` |
