/**
 * Model-facing GitHub sync tool.
 *
 * The tool is deliberately small (`status` / `sync` / `init`) so an agent can
 * diagnose and trigger synchronization without shell access, while the heavy
 * lifting stays in {@link module:dsh-plugin-github-sync/sync}.
 *
 * @module dsh-plugin-github-sync/tools
 */

import { computeStatus, initializeConfig, runSync } from './sync.js'

/** Model-visible tool name. */
export const TOOL_NAME = 'github_sync'

/**
 * Register the `github_sync` tool on `ctx.tools`.
 *
 * @param {object} ctx plugin context (must carry the `tools` service).
 * @param {object} api shared plugin API.
 * @param {() => Promise<{ config: object, warnings: string[] }>} api.loadConfig lazy config loader.
 * @param {string} api.dshHome resolved harness home.
 * @returns {() => void} disposer for the registration.
 */
export function registerGithubSyncTool(ctx, api) {
  return ctx.tools.register({
    name: TOOL_NAME,
    description: [
      'Synchronize this machine\'s DeepSeek Harness data (settings, conversations, workspaces, skills, attachments)',
      'with a private GitHub repository configured in $DSH_HOME/github-sync.json.',
      'Use action=status to inspect configuration and the last synchronization result;',
      'action=sync to run a full bidirectional sync now;',
      'action=init with a repository URL to write the machine-local configuration and run the first sync.',
      'Never prints credentials. Conflicts keep the local file and save the remote variant under .dsh-sync/conflicts/.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'sync', 'init'],
          description: 'status: report only; sync: run a sync; init: configure the repository and sync.',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository URL used by action=init, e.g. https://github.com/me/dsh-sync.git',
        },
        branch: {
          type: 'string',
          description: 'Branch name used by action=init (defaults to main).',
        },
        dryRun: {
          type: 'boolean',
          description: 'For action=sync: report what would change without writing local files or pushing.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          conflicts: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'summary'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.summary,
      }],
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'sync' ? '同步 DSH 数据到 GitHub' : args.action === 'init' ? '配置 DSH GitHub 同步' : 'DSH GitHub 同步状态',
      kind: 'other',
      rawInput: args,
    }),
    /**
     * @param {{ action: 'status' | 'sync' | 'init', repo?: string, branch?: string, dryRun?: boolean }} args tool arguments.
     * @param {{ signal?: AbortSignal }} exec tool execution context.
     * @returns {Promise<{ ok: boolean, summary: string, conflicts?: string[] }>} tool result.
     */
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      /** @type {{ config: object, warnings: string[] }} */
      let loaded
      try {
        loaded = await api.loadConfig()
      } catch (error) {
        return {
          ok: false,
          summary: `读取配置失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      if (args.action === 'status') {
        const status = await computeStatus({ dshHome: api.dshHome, config: loaded.config, warnings: loaded.warnings })
        return { ok: true, summary: status.text }
      }
      if (args.action === 'init') {
        try {
          const init = await initializeConfig({
            dshHome: api.dshHome,
            repo: args.repo,
            branch: args.branch ?? loaded.config.branch,
            deviceName: loaded.config.deviceName,
            profileName: loaded.config.profileName,
          })
          const { config } = await api.loadConfig()
          const result = await runSync({ dshHome: api.dshHome, config, reason: 'tool:init' })
          return {
            ok: result.ok === true,
            summary: `已写入配置：${init.file}\n${result.summary ?? ''}`,
            conflicts: result.conflicts,
          }
        } catch (error) {
          return { ok: false, summary: `初始化失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
      exec.signal?.throwIfAborted()
      if (!loaded.config.repo) {
        return {
          ok: false,
          summary: '尚未配置同步仓库。请用 action=init 并提供 repo（GitHub 私有仓库地址），或在 $DSH_HOME/github-sync.json 中填写 repo。',
        }
      }
      const result = await runSync({
        dshHome: api.dshHome,
        config: loaded.config,
        reason: 'tool:sync',
        dryRun: args.dryRun === true,
      })
      return {
        ok: result.ok === true,
        summary: result.summary ?? (result.ok ? '同步完成。' : '同步失败。'),
        conflicts: result.conflicts,
      }
    },
  })
}
