/**
 * Thin, dependency-free wrapper around the `git` CLI used by the sync engine.
 *
 * All operations are non-interactive: `GIT_TERMINAL_PROMPT=0` and a batch-mode
 * SSH command prevent a headless sync from blocking on a credential prompt.
 * GitHub HTTPS authentication can be supplied through an environment variable
 * (see `config.git.tokenEnv`); the token is passed as a transient
 * `http.extraHeader` argument and never written to the repository or its
 * configuration.
 *
 * @module dsh-plugin-github-sync/git
 */

import { execFile, spawn } from 'node:child_process'
import { access, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { readToken, redactRemote } from './config.js'

const execFileAsync = promisify(execFile)

/** Error raised when a git invocation fails. */
export class GitError extends Error {
  /**
   * @param {string} message human-readable message.
   * @param {{ args?: string[], code?: number | string | null, stdout?: string, stderr?: string, cwd?: string }} [details] failure details.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'GitError'
    this.args = details.args ?? []
    this.code = details.code ?? null
    this.stdout = details.stdout ?? ''
    this.stderr = details.stderr ?? ''
    this.cwd = details.cwd ?? ''
  }
}

/**
 * Locate a usable git executable.
 *
 * @param {object} config normalized configuration.
 * @returns {Promise<string>} executable name or absolute path.
 */
export async function resolveGitPath(config) {
  const candidates = [config.git?.path, 'git']
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Git\\cmd\\git.exe')
    candidates.push('C:\\Program Files (x86)\\Git\\cmd\\git.exe')
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (candidate !== 'git' && !(await pathExists(candidate))) continue
    try {
      const result = await runGit({ cwd: process.cwd(), gitPath: candidate, args: ['--version'], allowFailure: true })
      if (result.code === 0) return candidate
    } catch {
      // try the next candidate
    }
  }
  throw new Error('找不到可用的 git。请安装 Git（https://git-scm.com/），或在 $DSH_HOME/github-sync.json 的 git.path 中填写 git 可执行文件路径。')
}

/**
 * Run one git command.
 *
 * @param {object} options invocation options.
 * @param {string} options.cwd working directory (usually the snapshot repo).
 * @param {string} options.gitPath git executable.
 * @param {string[]} options.args arguments after the executable.
 * @param {object} [options.config] normalized plugin configuration (for auth/timeout).
 * @param {boolean} [options.allowFailure] return non-zero exits instead of throwing.
 * @param {boolean} [options.binary] return raw buffers instead of UTF-8 text.
 * @param {NodeJS.ProcessEnv} [options.env] extra environment values.
 * @returns {Promise<{ code: number, stdout: string | Buffer, stderr: string }>} command result.
 */
export async function runGit(options) {
  const { cwd, gitPath, args, config, allowFailure = false, binary = false, env = {} } = options
  const remoteUrl = config?.repo ?? ''
  const globalArgs = buildGlobalArgs(config, remoteUrl)
  const fullArgs = [...globalArgs, ...args]
  const childEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GCM_INTERACTIVE: 'never',
    ...env,
  }
  if (config?.git?.batchMode !== false && childEnv.GIT_SSH_COMMAND === undefined) {
    childEnv.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  try {
    const result = await execFileAsync(gitPath, fullArgs, {
      cwd,
      env: childEnv,
      windowsHide: true,
      timeout: config?.git?.timeoutMs ?? 180000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8',
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (isSpawnPermissionError(error)) {
      // Some sandboxes forbid piped child stdio. Redirect to temporary files
      // instead, which keeps the same observable contract.
      return runGitWithFileStdio({ gitPath, args: fullArgs, cwd, env: childEnv, timeoutMs: config?.git?.timeoutMs ?? 180000, binary })
    }
    const code = typeof error.code === 'number' ? error.code : (error.code ?? null)
    const stdout = normalizeOutput(error.stdout)
    const stderr = normalizeOutput(error.stderr)
    if (allowFailure) return { code: code ?? 1, stdout, stderr }
    throw new GitError(explainGitFailure(args, code, stderr, remoteUrl), {
      args: sanitizeArgs(fullArgs, config),
      code,
      stdout,
      stderr,
      cwd,
    })
  }
}

/**
 * Whether an exec failure is a sandbox denial of piped stdio.
 *
 * @param {unknown} error candidate.
 * @returns {boolean} true for EPERM spawn failures.
 */
function isSpawnPermissionError(error) {
  return Boolean(error && typeof error === 'object' && (error.code === 'EPERM' || error.code === 'EACCES'))
}

/**
 * Run git with stdout/stderr redirected to temporary files.
 *
 * This is the fallback used when a sandbox denies piped stdio (the harness
 * documents that `stdio: 'inherit'|'ignore'` and file descriptors work while
 * pipes do not). It returns the same shape as {@link runGit}.
 *
 * @param {object} options invocation options.
 * @param {string} options.gitPath git executable.
 * @param {string[]} options.args arguments.
 * @param {string} options.cwd working directory.
 * @param {NodeJS.ProcessEnv} options.env environment.
 * @param {number} options.timeoutMs timeout.
 * @param {boolean} options.binary return raw buffers.
 * @returns {Promise<{ code: number, stdout: string | Buffer, stderr: string }>} command result.
 */
async function runGitWithFileStdio(options) {
  const { gitPath, args, cwd, env, timeoutMs, binary } = options
  const token = randomUUID()
  const stdoutFile = path.join(tmpdir(), `dsh-git-${token}.out`)
  const stderrFile = path.join(tmpdir(), `dsh-git-${token}.err`)
  const stdoutHandle = await open(stdoutFile, 'w')
  const stderrHandle = await open(stderrFile, 'w')
  let timedOut = false
  let exitCode = 1
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(gitPath, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      timer.unref?.()
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        exitCode = typeof code === 'number' ? code : 1
        resolve(code)
      })
    })
  } finally {
    await stdoutHandle.close()
    await stderrHandle.close()
  }
  const stdoutBuffer = await readFile(stdoutFile).catch(() => Buffer.alloc(0))
  const stderrBuffer = await readFile(stderrFile).catch(() => Buffer.alloc(0))
  await unlink(stdoutFile).catch(() => {})
  await unlink(stderrFile).catch(() => {})
  return {
    code: timedOut ? 124 : exitCode,
    stdout: binary ? stdoutBuffer : stdoutBuffer.toString('utf8'),
    stderr: stderrBuffer.toString('utf8'),
  }
}

