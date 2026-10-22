# 安装与首次配置（v0.2.0）

本文覆盖：准备账号与工具 → 创建 PAT → 设置环境变量 → 三种安装方式 → 重启验证 → 首次配置 → 升级/卸载。v0.2.0 默认开启近实时同步；**首次安装或升级插件后重启一次 DSH**，之后运行期的工作区/会话热应用无需再重启。

> 适用于 DSH `0.2.1-rc.2` Desktop（Windows / PowerShell）。插件目录：`<插件目录>`。

---

## 1. 准备清单

| 项目 | 要求 | 检查 |
|---|---|---|
| Git | Git for Windows（插件通过 `git` CLI 执行 fetch/merge/push） | `git --version` |
| GitHub 仓库 | **私有**；可以是空仓库，也可以已有分支 | 浏览器创建 |
| PAT 或其它凭据 | 对目标仓库有 Contents 读写权限的 Fine-grained PAT（或 classic `repo` scope），或已配置 GCM/SSH | 见第 2 节 |
| Node.js（仅 CLI） | `^22.19.0 || >=24.0.0` | `node --version` |
| DSH | Desktop `0.2.1-rc.2`；profile 默认 `desktop` | `dsh --version` |

关于空仓库：插件支持对空仓库做首次同步——fetch 空仓库不会失败，插件会在导出提交后自动创建并推送配置的 `branch`（默认 `main`）。如果仓库已有分支，请让 `branch` 与远端默认分支一致，否则会在远端新建一个分支。

---

## 2. 创建并设置 GitHub PAT

### 2.1 Fine-grained token（推荐）

1. 打开 GitHub，右上头像 → **Settings**。
2. 左侧最下方 **Developer settings** → **Personal access tokens** → **Fine-grained tokens**。
3. **Generate new token**：
   - **Token name**：例如 `dsh-sync-workstation-a`；
   - **Expiration**：按需（建议 90 天，到期前轮换）；
   - **Resource owner**：你的账号；
   - **Repository access**：**Only select repositories** → 只勾选同步用的私有仓库（如 `dsh-sync`）。
4. **Permissions** → **Repository permissions**：
   - **Contents**：**Read and write**（必需）；
   - **Metadata**：会自动勾选只读。
5. 生成并复制 token（只显示一次）。

### 2.2 Classic token（备选）

GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)** → 勾选 `repo`（私有仓库完整读写）→ 生成并复制。

> 最小权限原则：只给需要同步的那一个私有仓库；不要给 organization 全域权限。

---

## 3. 设置 `DSH_SYNC_GITHUB_TOKEN`

插件按以下顺序读取 token：`git.tokenEnv`（默认 `DSH_SYNC_GITHUB_TOKEN`）→ `git.fallbackTokenEnvs`（默认 `GH_TOKEN`、`GITHUB_TOKEN`）。token 只从环境变量读取，不会写入配置文件。

### 3.1 临时（只影响当前窗口）

```powershell
$env:DSH_SYNC_GITHUB_TOKEN = "github_pat_xxxxxxxx"
```

适合：在当前窗口运行 CLI 做首次同步。**Desktop 的同步在 DSH 进程内执行，看不到其它窗口的临时变量**；要让 Desktop 使用 token，请用下面的永久设置并重启 DSH。

### 3.2 永久（当前用户，推荐给 Desktop）

```powershell
[Environment]::SetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'github_pat_xxxxxxxx', 'User')
```

或：

```powershell
setx DSH_SYNC_GITHUB_TOKEN "github_pat_xxxxxxxx"
```

两者都会写入用户环境变量；**已打开的进程不会自动继承**，必须完全退出并重启 DSH Desktop。

验证：

```powershell
[Environment]::GetEnvironmentVariable('DSH_SYNC_GITHUB_TOKEN', 'User')
```

只检查“是否存在/是否非空”即可，不要把完整 token 贴到聊天或截图里。

### 3.3 备选：Git Credential Manager

Git for Windows 自带 GCM。无 token 时插件会回退到本机 git credential：

```powershell
git credential-manager github login
```

按浏览器提示登录后，HTTPS 地址即可读写私有仓库。

### 3.4 备选：SSH

仓库地址改用 `git@github.com:<you>/dsh-sync.git`：

```powershell
ssh-keygen -t ed25519 -C "dsh-sync"        # 若还没有 key
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"   # 粘贴到 GitHub → Settings → SSH and GPG keys
ssh -T git@github.com                       # 验证，出现 "successfully authenticated" 即可
```

注意：

