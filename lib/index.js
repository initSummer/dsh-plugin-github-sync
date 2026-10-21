/**
 * dsh-plugin-github-sync — Cordis host plugin.
 *
 * Synchronizes the local DeepSeek Harness home (`$DSH_HOME`) with a private
 * GitHub repository so multiple devices share settings, conversation logs,
 * workspaces, skills and attachments. The plugin exposes:
 *
 * - a `/sync` slash command (`status`, `sync`, `init <repo>`),
 * - a model-facing `github_sync` tool,
 * - optional background synchronization (startup, interval, after sessions
 *   change).
 *
 * The plugin is a plain ESM package with no runtime dependencies: it imports
 * neither DSH packages nor npm packages, so it survives profile installs and
 * does not participate in peer-dependency resolution. Machine-local options
 * live in `$DSH_HOME/github-sync.json`; anything supplied through the profile
 * patch row's `config:` is merged in as defaults (see config.js).
 *
 * @module dsh-plugin-github-sync
 */

import { loadConfig } from './config.js'
import { registerSyncCommand } from './commands.js'
import { resolveDshHome } from './paths.js'
import { runSync } from './sync.js'
import { registerGithubSyncTool } from './tools.js'

/** Cordis plugin name used by the loader and logs. */
export const name = 'github-sync'

/**
 * The plugin only hard-requires the tool and command registries. Session,
 * timer and profile services are read opportunistically through `ctx.get` so
 * the plugin also loads in minimal profiles.
 */
export const inject = ['tools', 'commands']

/**
 * Cordis entry point.
 *
 * @param {object} ctx host plugin context.
 * @param {object | undefined} patchConfig configuration from the profile patch row.
 * @returns {() => void} disposer that stops timers and unregisters handlers.
 */
export function apply(ctx, patchConfig) {
  const dshHome = resolveDshHome()
  const logger = createLogger(ctx)
  const api = {
    dshHome,
    logger,
    /**
     * Reload the machine-local configuration on every operation so edits to
     * `github-sync.json` apply without reloading the plugin.
     *
     * @returns {Promise<{ config: object, warnings: string[], configFile: string, exists: boolean }>} effective configuration.
     */
    loadConfig: () => loadConfig({ dshHome, patchConfig: patchConfig ?? {} }),
  }

  const disposers = []
  try {
    disposers.push(registerGithubSyncTool(ctx, api))
  } catch (error) {
    logger.error?.('注册 github_sync 工具失败: %s', messageOf(error))
  }
  try {
    disposers.push(registerSyncCommand(ctx, api))
  } catch (error) {
    logger.error?.('注册 /sync 命令失败: %s', messageOf(error))
  }

  // ------------------------------------------------------------ background sync
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set()
  /** @type {ReturnType<typeof setInterval> | null} */
  let interval = null
  let stopped = false
  let debounceTimer = null

  const schedule = (callback, delayMs) => {
    if (stopped) return null
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!stopped) Promise.resolve(callback()).catch((error) => logger.warn?.('自动同步失败: %s', messageOf(error)))
    }, delayMs)
    timers.add(timer)
    return timer
  }

  const autoSync = async (reason) => {
    if (stopped) return
    try {
      const { config, warnings } = await api.loadConfig()
      if (!config.enabled || !config.repo) return
      if (warnings.length > 0) logger.info?.(warnings.join('；'))
      const result = await runSync({ dshHome, config, reason })
      if (result.busy || result.skipped) return
      if (result.ok) logger.info?.(`自动同步完成（${reason}）：${result.summary.split('\n')[1] ?? ''}`)
      else logger.warn?.(`自动同步失败（${reason}）：${result.error ?? result.summary}`)
    } catch (error) {
      logger.warn?.(`自动同步异常（${reason}）: ${messageOf(error)}`)
    }
  }

  const startBackground = async () => {
    let config
    try {
      config = (await api.loadConfig()).config
    } catch (error) {
      logger.warn?.(`读取同步配置失败（自动同步未启动）: ${messageOf(error)}`)
      return
    }
    if (!config.enabled) {
      logger.info?.('GitHub 同步未启用（配置缺失或 enabled=false），自动同步不启动。')
      return
    }
    if (config.auto.startup) schedule(() => autoSync('startup'), 15000)
    if (config.auto.intervalMinutes > 0) {
      interval = setInterval(() => autoSync('timer'), config.auto.intervalMinutes * 60_000)
      interval.unref?.()
    }
    if (config.auto.sessionDebounceSeconds > 0) {
      try {
        ctx.on('session/event', () => {
          if (stopped || debounceTimer !== null) return
          debounceTimer = schedule(() => {
            debounceTimer = null
            autoSync('session')
          }, config.auto.sessionDebounceSeconds * 1000)
        }, { global: true })
      } catch (error) {
        logger.warn?.(`注册会话事件监听失败（写后自动同步不可用）: ${messageOf(error)}`)
      }
    }
    logger.info?.('GitHub 同步已就绪，使用 /sync status 查看状态、/sync sync 手动同步。')
  }
  void startBackground()

  const cleanup = () => {
    if (stopped) return
    stopped = true
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (interval !== null) {
      clearInterval(interval)
      interval = null
    }
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // registries already torn down
      }
    }
  }
  try {
    ctx.effect(() => cleanup, 'github-sync lifecycle')
  } catch {
    // ctx.effect unavailable: the returned disposer is still used by the loader.
  }
  return cleanup
}

/**
 * Build a logger that never throws when the host has no logger service.
 *
 * @param {object} ctx plugin context.
 * @returns {{ info: Function, warn: Function, error: Function }} logger.
 */
function createLogger(ctx) {
  try {
    const candidate = typeof ctx.logger === 'function' ? ctx.logger('github-sync') : undefined
    if (candidate && typeof candidate.info === 'function') return candidate
  } catch {
    // fall through to console
  }
  return {
    info: (...args) => console.info('[github-sync]', ...args),
    warn: (...args) => console.warn('[github-sync]', ...args),
    error: (...args) => console.error('[github-sync]', ...args),
  }
}

/**
 * @param {unknown} error candidate error.
 * @returns {string} message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
