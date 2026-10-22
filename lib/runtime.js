/**
 * Runtime hot-application of synchronized changes.
 *
 * The sync engine writes files into `$DSH_HOME`, but a running DSH host keeps
 * workspace and session state in memory. This module bridges the two using the
 * host services:
 *
 * - `ctx.workspaceRegistry` mutations emit `domain/changed`, which the Web
 *   client's workspace follow stream turns into live sidebar updates;
 * - `api-session/added` / `api-session/activity` events are relayed to the
 *   browser and update its session list without a restart.
 *
 * Every integration is optional: the plugin must keep working in profiles or
 * CLI environments where those services are absent.
 *
 * @module dsh-plugin-github-sync/runtime
 */

import { pathKey } from './paths.js'

/**
 * Read a service without requiring it in `inject`.
 *
 * @param {object} ctx plugin context.
 * @param {string} name service name.
 * @returns {any} service or undefined.
 */
function service(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * Hot-apply one sync result to the running host services.
 *
 * @param {object} options apply options.
 * @param {object} options.ctx plugin context.
 * @param {object} options.config effective configuration.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.result `runSync` result.
 * @param {{ info?: Function, warn?: Function }} [options.logger] logger.
 * @returns {Promise<{ applied: boolean, warnings: string[] }>} apply summary.
 */
export async function applyRuntimeUpdates(options) {
  const { ctx, config, result, logger, skipSessions = false } = options
  const warnings = []
  const hasSessionChanges = (result?.newSessionIds?.length ?? 0) > 0
    || (result?.updatedSessionIds?.length ?? 0) > 0
    || (result?.deletedSessionIds?.length ?? 0) > 0
  const hasChanges = result?.workspaceChanged === true || hasSessionChanges
  if (!hasChanges) return { applied: false, warnings }

  const registry = service(ctx, 'workspaceRegistry')
  if (registry !== undefined) {
    try {
      await reconcileWorkspaces({ ctx, registry, config, result, warnings })
    } catch (error) {
      warnings.push(`热应用工作区失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (skipSessions || !hasSessionChanges) return { applied: true, warnings }
  try {
    await emitSessionEvents({ ctx, result, warnings })
    const pushed = (result.newSessionIds?.length ?? 0) + (result.updatedSessionIds?.length ?? 0) + (result.deletedSessionIds?.length ?? 0)
    if (pushed > 0) logger?.info?.(`已向界面推送 ${pushed} 个会话更新`)
  } catch (error) {
    warnings.push(`推送会话事件失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { applied: true, warnings }
}

/**
 * Reconcile the imported workspace registry with the live registry so the Web
 * client receives follow frames immediately.
 *
 * @param {object} options reconcile options.
 * @param {object} options.ctx plugin context.
 * @param {object} options.registry live workspace registry service.
 * @param {object} options.config effective configuration.
 * @param {object} options.result sync result.
 * @param {string[]} options.warnings warning sink.
 * @returns {Promise<void>} resolves after reconciliation.
 */
async function reconcileWorkspaces(options) {
  const { ctx, registry, config, result, warnings } = options
  if (result.workspaceChanged !== true) return
  const doc = result.localWorkspaceDoc
  if (doc === null || doc === undefined) return
  const desired = listWorkspaceRows(doc)
  if (desired.length === 0) return
  let live = []
  try {
    live = typeof registry.list === 'function' ? registry.list() : []
  } catch {
    live = []
  }
  const liveByPath = new Map()
  for (const workspace of live) {
    if (typeof workspace.path === 'string') liveByPath.set(pathKey(workspace.path), workspace)
  }
  for (const row of desired) {
    if (typeof row.path !== 'string' || row.path.length === 0) continue
    const existing = liveByPath.get(pathKey(row.path))
    if (existing === undefined) {
      try {
        const created = await registry.create(row.path, row.title)
        if (created !== undefined && typeof created.id === 'string') liveByPath.set(pathKey(row.path), created)
      } catch (error) {
        warnings.push(`无法把工作区 ${row.path} 应用到运行中的 DSH：${messageOf(error)}`)
        continue
      }
    } else if (typeof existing.title === 'string' && existing.title !== row.title && typeof existing.setTitle === 'function') {
      try {
        await existing.setTitle(row.title)
      } catch (error) {
        warnings.push(`无法更新工作区标题 ${row.title}：${messageOf(error)}`)
      }
    }
  }
  // Attach imported sessions to their workspaces so the sidebar nests them.
  try {
    const byPath = liveByPath
    for (const sessionId of result.newSessionIds ?? []) {
      const target = findWorkspaceForSession(doc, sessionId)
      if (target === null) continue
      const workspace = byPath.get(pathKey(target))
      if (workspace === undefined || typeof workspace.attachSession !== 'function') continue
      try {
        const already = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        if (!already.includes(sessionId)) await workspace.attachSession(sessionId)
      } catch (error) {
        warnings.push(`无法把会话 ${sessionId} 挂到工作区：${messageOf(error)}`)
      }
    }
  } catch (error) {
    warnings.push(`挂载会话到工作区失败：${messageOf(error)}`)
  }
}

/**
 * Read the authoritative session-list rows for the given ids.
 *
 * `sessionController.list()` scans persistence on every call, so it includes
 * sessions that were just imported from another device. Using its rows avoids
 * guessing the client-facing `SessionSummary` shape.
 *
 * @param {object} ctx plugin context.
 * @param {Set<string>} ids wanted session ids.
 * @returns {Promise<Map<string, object>>} sessionId -> summary row.
 */
async function controllerRows(ctx, ids) {
  const map = new Map()
  if (ids.size === 0) return map
  const controller = service(ctx, 'sessionController')
  if (controller === undefined || typeof controller.list !== 'function') return map
  let result
  try {
    result = await controller.list({})
  } catch {
    try {
      result = await controller.list()
    } catch {
      return map
    }
  }
  const items = Array.isArray(result) ? result : (result?.items ?? [])
  for (const item of items) {
    if (item && typeof item.sessionId === 'string' && ids.has(item.sessionId)) map.set(item.sessionId, item)
  }
  return map
}

/**
 * Emit the client-relayed session events for imported sessions.
 *
 * @param {object} options emit options.
 * @param {object} options.ctx plugin context.
 * @param {object} options.result sync result.
 * @param {string[]} options.warnings warning sink.
 * @returns {Promise<void>} resolves after emitting.
 */
async function emitSessionEvents(options) {
  const { ctx, result, warnings } = options
  const emit = typeof ctx.emit === 'function' ? ctx.emit.bind(ctx) : null
  if (emit === null) return
  const newIds = new Set(result.newSessionIds ?? [])
  const updatedIds = new Set(result.updatedSessionIds ?? [])
  const wanted = new Set([...newIds, ...updatedIds])
  const rows = await controllerRows(ctx, wanted)
  for (const sessionId of newIds) {
    const summary = rows.get(sessionId) ?? result.sessionSummaries?.[sessionId]
    if (summary === undefined) {
      warnings.push(`新会话 ${sessionId} 暂未被 sessionController 列出，界面将在下次刷新时显示。`)
      continue
    }
    try {
      emit('api-session/added', summary)
    } catch (error) {
      warnings.push(`推送新会话 ${sessionId} 失败：${messageOf(error)}`)
    }
  }
  for (const sessionId of updatedIds) {
    if (newIds.has(sessionId)) continue
    try {
      const row = rows.get(sessionId)
      emit('api-session/activity', sessionId, row?.updatedAt ?? Date.now())
    } catch (error) {
      warnings.push(`推送会话活动 ${sessionId} 失败：${messageOf(error)}`)
    }
  }
  for (const sessionId of result.deletedSessionIds ?? []) {
    try {
      emit('api-session/removed', sessionId)
    } catch (error) {
      warnings.push(`推送会话删除 ${sessionId} 失败：${messageOf(error)}`)
    }
  }
}

/**
 * @param {object} doc workspace registry document.
 * @param {string} sessionId session id.
 * @returns {string | null} local workspace path owning the session.
 */
function findWorkspaceForSession(doc, sessionId) {
  const workspaces = doc?.tables?.workspaces ?? {}
  for (const entry of Object.values(workspaces)) {
    if (!entry || typeof entry !== 'object') continue
    if (Array.isArray(entry.sessionIds) && entry.sessionIds.includes(sessionId) && typeof entry.path === 'string') {
      return entry.path
    }
  }
  return null
}

/**
 * @param {object} doc workspace registry document.
 * @returns {Array<{ path: string, title: string }>} workspace rows.
 */
function listWorkspaceRows(doc) {
  const workspaces = doc?.tables?.workspaces ?? {}
  return Object.values(workspaces)
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string')
    .map((entry) => ({ path: entry.path, title: typeof entry.title === 'string' ? entry.title : entry.path }))
}

/**
 * @param {unknown} error candidate error.
 * @returns {string} message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