- 插件对 `git@` / `ssh://` 地址不使用 token，完全依赖 SSH 配置；
- `git.batchMode=true`（默认）会以 `ssh -o BatchMode=yes` 运行，私钥不能依赖交互式口令，请使用 ssh-agent；
- SSH 方式下，`DSH_SYNC_GITHUB_TOKEN` 可以不设置。

---

## 4. 安装插件

> 下文以插件目录 `<插件目录>` 为例；在其他机器上请替换为你实际的插件路径（或使用 Git 仓库地址安装）。

安装前确认插件目录存在：

```powershell
Test-Path <插件目录>\package.json   # 应为 True
```

### 4.1 方式 A：桌面「插件」页（图形界面）

1. 打开 DSH Desktop → 侧栏 **插件**。
2. 点击 **添加插件** / **安装第三方插件**。
3. 输入本地绝对路径：
   ```text
   <插件目录>
   ```
   或输入插件的 Git 仓库地址（私有仓库需要先配置可用的 Git 凭据）。
4. 确认安装。插件在 `package.json` 中声明了 `dsh.bundle.patch`，因此会作为 bundle 安装，并自动把行 id 为 `github-sync` 的插件行加入 profile 并启用。
5. **完全退出并重启 DSH Desktop**。

> 该入口只接受声明了 `dsh.bundle.patch` 的 bundle；普通依赖安装后不会自动插入插件行。

### 4.2 方式 B：Desktop 自带 CLI（`dsh` 垫片）

Desktop 生成的 `dsh.cmd` 默认 profile 就是 `desktop`，并且允许管理 desktop profile：

```powershell
# 找到最新的垫片
$dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
$dsh

# 安装（link: 为开发链接；file: 会复制安装）
& $dsh plugin --profile desktop add link:<插件目录>
```

如果 `dsh` 已在 PATH 上：

```powershell
dsh plugin --profile desktop add link:<插件目录>
```

关键注意点：

- **npm 版 `dsh` 会拒绝 `--profile desktop`**；管理 desktop profile 必须用 Desktop 垫片或桌面插件页。
- `link:` 不会复制代码，适合本机开发（改代码后重启 DSH 生效）；`file:` 会复制一份，适合固定版本。
- 如果路径包含空格，给整个 `link:...` 参数加引号。

### 4.3 方式 C：安装脚本（v0.2.0 新增）

插件自带 `scripts/install.mjs`，自动查找最新的 Desktop `dsh.cmd` 并执行 `plugin --profile <p> add link:<本包>`：

```powershell
cd <插件目录>
node scripts\install.mjs                                # 默认 desktop profile
node scripts\install.mjs --profile desktop --print      # 只打印命令，不执行
```

也可以使用 package script：

```powershell
npm run install:profile
```

脚本适用于本机开发/升级；找不到 Desktop 垫片时会提示改用桌面插件页。

### 4.4 安装后验证

1. 完全退出 DSH Desktop（托盘图标 → 退出，确认进程已结束），再重新启动。**安装/升级插件后必须重启一次**；之后运行期同步无需重启。
2. 在对话里输入 `/`，应能看到 `sync` 命令。
3. 执行：

   ```text
   /sync help
   ```

   应返回 `status | sync | init | help` 的用法。
4. 模型侧 `github_sync` 工具也应可用（可让它执行 `action="status"`）。
5. 配置好仓库后，`/sync status` 应显示“实时同步：开启（活跃 3s / 空闲 15s 轮询；写后约 2s 推送）”以及工作区设备标签状态。
6. 若命令不存在：检查插件页是否已启用、是否重启过、DSH 日志中是否有 `github-sync` 的加载错误。

---

## 5. 首次配置

配置是**每台设备各自维护**的，不同步。文件位置：

```text
%USERPROFILE%\.dsh\github-sync.json
```

若设置了 `DSH_HOME` 环境变量，则是 `$env:DSH_HOME\github-sync.json`。

