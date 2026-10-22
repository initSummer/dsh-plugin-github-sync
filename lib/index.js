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
import { applyRuntimeUpdates } from './runtime.js'
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
  let stopped = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let nextTickTimer = null
  let tickInFlight = false
  let lastActivityAt = Date.now()
  let lastWarn = ''
  let consecutiveFailures = 0
  /** @type {ReturnType<typeof setInterval> | null} */
  let legacyInterval = null
  let realtimeMode = true

  /**
   * Collect the sessions that are live in this host process. Their files must
   * not be overwritten: the live session projects its in-memory log and holds
   * the single-writer lease.
   *
   * @returns {Set<string>} live session ids.
   */
  const liveSessionIds = () => {
    try {
      const sessions = ctx.get?.('sessions')
      const list = typeof sessions?.list === 'function' ? sessions.list() : []
      const ids = new Set()
      for (const session of list) {
        const id = session?.id ?? session?.sessionId
        if (typeof id === 'string') ids.add(id)
      }
      return ids
    } catch {
      return new Set()
    }
  }

  /**
   * Whether the running host has a live workspace registry that must be used
   * instead of writing `workspace.json` directly.
   *
   * @returns {boolean} true when the registry is available.
   */
  const hasWorkspaceRegistry = () => {
    try {
      return ctx.get?.('workspaceRegistry') !== undefined
    } catch {
      return false
    }
  }

  const scheduleTick = (delayMs) => {
    if (stopped) return
    if (nextTickTimer !== null) clearTimeout(nextTickTimer)
    nextTickTimer = setTimeout(() => {
      nextTickTimer = null
      void tick('realtime')
    }, Math.max(250, delayMs))
    nextTickTimer.unref?.()
  }

  /**
   * Adaptive delay: fast while the user is working, slower when idle, and the
   * legacy interval when realtime mode is disabled.
   *
   * @param {object | null} config effective configuration.
   * @returns {number} milliseconds until the next poll.
   */
  const nextDelayMs = (config) => {
    let base
    if (config === null || config.realtime?.enabled === false) {
      base = Math.max(30_000, (config?.auto?.intervalMinutes ?? 10) * 60_000)
    } else {
      const active = Date.now() - lastActivityAt < (config.realtime.activeWindowSeconds ?? 90) * 1000
      base = (active ? config.realtime.intervalSeconds : config.realtime.idleIntervalSeconds) * 1000
    }
    if (consecutiveFailures === 0) return base
    // Exponential backoff with ±20% jitter, capped at one minute, so a broken
    // network does not hammer GitHub or the local repo.
    const backedOff = Math.min(60_000, base * 2 ** Math.min(consecutiveFailures, 5))
    return Math.round(backedOff * (0.8 + Math.random() * 0.4))
  }

  /**
   * One synchronous round: pull remote changes, publish local changes, then
   * hot-apply the imported sessions/workspaces to the running UI.
   *
   * @param {string} reason why the round started.
   * @returns {Promise<void>} resolves when the round settles.
   */
  const tick = async (reason) => {
    if (stopped || tickInFlight) return
    tickInFlight = true
    let config = null
    try {
      config = (await api.loadConfig()).config
      realtimeMode = config.realtime?.enabled !== false
      if (!config.enabled || !config.repo) {
        scheduleTick(60_000)
        return
      }
      const result = await runSync({
        dshHome,
        config,
        reason,
        liveSessionIds: liveSessionIds(),
        deferWorkspaceFile: hasWorkspaceRegistry(),
        runtimeApply: (partial) => applyRuntimeUpdates({
          ctx,
          config,
          dshHome,
          result: partial,
          logger,
        }),
      })
      if (result.busy || result.skipped) return
      if (!result.ok) {
        consecutiveFailures += 1
        const message = result.error ?? result.summary
        if (message && message !== lastWarn) {
          lastWarn = message
          logger.warn?.(`实时同步失败（${reason}）：${message}`)
        }
        return
      }
      consecutiveFailures = 0
      lastWarn = ''
      try {
        const applied = await applyRuntimeUpdates({
          ctx,
          config,
          dshHome,
          result,
          logger,
          // The sync round already hot-applied sessions before the canonical
          // re-export; this final pass only picks up late workspace labels.
          skipSessions: result.runtimeApplied === true,
        })
        for (const warning of applied.warnings ?? []) logger.info?.(warning)
      } catch (error) {
        logger.warn?.(`热应用远端变更失败: ${messageOf(error)}`)
      }
      const changed = result.pulled || result.pushed
        || (result.newSessionIds?.length ?? 0) > 0
        || (result.updatedSessionIds?.length ?? 0) > 0
        || result.workspaceChanged === true
      if (changed) {
        const parts = []
        if (result.pulled) parts.push('拉取')
        if (result.pushed) parts.push('推送')
        if ((result.newSessionIds?.length ?? 0) > 0) parts.push(`新会话 ${result.newSessionIds.length}`)
        if ((result.updatedSessionIds?.length ?? 0) > 0) parts.push(`会话更新 ${result.updatedSessionIds.length}`)
        if (result.workspaceChanged) parts.push('工作区更新')
        if ((result.pendingSessionIds?.length ?? 0) > 0) parts.push(`暂缓 ${result.pendingSessionIds.length} 个打开中的会话`)
        logger.info?.(`实时同步（${reason}）：${parts.join('，')}`)
      }
    } catch (error) {
      consecutiveFailures += 1
      logger.warn?.(`实时同步异常（${reason}）: ${messageOf(error)}`)
    } finally {
      tickInFlight = false
      if (!stopped) {
        let latest = config
        if (latest === null) {
          try {
            latest = (await api.loadConfig()).config
          } catch {
            latest = null
          }
        }
        scheduleTick(nextDelayMs(latest))
      }
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
    realtimeMode = config.realtime?.enabled !== false
    try {
      ctx.on('session/event', () => {
        lastActivityAt = Date.now()
        if (stopped) return
        const debounceSeconds = realtimeMode
          ? config.realtime.pushDebounceSeconds
          : config.auto.sessionDebounceSeconds
        if (debounceSeconds > 0) scheduleTick(Math.max(500, debounceSeconds * 1000))
      }, { global: true })
    } catch (error) {
      logger.warn?.(`注册会话事件监听失败（写后自动同步不可用）: ${messageOf(error)}`)
    }
    if (realtimeMode) {
      logger.info?.(`近实时同步已就绪（活跃 ${config.realtime.intervalSeconds}s / 空闲 ${config.realtime.idleIntervalSeconds}s 轮询）`)
      scheduleTick(config.auto.startup ? 5_000 : config.realtime.intervalSeconds * 1000)
    } else {
      if (config.auto.startup) scheduleTick(15_000)
      if (config.auto.intervalMinutes > 0) {
        legacyInterval = setInterval(() => {
          lastActivityAt = Date.now()
          void tick('timer')
        }, config.auto.intervalMinutes * 60_000)
        legacyInterval.unref?.()
      }
      logger.info?.('GitHub 同步已就绪（定时模式），使用 /sync status 查看状态。')
    }
  }
  void startBackground()

  const cleanup = () => {
    if (stopped) return
    stopped = true
    if (nextTickTimer !== null) {
      clearTimeout(nextTickTimer)
      nextTickTimer = null
    }
    if (legacyInterval !== null) {
      clearInterval(legacyInterval)
      legacyInterval = null
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
