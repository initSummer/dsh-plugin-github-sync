/**
 * Machine-local persistent state for the sync plugin.
 *
 * The state file never leaves the device: it records which repository paths
 * this device exported, the content hashes observed after the last successful
 * sync (used to detect local edits and safe deletions) and the last outcome
 * shown by `/sync` and the model tool.
 *
 * @module dsh-plugin-github-sync/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { statePath } from './paths.js'

/** Current state file schema version. */
export const STATE_VERSION = 1

/**
 * Read the state file, tolerating absence and corrupted content.
 *
 * @param {string} dshHome resolved harness home.
 * @returns {Promise<object>} state object (fresh when missing/corrupt).
 */
export async function readState(dshHome) {
  try {
    const text = JSON.parse(await readFile(statePath(dshHome), 'utf8'))
    return normalizeState(text)
  } catch {
    return normalizeState({})
  }
}

/**
 * Persist the state file atomically.
 *
 * @param {string} dshHome resolved harness home.
 * @param {object} state state object.
 * @returns {Promise<void>} resolves after the rename.
 */
export async function writeState(dshHome, state) {
  const file = statePath(dshHome)
  await mkdir(path.dirname(file), { recursive: true })
  const normalized = normalizeState(state)
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Fill missing state fields with defaults and coerce invalid values.
 *
 * @param {unknown} value raw state.
 * @returns {object} normalized state.
 */
export function normalizeState(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    version: STATE_VERSION,
    deviceId: typeof input.deviceId === 'string' && input.deviceId.length > 0 ? input.deviceId : null,
    deviceName: typeof input.deviceName === 'string' ? input.deviceName : null,
    lastSyncAt: toIsoOrNull(input.lastSyncAt),
    lastAttemptAt: toIsoOrNull(input.lastAttemptAt),
    lastPushAt: toIsoOrNull(input.lastPushAt),
    lastPullAt: toIsoOrNull(input.lastPullAt),
    lastCommit: typeof input.lastCommit === 'string' ? input.lastCommit : null,
    lastError: typeof input.lastError === 'string' ? input.lastError : null,
    lastSummary: typeof input.lastSummary === 'string' ? input.lastSummary : null,
    /** @type {Record<string, { hash: string, localPath: string, kind: string }>} */
    managed: input.managed && typeof input.managed === 'object' && !Array.isArray(input.managed) ? input.managed : {},
    /** @type {Array<object>} */
    conflicts: Array.isArray(input.conflicts) ? input.conflicts.slice(-50) : [],
    /** @type {Array<object>} */
    history: Array.isArray(input.history) ? input.history.slice(-20) : [],
  }
}

/**
 * Record one sync outcome in state (kept as a short history for diagnostics).
 *
 * @param {object} state state object to mutate.
 * @param {object} result sync result summary.
 * @returns {object} the same state instance.
 */
export function recordOutcome(state, result) {
  const now = new Date().toISOString()
  state.lastSyncAt = now
  state.lastCommit = result.commit ?? state.lastCommit
  state.lastSummary = result.summary ?? state.lastSummary
  state.lastError = result.ok ? null : (result.error ?? null)
  if (result.pushed) state.lastPushAt = now
  if (result.pulled) state.lastPullAt = now
  state.history.push({
    at: now,
    ok: result.ok === true,
    pushed: result.pushed === true,
    pulled: result.pulled === true,
    files: result.files ?? 0,
    error: result.ok ? null : (result.error ?? null),
  })
  if (state.history.length > 20) state.history = state.history.slice(-20)
  return state
}

/**
 * @param {unknown} value candidate timestamp.
 * @returns {string | null} ISO timestamp or null.
 */
function toIsoOrNull(value) {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
