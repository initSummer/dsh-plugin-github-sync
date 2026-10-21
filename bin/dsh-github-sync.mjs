#!/usr/bin/env node
/**
 * Standalone CLI for dsh-plugin-github-sync.
 *
 * The plugin itself runs inside DSH; this binary provides the same engine for
 * first-time setup, cron jobs, recovery when DSH cannot start, and debugging.
 * It reads the same `$DSH_HOME/github-sync.json` configuration and state.
 *
 * Usage:
 *   node bin/dsh-github-sync.mjs status
 *   node bin/dsh-github-sync.mjs sync [--dry-run]
 *   node bin/dsh-github-sync.mjs init --repo <url> [--branch main] [--device name] [--profile desktop]
 *   node bin/dsh-github-sync.mjs doctor
 *   node bin/dsh-github-sync.mjs paths
 *
 * Environment: `DSH_HOME` selects the harness home (default `~/.dsh`).
 *
 * @module dsh-plugin-github-sync/bin
 */

import { loadConfig, redactRemote } from '../lib/config.js'
import { computeStatus, initializeConfig, runSync } from '../lib/sync.js'
import { configPath, repoPath, resolveDshHome, statePath, syncPath } from '../lib/paths.js'
import { readState } from '../lib/state.js'
import { resolveGitPath } from '../lib/git.js'

const USAGE = `dsh-plugin-github-sync — 通过 GitHub 同步多台设备的 DSH 数据

用法：
  dsh-github-sync status                          查看配置与最近一次同步状态
  dsh-github-sync sync [--dry-run]                执行一次完整同步（导出→合并→导入→推送）
  dsh-github-sync init --repo <仓库地址> [选项]     写入本机配置并执行首次同步
        --repo <url>        GitHub 私有仓库地址（https:// 或 git@）
        --branch <name>     分支，默认 main
        --device <name>     设备名，默认主机名
        --profile <name>    DSH profile 名，默认 desktop
  dsh-github-sync doctor                          检查 git、配置、网络与凭据
  dsh-github-sync paths                           打印本机相关路径

环境变量：
  DSH_HOME              DSH home（默认 ~/.dsh）
  DSH_SYNC_GITHUB_TOKEN GitHub PAT（也可用 GH_TOKEN / GITHUB_TOKEN）
`

/**
 * Program entry.
 *
 * @param {string[]} argv process arguments after the script name.
 * @returns {Promise<number>} process exit code.
 */
async function main(argv) {
  const [command = 'status', ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  const dshHome = resolveDshHome()
  const options = parseFlags(rest)
  if (options.help === true) {
    process.stdout.write(USAGE)
    return 0
  }

  if (command === 'paths') {
    process.stdout.write([
      `DSH_HOME    ${dshHome}`,
      `配置文件     ${configPath(dshHome)}`,
      `状态文件     ${statePath(dshHome)}`,
      `冲突副本     ${syncPath(dshHome, 'conflicts')}`,
      `备份         ${syncPath(dshHome, 'backups')}`,
      `快照仓库     ${repoPath(dshHome)}`,
      '',
    ].join('\n'))
    return 0
  }

  if (command === 'doctor') return doctor(dshHome)

  if (command === 'init') {
    if (!options.repo) {
      process.stderr.write('缺少 --repo <仓库地址>\n')
      return 2
    }
    const loaded = await loadConfig({ dshHome, patchConfig: {} })
    const init = await initializeConfig({
      dshHome,
      repo: options.repo,
      branch: options.branch ?? loaded.config.branch,
      deviceName: options.device ?? loaded.config.deviceName,
      profileName: options.profile ?? loaded.config.profileName,
    })
    process.stdout.write(`已写入配置：${init.file}\n`)
    const { config } = await loadConfig({ dshHome, patchConfig: {} })
    const result = await runSync({ dshHome, config, reason: 'cli:init' })
    process.stdout.write(`${result.summary ?? ''}\n`)
    return result.ok ? 0 : 1
  }

  if (command === 'sync' || command === 'push' || command === 'pull') {
    const { config, warnings } = await loadConfig({ dshHome, patchConfig: {} })
    if (!config.repo) {
      process.stderr.write('尚未配置同步仓库。请先运行：dsh-github-sync init --repo <仓库地址>\n')
      return 2
    }
    for (const warning of warnings) process.stderr.write(`提示：${warning}\n`)
    const result = await runSync({
      dshHome,
      config,
      reason: `cli:${command}`,
      dryRun: options['dry-run'] === true || options.dryRun === true,
    })
    process.stdout.write(`${result.summary ?? ''}\n`)
    return result.ok ? 0 : 1
  }

  if (command === 'status') {
    const { config, warnings, configFile, exists } = await loadConfig({ dshHome, patchConfig: {} })
    const status = await computeStatus({ dshHome, config, warnings })
    process.stdout.write(`${status.text}\n`)
    if (!exists) process.stdout.write(`\n配置文件不存在：${configFile}\n`)
    return 0
  }

  process.stderr.write(`未知命令：${command}\n\n${USAGE}`)
  return 2
}

/**
 * Inspect the local prerequisites and print a checklist.
 *
 * @param {string} dshHome resolved harness home.
 * @returns {Promise<number>} exit code (0 when usable, 1 when a hard problem exists).
 */
async function doctor(dshHome) {
  const lines = []
  let hardFailure = false
  lines.push(`DSH home：${dshHome}`)
  lines.push(`Node：${process.version}`)
  const loaded = await loadConfig({ dshHome, patchConfig: {} })
  lines.push(`配置文件：${configPath(dshHome)}（${loaded.exists ? '存在' : '不存在'}）`)
  if (!loaded.config.repo) {
    lines.push('仓库：未配置（运行 init --repo <url>）')
    hardFailure = true
  } else {
    lines.push(`仓库：${redactRemote(loaded.config.repo)}（分支 ${loaded.config.branch}）`)
  }
  try {
    const gitPath = await resolveGitPath(loaded.config)
    lines.push(`git：${gitPath}`)
  } catch (error) {
    lines.push(`git：不可用（${error.message}）`)
    hardFailure = true
  }
  const tokenVariables = [loaded.config.git?.tokenEnv, ...(loaded.config.git?.fallbackTokenEnvs ?? [])].filter(Boolean)
  const tokenVariable = tokenVariables.find((variable) => typeof process.env[variable] === 'string' && process.env[variable].length > 0)
  lines.push(tokenVariable ? `GitHub Token：环境变量 ${tokenVariable} 已设置` : 'GitHub Token：未在环境变量中检测到（可依赖 git credential / SSH）')
  const state = await readState(dshHome)
  lines.push(`上次同步：${state.lastSyncAt ?? '从未'}`)
  if (state.lastError) lines.push(`上次错误：${state.lastError}`)
  for (const warning of loaded.warnings) lines.push(`配置提示：${warning}`)
  lines.push('')
  lines.push(hardFailure ? '结论：还有阻塞问题，请先解决上面的问题。' : '结论：基本配置就绪；运行 sync 验证网络与凭据。')
  process.stdout.write(`${lines.join('\n')}\n`)
  return hardFailure ? 1 : 0
}

/**
 * Parse `--key value` / `--flag` / `--key=value` pairs.
 *
 * @param {string[]} argv argument list.
 * @returns {Record<string, string | boolean>} parsed options.
 */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const result = {}
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const [rawKey, inlineValue] = argument.slice(2).split('=')
    const key = rawKey.trim()
    if (inlineValue !== undefined) {
      result[key] = inlineValue
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next
      index += 1
    } else {
      result[key] = true
    }
  }
  return result
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`致命错误：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
