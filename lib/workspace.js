/**
 * Workspace registry (`$DSH_HOME/storages/workspace.json`) helpers.
 *
 * The registry is a schema-validated KV domain file:
 * `{ unit: { name, version }, global, tables: { workspaces } }`. DSH validates
 * strong invariants on startup and refuses the domain when they are broken:
 *
 * - every id in `global.workspaceIds` has a record and vice versa;
 * - two records never share the same canonical path;
 * - one session id belongs to exactly one workspace;
 * - `pinnedSessionIds` and `archivedSessionIds` are disjoint.
 *
 * Two devices add different workspaces and sessions, so the sync engine merges
 * records by canonical path (falling back to workspace id) and re-establishes
 * those invariants instead of overwriting the file.
 *
 * @module dsh-plugin-github-sync/workspace
 */

import { isNonEmptyString, pathKey } from './paths.js'

/** Domain descriptor expected in the registry file. */
export const WORKSPACE_UNIT = Object.freeze({ name: 'workspace', version: 2 })

/**
 * Parse a workspace registry JSON document.
 *
 * @param {string} text file content.
 * @returns {object | null} parsed document, or null when it is not a registry.
 */
export function parseWorkspaceDoc(text) {
  try {
    const doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    if (!doc || typeof doc !== 'object') return null
    if (!doc.tables || typeof doc.tables !== 'object' || !doc.tables.workspaces) return null
    return doc
  } catch {
    return null
  }
}

/**
 * Serialize a registry document with two-space indentation and a trailing
 * newline, matching what the storage backend writes.
 *
 * @param {object} doc registry document.
 * @returns {string} file content.
 */
