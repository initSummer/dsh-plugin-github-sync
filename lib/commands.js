/**
 * Human-facing `/sync` slash command.
 *
 * Commands are executed by the host, never become model messages, and render
 * their `text` result in the Web UI. The command is intentionally thin: all
 * real work happens in {@link module:dsh-plugin-github-sync/sync}.
 *
 * @module dsh-plugin-github-sync/commands
 */

import { computeStatus, initializeConfig, runSync } from './sync.js'

/** Slash-command name shown in the composer menu. */
export const COMMAND_NAME = 'sync'

/** Usage line returned for unknown input. */
const USAGE = [
  '用法：/sync [status|sync|init <仓库地址>|help]',
  '  status            查看同步状态（默认）',
  '  sync              立即执行一次完整同步',
  '  init <仓库地址>    写入本机配置并执行首次同步',
  '  help              显示本帮助',
].join('\n')

/**
 * Register the `/sync` command on `ctx.commands`.
 *
 * @param {object} ctx plugin context (must carry the `commands` service).
 * @param {object} api shared plugin API.
 * @param {() => Promise<{ config: object, warnings: string[] }>} api.loadConfig lazy config loader.
 * @param {string} api.dshHome resolved harness home.
 * @returns {() => void} disposer for the registration.
 */
export function registerSyncCommand(ctx, api) {
  return ctx.commands.register({
    definitionId: 'dsh-plugin-github-sync',
    name: COMMAND_NAME,
    description: '通过 GitHub 同步本机 DSH 的设置、对话记录与工作区',
    input: { hint: '[status|sync|init <仓库地址>|help]' },
    /**
     * @param {{ rawInput?: string, signal?: AbortSignal }} invocation command invocation.
     * @returns {Promise<{ kind: 'success' | 'error', text: string }>} command result.
     */
    handler: async (invocation) => {
      const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const [verb = 'status'] = raw.split(/\s+/u)
      try {
        if (verb === 'help' || verb === '-h' || verb === '--help') return { kind: 'success', text: USAGE }
        if (verb === 'status') {
          const { config, warnings } = await api.loadConfig()
          const status = await computeStatus({ dshHome: api.dshHome, config, warnings })
          return { kind: 'success', text: status.text }
        }
        if (verb === 'init') {
          const repo = raw.slice('init'.length).trim()
          const { config, warnings } = await api.loadConfig()
          const init = await initializeConfig({
            dshHome: api.dshHome,
            repo,
            branch: config.branch,
            deviceName: config.deviceName,
            profileName: config.profileName,
          })
          const { config: reloaded } = await api.loadConfig()
          const result = await runSync({ dshHome: api.dshHome, config: reloaded, reason: 'command:init' })
          return {
            kind: result.ok ? 'success' : 'error',
            text: `已写入配置：${init.file}\n${result.summary ?? ''}${warnings.length > 0 ? `\n提示：${warnings.join('；')}` : ''}`,
          }
        }
        if (verb === 'sync' || verb === 'push' || verb === 'pull' || verb === 'now') {
          const { config, warnings } = await api.loadConfig()
          if (warnings.length > 0 && !config.repo) {
            return { kind: 'error', text: `未配置同步仓库。执行 /sync init <仓库地址> 开始。\n${warnings.join('\n')}` }
          }
          invocation.signal?.throwIfAborted()
          const result = await runSync({ dshHome: api.dshHome, config, reason: `command:${verb}` })
          return { kind: result.ok ? 'success' : 'error', text: result.summary ?? '同步完成。' }
        }
        return {
          kind: 'error',
          text: `未知子命令：${verb}\n${USAGE}`,
        }
      } catch (error) {
        return {
          kind: 'error',
          text: `同步命令失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })
}

/** Re-export for the CLI. */
export { USAGE }
