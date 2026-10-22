/**
 * Device attribution for shared workspaces.
 *
 * DSH's workspace registry has no "origin device" field and its schema
 * validation rejects unknown fields, so the snapshot repository carries a
 * sidecar document instead:
 *
 * ```text
 * meta/workspaces.json
 * {
 *   "version": 1,
 *   "workspaces": {
 *     "E:\\work_with_yan": { "originDevice": "jackfruit", "updatedAt": "..." }
 *   }
 * }
 * ```
 *
 * The canonical workspace title is decorated with the origin device on export
 * (`wwa · jackfruit`) so every device's DSH sidebar shows where a workspace
 * came from. The sidecar lets the plugin strip/re-apply that suffix without
 * duplicating it, and survives device renames.
 *
 * @module dsh-plugin-github-sync/devices
 */

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteFile, readFileIfExists } from './fsutil.js'
import { joinRepoRelative, isNonEmptyString, pathKey } from './paths.js'
import { listWorkspaces, parseWorkspaceDoc, serializeWorkspaceDoc } from './workspace.js'

/** Repository-relative path of the workspace origin sidecar. */
export const DEVICE_REGISTRY_REPO_PATH = 'meta/workspaces.json'

/** Current sidecar schema version. */
export const DEVICE_REGISTRY_VERSION = 1

/**
 * Read the device sidecar from the snapshot repository.
 *
 * @param {string} repoDir snapshot working tree.
 * @returns {Promise<{ version: number, workspaces: Record<string, { originDevice: string, updatedAt?: string }> }>} sidecar document.
 */
export async function readDeviceRegistry(repoDir) {
  const file = joinRepoRelative(repoDir, DEVICE_REGISTRY_REPO_PATH)
  const text = await readFileIfExists(file)
  if (text === null) return emptyDeviceRegistry()
  try {
    const parsed = JSON.parse(text.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.workspaces !== 'object' || parsed.workspaces === null) {
      return emptyDeviceRegistry()
    }
    const workspaces = {}
    for (const [workspacePath, entry] of Object.entries(parsed.workspaces)) {
      if (!entry || typeof entry !== 'object' || !isNonEmptyString(entry.originDevice)) continue
      workspaces[workspacePath] = {
        originDevice: entry.originDevice,
        ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}),
      }
    }
    return { version: DEVICE_REGISTRY_VERSION, workspaces }
  } catch {
    return emptyDeviceRegistry()
  }
}

/**
 * Build an empty sidecar document.
 *
 * @returns {{ version: number, workspaces: Record<string, object> }} empty document.
 */
export function emptyDeviceRegistry() {
  return { version: DEVICE_REGISTRY_VERSION, workspaces: {} }
}

/**
 * Ensure every local workspace path has an origin device, then persist the
 * sidecar into the repository.
 *
 * @param {object} options update options.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.config normalized configuration.
 * @param {import('./paths.js').PathMapper} options.mapper path mapper.
 * @returns {Promise<{ registry: object, changed: boolean, origins: Map<string, string> }>} updated sidecar.
 */
export async function prepareDeviceRegistry(options) {
  const { repoDir, dshHome, config, mapper } = options
  const registry = await readDeviceRegistry(repoDir)
  const localDoc = await readLocalWorkspaceDoc(dshHome)
  let changed = false
  if (localDoc !== null) {
    for (const workspaceRow of listWorkspaces(localDoc)) {
      if (!isNonEmptyString(workspaceRow.path)) continue
      const canonicalPath = mapper.toCanonical(workspaceRow.path)
      if (registry.workspaces[canonicalPath] === undefined) {
        registry.workspaces[canonicalPath] = { originDevice: config.deviceName, updatedAt: new Date().toISOString() }
        changed = true
      }
    }
  }
  if (changed) await writeDeviceRegistry(repoDir, registry)
  return { registry, changed, origins: originMap(registry) }
}

/**
 * Persist the sidecar into the repository.
 *
 * @param {string} repoDir snapshot working tree.
 * @param {object} registry sidecar document.
 * @returns {Promise<void>} resolves after the write.
 */
export async function writeDeviceRegistry(repoDir, registry) {
  const file = joinRepoRelative(repoDir, DEVICE_REGISTRY_REPO_PATH)
  await mkdir(path.dirname(file), { recursive: true })
  await atomicWriteFile(file, Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, 'utf8'))
}

/**
 * Build a canonical-path -> device map from a sidecar document.
 *
 * @param {object} registry sidecar document.
 * @returns {Map<string, string>} canonical path key -> device name.
 */
export function originMap(registry) {
  const map = new Map()
  for (const [workspacePath, entry] of Object.entries(registry.workspaces ?? {})) {
    if (isNonEmptyString(entry?.originDevice)) map.set(pathKey(workspacePath), entry.originDevice)
  }
  return map
}