export function serializeWorkspaceDoc(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * Rewrite every workspace path in a document through a mapper.
 *
 * @param {object} doc registry document.
 * @param {(value: string) => string} mapPath path mapper.
 * @returns {object} cloned document with mapped paths.
 */
export function mapWorkspacePaths(doc, mapPath) {
  const clone = structuredClone(doc)
  const workspaces = clone.tables?.workspaces ?? {}
  for (const entry of Object.values(workspaces)) {
    if (entry && typeof entry === 'object' && typeof entry.path === 'string') entry.path = mapPath(entry.path)
  }
  return clone
}

/**
 * Merge a remote workspace registry into the local registry.
 *
 * Both documents must already be expressed in the local path space. Records
 * are matched by canonical path first (so two devices that independently
 * created a workspace for the same folder collapse into one record) and by
 * workspace id second (so a workspace whose path changed stays one record).
 *
 * @param {object | null} localDoc local registry document.
 * @param {object | null} remoteDoc remote registry document in local path space.
 * @returns {{ doc: object, addedWorkspaces: string[], addedSessions: string[], changed: boolean, issues: string[] }} merge result.
 */
export function mergeWorkspaceDocs(localDoc, remoteDoc) {
  const local = normalizeDoc(localDoc, emptyWorkspaceDoc())
  const remote = normalizeDoc(remoteDoc, emptyWorkspaceDoc())
  const issues = []
  const doc = structuredClone(local)
  doc.unit = doc.unit ?? structuredClone(WORKSPACE_UNIT)
  doc.global = doc.global ?? {}
  doc.tables = doc.tables ?? {}
  /** @type {Record<string, object>} */
  const table = doc.tables.workspaces ?? {}
  doc.tables.workspaces = table

  const addedWorkspaces = []
  const addedSessions = []
  let changed = false

  /** @type {Map<string, string>} canonical path key -> local workspace id */
  const pathIndex = new Map()
  for (const [id, entry] of Object.entries(table)) {
    const key = entryPathKey(entry)
    if (key !== null && !pathIndex.has(key)) pathIndex.set(key, id)
  }

  for (const [remoteId, remoteEntry] of Object.entries(remote.tables.workspaces ?? {})) {
    if (!remoteEntry || typeof remoteEntry !== 'object') continue
    const key = entryPathKey(remoteEntry)
    const samePathId = key === null ? undefined : pathIndex.get(key)
    if (remoteId in table) {
      const merged = mergeWorkspaceEntry(table[remoteId], remoteEntry)
      // A local record keeps its own path; migrate only when local has none.
      if (merged.changed) {
        table[remoteId] = merged.entry
        addedSessions.push(...merged.addedSessions)
        changed = true
      }
      const existingKey = entryPathKey(table[remoteId])
      if (existingKey !== null && !pathIndex.has(existingKey)) pathIndex.set(existingKey, remoteId)
      continue
    }
    if (samePathId !== undefined) {
      // Same folder, different workspace id on the other device: merge the
      // sessions into the local record and keep the local id stable.
      const merged = mergeWorkspaceEntry(table[samePathId], remoteEntry)
      table[samePathId] = merged.entry
      addedSessions.push(...merged.addedSessions)
      issues.push(`工作区路径 ${remoteEntry.path} 在两台设备上有不同 id，已合并到本机 id ${samePathId}。`)
      changed = true
      continue
    }
    table[remoteId] = structuredClone(remoteEntry)
    if (key !== null) pathIndex.set(key, remoteId)
    addedWorkspaces.push(remoteId)
    changed = true
  }

  // Deduplicate paths defensively (a remote document could already contain
  // duplicates): keep the first record in workspace-id order, merge the rest.
  const global = doc.global
  const order = uniqueStrings([
    ...(Array.isArray(local.global?.workspaceIds) ? local.global.workspaceIds : []),
    ...Object.keys(local.tables.workspaces ?? {}),
    ...Object.keys(remote.tables.workspaces ?? {}),
    ...(Array.isArray(remote.global?.workspaceIds) ? remote.global.workspaceIds : []),
  ])
  const byPath = new Map()
  const finalOrder = []
  for (const id of order) {
    const entry = table[id]
    if (!entry) continue
    const key = entryPathKey(entry)
    if (key !== null && byPath.has(key)) {
      const keeperId = byPath.get(key)
      const merged = mergeWorkspaceEntry(table[keeperId], entry)
      table[keeperId] = merged.entry
      addedSessions.push(...merged.addedSessions)
      delete table[id]
      issues.push(`检测到重复的工作区路径 ${entry.path}，已合并到 ${keeperId}。`)
      changed = true
      continue
    }
    if (key !== null) byPath.set(key, id)
    finalOrder.push(id)
  }

  // A session id belongs to exactly one workspace; keep the first owner.
  const sessionOwners = new Map()
  for (const id of finalOrder) {
    const entry = table[id]
    if (!entry) continue
    const sessions = Array.isArray(entry.sessionIds) ? entry.sessionIds : []
    const kept = []
    for (const sessionId of sessions) {
      if (sessionOwners.has(sessionId)) {
        issues.push(`会话 ${sessionId} 同时登记在多个工作区，已保留 ${sessionOwners.get(sessionId)} 中的归属。`)
        changed = true
        continue
      }
      sessionOwners.set(sessionId, id)
      kept.push(sessionId)
    }
    if (kept.length !== sessions.length) entry.sessionIds = kept
    else if (!Array.isArray(entry.sessionIds)) entry.sessionIds = kept
  }

  // workspaceIds must match the table exactly, local order first.
  if (!arraysEqual(global.workspaceIds, finalOrder)) {
    global.workspaceIds = finalOrder
    changed = true
  }

  // Archive and pin sets are unions; pinned wins over archived on conflict.
  const allSessionIds = new Set(sessionOwners.keys())
  const archived = unionSessionIds(global.archivedSessionIds, remote.global?.archivedSessionIds).filter((id) => allSessionIds.has(id))
  const pinned = unionSessionIds(global.pinnedSessionIds, remote.global?.pinnedSessionIds).filter((id) => allSessionIds.has(id) && !archived.includes(id))
  if (!arraysEqual(global.archivedSessionIds, archived)) {
    global.archivedSessionIds = archived
    changed = true
  }
  if (!arraysEqual(global.pinnedSessionIds, pinned)) {
    global.pinnedSessionIds = pinned
    changed = true
  }

  // defaultWorkspaceId: keep local when it is still valid, otherwise remote.
  const candidates = [global.defaultWorkspaceId, remote.global?.defaultWorkspaceId, finalOrder[0]]
  const defaultWorkspaceId = candidates.find((candidate) => typeof candidate === 'string' && candidate in table)
  if (defaultWorkspaceId !== global.defaultWorkspaceId) {
    global.defaultWorkspaceId = defaultWorkspaceId
    changed = true
  }

  if (global.initialized !== true && (remote.global?.initialized === true || finalOrder.length > 0)) {
    global.initialized = true
    changed = true
  }
  // A crash-recovery marker has no meaning across devices.
  if ('pendingMutation' in global) {
    delete global.pendingMutation
    changed = true
  }

  return { doc, addedWorkspaces, addedSessions, changed, issues }
}

/**
 * Merge two records for the same workspace identity.
 *
 * Local values win for path and title; session ids are unioned; timestamps take
 * the wider range.
 *
 * @param {object} localEntry local workspace entry.
 * @param {object} remoteEntry remote workspace entry (local path space).
 * @returns {{ entry: object, addedSessions: string[], changed: boolean }} merge result.
 */
export function mergeWorkspaceEntry(localEntry, remoteEntry) {
  const entry = structuredClone(localEntry)
  const addedSessions = []
  let changed = false
  if (!isNonEmptyString(entry.path) && isNonEmptyString(remoteEntry.path)) {
    entry.path = remoteEntry.path
    changed = true
  }
  if (!isNonEmptyString(entry.title) && isNonEmptyString(remoteEntry.title)) {
    entry.title = remoteEntry.title
    changed = true
  }
  const localSessions = Array.isArray(entry.sessionIds) ? entry.sessionIds : []
  const remoteSessions = Array.isArray(remoteEntry.sessionIds) ? remoteEntry.sessionIds : []
  const sessionIds = uniqueStrings([...localSessions, ...remoteSessions])
  if (sessionIds.length !== localSessions.length || !sessionIds.every((value, index) => value === localSessions[index])) {
    for (const id of remoteSessions) {
      if (!localSessions.includes(id)) addedSessions.push(id)
    }
    entry.sessionIds = sessionIds
    changed = true
  } else if (!Array.isArray(entry.sessionIds)) {
    entry.sessionIds = sessionIds
    changed = true
  }
  const createdAt = earliestTimestamp(entry.createdAt, remoteEntry.createdAt)
  if (createdAt !== entry.createdAt && createdAt !== undefined) {
    entry.createdAt = createdAt
    changed = true
  }
  const updatedAt = latestTimestamp(entry.updatedAt, remoteEntry.updatedAt)
  if (updatedAt !== entry.updatedAt && updatedAt !== undefined) {
    entry.updatedAt = updatedAt
    changed = true
  }
  return { entry, addedSessions, changed }
}

/**
 * Remove workspace records whose path is excluded by configuration.
 *
 * All dependent global lists are re-derived so the result still satisfies the
 * DSH invariants. Excluded workspaces are simply not synced; local data is
 * never deleted.
 *
 * @param {object | null} doc registry document in the caller's path space.
 * @param {Array<string>} excludedPaths workspace paths to drop.
 * @returns {{ doc: object, removed: string[] }} filtered document.
 */
export function excludeWorkspaces(doc, excludedPaths) {
  const clone = structuredClone(doc ?? emptyWorkspaceDoc())
  const keys = new Set((excludedPaths ?? []).map((value) => pathKey(value)))
  const table = clone.tables?.workspaces ?? {}
  clone.tables = clone.tables ?? {}
  clone.tables.workspaces = table
  const removed = []
  for (const [id, entry] of Object.entries(table)) {
    if (entry && typeof entry.path === 'string' && keys.has(pathKey(entry.path))) {
      delete table[id]
      removed.push(id)
    }
  }
  const global = clone.global ?? {}
  clone.global = global
  const ids = (Array.isArray(global.workspaceIds) ? global.workspaceIds : []).filter((id) => id in table)
  for (const id of Object.keys(table)) if (!ids.includes(id)) ids.push(id)
  global.workspaceIds = ids
  if (typeof global.defaultWorkspaceId === 'string' && !(global.defaultWorkspaceId in table)) global.defaultWorkspaceId = ids[0]
  const owned = new Set(Object.values(table).flatMap((entry) => (Array.isArray(entry?.sessionIds) ? entry.sessionIds : [])))
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
    global[key] = (Array.isArray(global[key]) ? global[key] : []).filter((id) => owned.has(id))
  }
  return { doc: clone, removed }
}