### 5.1 方式一：编辑配置文件

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
notepad "$dshHome\github-sync.json"
```

最小可用内容（其它字段都有默认值）：

```json
{
  "repo": "https://github.com/<you>/dsh-sync.git",
  "branch": "main",
  "deviceName": "workstation-a"
}
```

完整示例与全部字段说明见 [configuration.md](configuration.md)。

保存后在对话里执行：

```text
/sync sync
```

### 5.2 方式二：`/sync init`（一条命令完成配置 + 首次同步）

```text
/sync init https://github.com/<you>/dsh-sync.git
```

它会保留已有配置字段，写入 `repo`（以及 `branch`、`deviceName`、`profileName` 的当前值），然后立即执行首次同步。

### 5.3 方式三：CLI（DSH 未启动或脚本化）

```powershell
cd <插件目录>
$env:DSH_SYNC_GITHUB_TOKEN = "github_pat_xxxxxxxx"
node bin\dsh-github-sync.mjs init --repo https://github.com/<you>/dsh-sync.git --device workstation-a
```

CLI 与插件共享同一份配置和状态；首次同步完成后再启动 DSH 也可以。

### 5.4 首次同步成功的标志

- `/sync status` 显示仓库地址、设备名、实时同步模式（活跃/空闲间隔）、最近同步时间；
- 本地出现 `%USERPROFILE%\.dsh\github-sync\repo`；
- GitHub 仓库里出现 `home/`、`profiles/desktop/` 与 `meta/workspaces.json`，以及一次 `dsh-sync[<device>]: export ...` 提交；
- 首次同步可能较慢（要上传会话/附件），受 `limits.maxTotalMB`（默认 4 GB）限制；
- 第二台及以后的设备首次同步时，插件会先导入远端内容：`workspace.json` 语义合并，patch 按行合并，远端会话导入；不透明设置按 `onConflict`（全新 home 远端优先，已有本地数据默认保留本机 + 远端副本）；
- 首次同步后需**重启一次** DSH；之后运行期改动会在数秒内热应用，不需要再重启。

---

## 6. 多设备安装提示

- 每台设备都要安装插件、设置自己的 token/凭据，并配置**同一个** `repo`。
- `deviceName` 每台设备不同（默认取主机名，重名时请手动指定）；该名称会出现在提交信息、冲突副本路径和工作区标题的 ` · device` 后缀中。
- 路径不同时，在路径不同的设备上配置 `pathMappings`（详见 [configuration.md](configuration.md) 与主 README 的多设备章节）。
- 每台设备首次安装/升级后需重启一次 DSH；之后 A/B 两端同时运行时，工作区与会话会在数秒内实时出现，不需要再重启。
- 默认 `realtime` 已开启；如果需要省流量/只读设备，可按 [configuration.md](configuration.md) 的 `realtime` 一节调整或关闭。

---

## 7. 升级

- `link:` 安装：更新插件源码 → 完全重启 DSH Desktop（`package.json` 的 `main`/`exports` 变更需要重新安装一次）。
- `file:` 或 Git 地址安装：重新执行安装命令，或先用 Desktop UI 卸载后再装：
  ```powershell
  & $dsh plugin --profile desktop add link:<插件目录>
  ```
- **v0.2.0 升级后要重启一次 DSH**，让新的近实时轮询/热应用接线生效；数据仓库格式向后兼容（`meta/workspaces.json` 会在第一次同步时生成）。
- 升级后先执行 `/sync status`（确认“实时同步：开启”），再执行一次 `/sync sync` 验证。

---

## 8. 卸载

```powershell
$dsh = Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
& $dsh plugin --profile desktop remove dsh-plugin-github-sync
```

然后重启 DSH。卸载只移除插件，不会删除：

- `$DSH_HOME/github-sync.json`（配置）
- `$DSH_HOME/github-sync/`（快照仓库、状态、备份、冲突副本）
- GitHub 仓库中的同步数据

如需彻底清理，先完全退出 DSH，再手动删除上述目录/文件（删除前确认已备份）。

---

## 9. 安装/配置常见问题

| 问题 | 处理 |
|---|---|
| `/sync` 命令不存在 | 确认插件页已启用、已完全重启 DSH；查看 DSH 日志中 `github-sync` 相关错误 |
| `dsh` 命令找不到 | 用 `Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd` 定位垫片；或改用插件页安装 |
| npm 版 dsh 报 “desktop profile 不能由 CLI 管理” | 改用 Desktop 垫片或插件页 |
| 提示没有仓库/配置 | 编辑 `github-sync.json` 或执行 `/sync init <url>` |
| token 已设置但 DSH 说认证失败 | 用户环境变量对已启动进程不生效：完全退出并重启 DSH Desktop |
| 首次同步失败 | 先用 CLI `node bin\dsh-github-sync.mjs doctor` 检查 git/token；再 `sync` 看具体错误；参见 [troubleshooting.md](troubleshooting.md) |
| 实时同步没生效 | 确认已安装 v0.2.0 并**重启过** DSH；`/sync status` 应显示“实时同步：开启”；检查 `realtime.enabled` 是否被设为 `false` |
| 新会话/工作区不出现 | 等 3–6 秒；确认两端网络/认证正常；`/sync status` 看最近同步与 pending；旧版本需升级并重启 |
| 已打开的会话不刷新 | 预期行为：live 会话不会被覆盖，更新在 pending 队列；关闭重开或重启 DSH 后可见 |

更多排查看 [troubleshooting.md](troubleshooting.md)。