/**
 * Decorate workspace titles in a document with `· <origin device>`.
 *
 * The input document may be in local or canonical path space; the caller
 * chooses with `canonicalizePath`.
 *
 * @param {object} doc workspace registry document.
 * @param {Map<string, string>} origins canonical path key -> device.
 * @param {{ canonicalizePath?: (value: string) => string, enabled?: boolean }} [options] decoration options.
 * @returns {{ doc: object, changed: boolean }} decorated document.
 */
export function decorateWorkspaceTitles(doc, origins, options = {}) {
  const { canonicalizePath = (value) => value, enabled = true } = options
  const clone = structuredClone(doc)
  const workspaces = clone.tables?.workspaces ?? {}
  let changed = false
  for (const entry of Object.values(workspaces)) {
    if (!entry || typeof entry !== 'object') continue
    if (!isNonEmptyString(entry.path) || !isNonEmptyString(entry.title)) continue
    const canonicalPath = canonicalizePath(entry.path)
    const origin = origins.get(pathKey(canonicalPath))
    if (!enabled || !isNonEmptyString(origin)) continue
    const base = stripDeviceSuffix(entry.title, origin)
    const decorated = `${base} · ${origin}`
    if (entry.title !== decorated) {
      entry.title = decorated
      changed = true
    }
  }
  return { doc: clone, changed }
}

/**
 * Remove our device suffix from a title when present.
 *
 * @param {string} title display title.
 * @param {string} [originDevice] expected origin device.
 * @returns {string} title without our suffix.
 */
export function stripDeviceSuffix(title, originDevice) {
  if (!isNonEmptyString(title)) return title
  if (isNonEmptyString(originDevice)) {
    const suffix = ` · ${originDevice}`
    if (title.endsWith(suffix)) return title.slice(0, -suffix.length)
  }
  // Generic fallback: a short trailing ` · <token>` suffix from an older sync.
  return title.replace(/ · [A-Za-z0-9._-]{1,64}$/u, '')
}

/**
 * Merge two sidecar documents (union by canonical path; local wins conflicts).
 *
 * @param {object | null} localDoc local sidecar.
 * @param {object | null} remoteDoc remote sidecar.
 * @returns {{ doc: object, changed: boolean }} merged sidecar.
 */
export function mergeDeviceRegistries(localDoc, remoteDoc) {
  const local = localDoc ?? emptyDeviceRegistry()
  const remote = remoteDoc ?? emptyDeviceRegistry()
  const workspaces = { ...(remote.workspaces ?? {}) }
  let changed = false
  for (const [workspacePath, entry] of Object.entries(local.workspaces ?? {})) {
    if (!entry || !isNonEmptyString(entry.originDevice)) continue
    const existing = workspaces[workspacePath]
    if (!existing || existing.originDevice !== entry.originDevice) {
      workspaces[workspacePath] = entry
      changed = true
    }
  }
  return {
    doc: { version: DEVICE_REGISTRY_VERSION, workspaces },
    changed: changed || Object.keys(local.workspaces ?? {}).length !== Object.keys(workspaces).length,
  }
}

/**
 * Read the local workspace registry document.
 *
 * @param {string} dshHome resolved harness home.
 * @returns {Promise<object | null>} parsed document or null.
 */
export async function readLocalWorkspaceDoc(dshHome) {
  const text = await readFile(path.join(dshHome, 'storages', 'workspace.json'), 'utf8').catch(() => null)
  return text === null ? null : parseWorkspaceDoc(text)
}

/**
 * Apply decorated titles to the local workspace registry document.
 *
 * @param {object} options apply options.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.config normalized configuration.
 * @param {import('./paths.js').PathMapper} options.mapper path mapper.
 * @param {Map<string, string>} options.origins canonical path key -> device.
 * @returns {Promise<{ changed: boolean, doc: object | null }>} apply result.
 */
export async function applyLocalWorkspaceLabels(options) {
  const { dshHome, config, mapper, origins } = options
  if (config.realtime?.workspaceDeviceLabel === false) return { changed: false, doc: null }
  const doc = await readLocalWorkspaceDoc(dshHome)
  if (doc === null) return { changed: false, doc: null }
  const decorated = decorateWorkspaceTitles(doc, origins, { canonicalizePath: (value) => mapper.toCanonical(value) })
  if (!decorated.changed) return { changed: false, doc }
  const file = path.join(dshHome, 'storages', 'workspace.json')
  await atomicWriteFile(file, Buffer.from(serializeWorkspaceDoc(decorated.doc), 'utf8'))
  return { changed: true, doc: decorated.doc }
}