/**
 * Convert captured output to UTF-8 text.
 *
 * @param {unknown} value captured output.
 * @returns {string} text.
 */
function normalizeOutput(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

/**
 * Ensure the snapshot repository exists and is bound to the configured remote.
 *
 * @param {object} options setup options.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config normalized configuration.
 * @returns {Promise<{ created: boolean, remoteChanged: boolean }>} setup result.
 */
export async function ensureRepo(options) {
  const { repoDir, gitPath, config } = options
  await mkdir(repoDir, { recursive: true })
  const gitDirExists = await pathExists(`${repoDir}/.git`)
  let created = false
  if (!gitDirExists) {
    await runGit({ cwd: repoDir, gitPath, args: ['init', '-b', config.branch], config })
    created = true
  }
  await runGit({ cwd: repoDir, gitPath, args: ['config', 'core.autocrlf', 'false'], config })
  await runGit({ cwd: repoDir, gitPath, args: ['config', 'core.longpaths', 'true'], config })
  await runGit({ cwd: repoDir, gitPath, args: ['config', 'core.quotepath', 'false'], config })
  const attributesPath = `${repoDir}/.gitattributes`
  if (!(await pathExists(attributesPath))) {
    await writeFile(
      attributesPath,
      [
        '# Managed by dsh-plugin-github-sync: never rewrite line endings or diff binary',
        '# session logs. Snapshot fidelity matters more than textual diffs.',
        '* -text',
        '*.json text eol=lf',
        '*.jsonl text eol=lf',
        '*.yml text eol=lf',
        '*.yaml text eol=lf',
        '*.md text eol=lf',
        '',
      ].join('\n'),
      'utf8',
    )
  }
  const remoteUrl = config.repo
  const current = await runGit({
    cwd: repoDir,
    gitPath,
    args: ['remote', 'get-url', config.remoteName],
    config,
    allowFailure: true,
  })
  let remoteChanged = false
  if (current.code !== 0 || current.stdout.trim().length === 0) {
    await runGit({ cwd: repoDir, gitPath, args: ['remote', 'add', config.remoteName, remoteUrl], config })
  } else if (current.stdout.trim() !== remoteUrl) {
    await runGit({ cwd: repoDir, gitPath, args: ['remote', 'set-url', config.remoteName, remoteUrl], config })
    remoteChanged = true
  }
  return { created, remoteChanged }
}

/**
 * Stage everything and create a commit when the working tree is dirty.
 *
 * @param {object} options commit options.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config normalized configuration.
 * @param {string} options.message commit message.
 * @returns {Promise<{ committed: boolean, changedFiles: number }>} commit result.
 */
export async function commitAll(options) {
  const { repoDir, gitPath, config, message } = options
  const status = await runGit({ cwd: repoDir, gitPath, args: ['status', '--porcelain', '-z'], config })
  if (status.stdout.length === 0) return { committed: false, changedFiles: 0 }
  const changedFiles = status.stdout.split('\0').filter(Boolean).length
  await runGit({ cwd: repoDir, gitPath, args: ['add', '--all'], config })
  await runGit({
    cwd: repoDir,
    gitPath,
    args: [
      '-c',
      `user.name=${config.git.authorName}`,
      '-c',
      `user.email=${config.git.authorEmail}`,
      'commit',
      '--no-verify',
      '-m',
      message,
    ],
    config,
  })
  return { committed: true, changedFiles }
}

/**
 * Fetch the configured remote branch.
 *
 * @param {object} options fetch options.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config normalized configuration.
 * @returns {Promise<{ remoteExists: boolean, ahead: number, behind: number }>} fetch information.
 */
export async function fetchRemote(options) {
  const { repoDir, gitPath, config } = options
  await runGit({
    cwd: repoDir,
    gitPath,
    args: ['fetch', '--prune', '--no-tags', config.remoteName],
    config,
  })
  const remoteRef = `refs/remotes/${config.remoteName}/${config.branch}`
  const verify = await runGit({ cwd: repoDir, gitPath, args: ['rev-parse', '--verify', '--quiet', remoteRef], config, allowFailure: true })
  if (verify.code !== 0) return { remoteExists: false, ahead: 0, behind: 0 }
  const counts = await runGit({
    cwd: repoDir,
    gitPath,
    args: ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`],
    config,
    allowFailure: true,
  })
  if (counts.code !== 0) return { remoteExists: true, ahead: 0, behind: 0 }
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0)
  return { remoteExists: true, ahead: ahead ?? 0, behind: behind ?? 0 }
}

/**
 * Merge the fetched remote branch into the current branch.
 *
 * @param {object} options merge options.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config normalized configuration.
 * @returns {Promise<{ merged: boolean, conflicts: string[], upToDate: boolean }>} merge result.
 */
export async function mergeRemote(options) {
  const { repoDir, gitPath, config } = options
  const remoteRef = `${config.remoteName}/${config.branch}`
  const remoteInHead = await runGit({
    cwd: repoDir,
    gitPath,
    args: ['merge-base', '--is-ancestor', remoteRef, 'HEAD'],
    config,
    allowFailure: true,
  })
  if (remoteInHead.code === 0) return { merged: false, conflicts: [], upToDate: true }
  const headInRemote = await runGit({
    cwd: repoDir,
    gitPath,
    args: ['merge-base', '--is-ancestor', 'HEAD', remoteRef],
    config,
    allowFailure: true,
  })
  if (headInRemote.code === 0) {
    // Local branch is behind: fast-forward without creating a merge commit.
    await runGit({ cwd: repoDir, gitPath, args: ['merge', '--ff-only', remoteRef], config })
    return { merged: true, conflicts: [], upToDate: false, fastForward: true }
  }
  const result = await runGit({
    cwd: repoDir,
    gitPath,
    args: [
      '-c',
      `user.name=${config.git.authorName}`,
      '-c',
      `user.email=${config.git.authorEmail}`,
      'merge',
      '--no-ff',
      '--allow-unrelated-histories',
      '--no-edit',
      remoteRef,
    ],
    config,
    allowFailure: true,
  })
  if (result.code === 0) return { merged: true, conflicts: [], upToDate: false }
  const conflicts = await listConflictedFiles({ repoDir, gitPath, config })
  if (conflicts.length === 0) {
    throw new GitError('合并远端分支失败', { stderr: result.stderr, stdout: result.stdout, args: result.args })
  }
  return { merged: false, conflicts, upToDate: false }
}

/**
 * List unmerged paths in the working tree.
 *
 * @param {object} options query options.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config normalized configuration.
 * @returns {Promise<string[]>} repository-relative unmerged paths.
 */
export async function listConflictedFiles(options) {
  const { repoDir, gitPath, config } = options
  const result = await runGit({
    cwd: repoDir,
    gitPath,
    args: ['diff', '--name-only', '--diff-filter=U', '-z'],
    config,
    allowFailure: true,
  })
  return result.stdout.split('\0').filter(Boolean)
}

/**
 * Check out one stage of a conflicted path.
 *
 * @param {object} options checkout options.
 * @param {string} options.repoDir working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config configuration.
 * @param {string} options.file repository-relative path.
 * @param {'ours' | 'theirs'} stage chosen stage.
 * @returns {Promise<void>} resolves when checked out.
 */
export async function checkoutConflictSide(options) {
  const { repoDir, gitPath, config, file, stage } = options
  await runGit({ cwd: repoDir, gitPath, args: ['checkout', `--${stage}`, '--', file], config })
  await runGit({ cwd: repoDir, gitPath, args: ['add', '--', file], config })
}

/**
 * Push the current HEAD to the configured branch.
 *
 * @param {object} options push options.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config normalized configuration.
 * @returns {Promise<{ pushed: boolean, upToDate: boolean }>} push result.
 */
export async function push(options) {
  const { repoDir, gitPath, config } = options
  const result = await runGit({
    cwd: repoDir,
    gitPath,
    args: ['push', config.remoteName, `HEAD:refs/heads/${config.branch}`],
    config,
    allowFailure: true,
  })
  if (result.code === 0) return { pushed: true, upToDate: false }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(result.stderr + result.stdout)) {
    return { pushed: false, upToDate: false }
  }
  throw new GitError(explainGitFailure(['push'], result.code, result.stderr, config.repo), {
    stderr: result.stderr,
    stdout: result.stdout,
  })
}

/**
 * Read the current commit hash of HEAD.
 *
 * @param {object} options query options.
 * @param {string} options.repoDir working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config configuration.
 * @returns {Promise<string | null>} commit hash, or null when no commit exists.
 */
export async function headCommit(options) {
  const { repoDir, gitPath, config } = options
  const result = await runGit({ cwd: repoDir, gitPath, args: ['rev-parse', 'HEAD'], config, allowFailure: true })
  return result.code === 0 ? result.stdout.trim() : null
}

/**
 * List tracked repository-relative files.
 *
 * @param {object} options query options.
 * @param {string} options.repoDir working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config configuration.
 * @param {string[]} [options.prefixes] repository-relative prefixes to restrict the listing.
 * @returns {Promise<string[]>} repository-relative paths using `/` separators.
 */
export async function listTrackedFiles(options) {
  const { repoDir, gitPath, config, prefixes } = options
  const args = ['ls-files', '-z']
  if (prefixes && prefixes.length > 0) args.push('--', ...prefixes)
  const result = await runGit({ cwd: repoDir, gitPath, args, config })
  return result.stdout.split('\0').filter(Boolean).map((value) => value.split('\\').join('/'))
}

/**
 * Whether the working tree has uncommitted changes.
 *
 * @param {object} options query options.
 * @param {string} options.repoDir working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config configuration.
 * @returns {Promise<boolean>} true when dirty.
 */
export async function isDirty(options) {
  const { repoDir, gitPath, config } = options
  const result = await runGit({ cwd: repoDir, gitPath, args: ['status', '--porcelain', '-z'], config })
  return result.stdout.length > 0
}

/**
 * Read the configured remote URL and redact credentials.
 *
 * @param {object} options query options.
 * @param {string} options.repoDir working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config configuration.
 * @returns {Promise<string>} display-safe URL.
 */
export async function remoteUrl(options) {
  const { repoDir, gitPath, config } = options
  const result = await runGit({
    cwd: repoDir,
    gitPath,
    args: ['remote', 'get-url', config.remoteName],
    config,
    allowFailure: true,
  })
  return result.code === 0 ? redactRemote(result.stdout.trim()) : redactRemote(config.repo)
}

/**
 * Build `git -c ...` authentication arguments.
 *
 * @param {object} [config] normalized configuration.
 * @param {string} [remoteUrlValue] remote URL.
 * @returns {string[]} leading arguments.
 */
export function buildGlobalArgs(config, remoteUrlValue) {
  if (!config) return []
  const args = []
  let token = null
  try {
    token = readToken(config)
  } catch {
    token = null
  }
  if (token && /^https?:\/\//i.test(remoteUrlValue)) {
    const basic = Buffer.from(`x-access-token:${token.token}`, 'utf8').toString('base64')
    args.push('-c', `http.extraHeader=AUTHORIZATION: basic ${basic}`)
  }
  return args
}

/**
 * Remove credentials from logged arguments.
 *
 * @param {string[]} args command arguments.
 * @param {object | undefined} config configuration.
 * @returns {string[]} sanitized arguments.
 */
export function sanitizeArgs(args, config) {
  const token = (() => {
    try {
      return config ? readToken(config) : null
    } catch {
      return null
    }
  })()
  if (!token) return args
  return args.map((arg) => (arg.includes(token.token) ? arg.replaceAll(token.token, '***') : arg))
}

/**
 * Produce a user-actionable explanation for a failed git command.
 *
 * @param {string[]} args failing arguments.
 * @param {number | string | null} code exit code or spawn error code.
 * @param {string} stderr captured stderr.
 * @param {string} remote configured remote URL.
 * @returns {string} explanation.
 */
export function explainGitFailure(args, code, stderr, remote) {
  const command = ['git', ...args].join(' ')
  const detail = stderr.trim().split(/\r?\n/).slice(-4).join('\n')
  if (/could not read Username|Authentication failed|terminal prompts disabled|invalid username or password/i.test(stderr)) {
    return [
      'Git 认证失败。请为这台设备配置 GitHub 凭据，任选其一：',
      '1) 设置环境变量 DSH_SYNC_GITHUB_TOKEN（或 GH_TOKEN / GITHUB_TOKEN）为具有该私有仓库读写权限的 Fine-grained PAT；',
      '2) 使用 Git Credential Manager 登录（git credential-manager github login）；',
      '3) 把远端换成 SSH 地址并配置好 ssh key。',
      `远端：${redactRemote(remote)}`,
      `原始错误：${detail}`,
    ].join('\n')
  }
  if (/Host key verification failed|Permission denied \(publickey\)/i.test(stderr)) {
    return `SSH 认证失败，请检查 ssh key 与 known_hosts 配置。\n原始错误：${detail}`
  }
  if (/couldn't create signal pipe|Win32 error 5|signal pipe/i.test(stderr)) {
    return [
      'Git 子进程无法创建管道：当前 DSH 进程运行在受限沙箱中（例如由 agent 工具启动的 DSH），git 的内部子进程被系统策略阻止。',
      '这不是仓库或凭据问题。请在正常的桌面 DSH 进程中执行同步（或让 DSH 以非沙箱方式启动）。',
      `原始错误：${detail}`,
    ].join('\n')
  }
  if (/could not resolve host|unable to access|network|timed out|Failed to connect/i.test(stderr)) {
    return `无法连接 GitHub（网络问题）。请检查网络/代理后重试。\n原始错误：${detail}`
  }
  return `git 命令失败（exit ${code}）：${command}\n${detail}`
}

/**
 * @param {string} value filesystem path.
 * @returns {Promise<boolean>} existence.
 */
async function pathExists(value) {
  try {
    await access(value, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}