/**
 * Validate the invariants DSH checks on startup and report violations without
 * throwing (the caller can decide to fall back to skipping the registry).
 *
 * @param {object} doc registry document.
 * @returns {string[]} invariant violations (empty means valid).
 */
export function validateWorkspaceDoc(doc) {
  const problems = []
  const table = doc?.tables?.workspaces ?? {}
  const ids = Array.isArray(doc?.global?.workspaceIds) ? doc.global.workspaceIds : []
  for (const id of ids) {
    if (!(id in table)) problems.push(`workspaceIds 中的 ${id} 没有对应记录`)
  }
  for (const id of Object.keys(table)) {
    if (!ids.includes(id)) problems.push(`记录 ${id} 不在 workspaceIds 中`)
  }
  const paths = new Set()
  for (const [id, entry] of Object.entries(table)) {
    const pathValue = entry?.path
    if (!isNonEmptyString(pathValue)) problems.push(`工作区 ${id} 缺少 path`)
    else {
      const key = pathKey(pathValue)
      if (paths.has(key)) problems.push(`工作区路径重复：${pathValue}`)
      paths.add(key)
    }
  }
  const owners = new Map()
  for (const [id, entry] of Object.entries(table)) {
    for (const sessionId of Array.isArray(entry?.sessionIds) ? entry.sessionIds : []) {
      if (owners.has(sessionId) && owners.get(sessionId) !== id) problems.push(`会话 ${sessionId} 同时归属 ${owners.get(sessionId)} 与 ${id}`)
      owners.set(sessionId, id)
    }
  }
  const invalidPinned = (Array.isArray(doc?.global?.pinnedSessionIds) ? doc.global.pinnedSessionIds : []).filter(
    (id) => (Array.isArray(doc?.global?.archivedSessionIds) ? doc.global.archivedSessionIds : []).includes(id),
  )
  if (invalidPinned.length > 0) problems.push(`归档与置顶集合重叠：${invalidPinned.join(', ')}`)
  return problems
}

/**
 * Build an empty registry document.
 *
 * @returns {object} empty document.
 */
export function emptyWorkspaceDoc() {
  return {
    unit: structuredClone(WORKSPACE_UNIT),
    global: {
      initialized: false,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces: {} },
  }
}

/**
 * List the workspace rows currently registered to local paths.
 *
 * @param {object | null} doc registry document.
 * @returns {Array<{ id: string, path: string, title: string, sessionIds: string[] }>} workspace rows.
 */
export function listWorkspaces(doc) {
  const workspaces = doc?.tables?.workspaces ?? {}
  return Object.entries(workspaces).map(([id, entry]) => ({
    id,
    path: typeof entry?.path === 'string' ? entry.path : '',
    title: typeof entry?.title === 'string' ? entry.title : '',
    sessionIds: Array.isArray(entry?.sessionIds) ? entry.sessionIds.filter((value) => typeof value === 'string') : [],
  }))
}

/**
 * Normalize an input document into the expected outer shape.
 *
 * @param {object | null | undefined} value candidate document.
 * @param {object} fallback fallback document.
 * @returns {object} shallow-normalized document.
 */
function normalizeDoc(value, fallback) {
  if (!value || typeof value !== 'object') return fallback
  return {
    ...fallback,
    ...value,
    unit: value.unit ?? structuredClone(WORKSPACE_UNIT),
    global: { ...fallback.global, ...(value.global ?? {}) },
    tables: {
      ...(value.tables ?? {}),
      workspaces: { ...(value.tables?.workspaces ?? {}) },
    },
  }
}

/**
 * @param {object} entry workspace record.
 * @returns {string | null} comparison key for the record path.
 */
function entryPathKey(entry) {
  return entry && typeof entry.path === 'string' && entry.path.length > 0 ? pathKey(entry.path) : null
}

/**
 * @param {unknown} first candidate timestamp.
 * @param {unknown} second candidate timestamp.
 * @returns {unknown} earlier value.
 */
function earliestTimestamp(first, second) {
  if (first === undefined) return second
  if (second === undefined) return first
  return new Date(first).getTime() <= new Date(second).getTime() ? first : second
}

/**
 * @param {unknown} first candidate timestamp.
 * @param {unknown} second candidate timestamp.
 * @returns {unknown} later value.
 */
function latestTimestamp(first, second) {
  if (first === undefined) return second
  if (second === undefined) return first
  return new Date(first).getTime() >= new Date(second).getTime() ? first : second
}

/**
 * @param {unknown} first first id list.
 * @param {unknown} second second id list.
 * @returns {string[]} ordered union of session ids.
 */
function unionSessionIds(first, second) {
  return uniqueStrings([...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])])
}

/**
 * @param {string[]} values values to de-duplicate.
 * @returns {string[]} unique values preserving order.
 */
function uniqueStrings(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * @param {unknown} first first array.
 * @param {unknown} second second array.
 * @returns {boolean} whether both arrays contain identical strings in order.
 */
function arraysEqual(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second)) return false
  if (first.length !== second.length) return false
  return first.every((value, index) => value === second[index])
}
