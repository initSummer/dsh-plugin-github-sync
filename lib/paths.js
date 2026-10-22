/**
 * Path helpers shared by the DSH GitHub sync engine.
 *
 * The module is dependency-free so the plugin can be installed as a plain ESM
 * package inside a DSH profile without pulling anything from npm.
 *
 * @module dsh-plugin-github-sync/paths
 */

import { homedir } from 'node:os'
import path from 'node:path'

/** Directory name of the default DeepSeek Harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Environment variable that overrides the default DSH home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Name of the machine-local config file kept inside `$DSH_HOME`. */
export const CONFIG_FILE_NAME = 'github-sync.json'

/** Sub-directory of `$DSH_HOME` that holds the plugin's own state. */
export const SYNC_DIR_NAME = 'github-sync'

/**
 * Resolve the DSH home directory.
 *
 * Precedence (highest first): explicit argument, `$DSH_HOME`, `~/.dsh`.
 * Mirrors `@deepseek-ai/dsh-home-paths` semantics so the plugin works in
 * profiles that override the home.
 *
 * @param {string | undefined} configured explicit path.
 * @param {NodeJS.ProcessEnv} [env] environment mapping.
 * @returns {string} normalized absolute home directory.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env[DSH_HOME_ENV]
  const chosen =
    isNonEmptyString(configured) ? configured
      : isNonEmptyString(fromEnv) ? fromEnv
        : path.join(homedir(), DSH_HOME_DIR_NAME)
  return path.resolve(expandHomePath(chosen))
}

/**
 * Expand a leading `~`, `~/` or `~\` prefix against the OS home.
 *
 * @param {string} value candidate path.
 * @returns {string} expanded path (unchanged when no prefix is present).
 */
export function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  return value
}

/**
 * Whether a value is a non-empty, non-whitespace string.
 *
 * @param {unknown} value candidate.
 * @returns {boolean} true when it is a usable string.
 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Build the plugin's own data directory below the harness home.
 *
 * @param {string} dshHome resolved harness home.
 * @param {...string} segments additional segments.
 * @returns {string} absolute path.
 */
export function syncPath(dshHome, ...segments) {
  return path.join(dshHome, SYNC_DIR_NAME, ...segments)
}

/**
 * Build the path of the snapshot git working tree.
 *
 * @param {string} dshHome resolved harness home.
 * @returns {string} absolute path of the snapshot repository.
 */
export function repoPath(dshHome) {
  return syncPath(dshHome, 'repo')
}

/**
 * Build the path of the plugin state file.
 *
 * @param {string} dshHome resolved harness home.
 * @returns {string} absolute path.
 */
export function statePath(dshHome) {
  return syncPath(dshHome, 'state.json')
}

/**
 * Build the path of the machine-local config file.
 *
 * @param {string} dshHome resolved harness home.
 * @returns {string} absolute path.
 */
export function configPath(dshHome) {
  return path.join(dshHome, CONFIG_FILE_NAME)
}

/**
 * Encode one arbitrary string as a single safe filesystem path segment.
 *
 * This is the exact escape used by `@deepseek-ai/dsh-session-persistence-jsonl`
 * (`encodeSegment`): `[A-Za-z0-9._-]` is kept literally and every other UTF-16
 * code unit becomes `~XXXX` (upper-case hex).
 *
 * @param {string} raw raw identifier.
 * @returns {string} encoded path segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string') throw new TypeError('encodeSegment requires a string')
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Decode a path segment produced by {@link encodeSegment}.
 *
 * Only the `~XXXX` escapes are reversed; lossy project keys are never decoded.
 *
 * @param {string} segment encoded segment.
 * @returns {string} decoded identifier.
 */
export function decodeSegment(segment) {
  return segment.replace(/~([0-9A-Fa-f]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * Build the readable project-directory key for a workspace path.
 *
 * Mirrors `projectKey()` of the JSONL session backend: filesystem and drive
 * separators collapse into one `-`, unsafe code units use the `~XXXX` escape,
 * leading separators are stripped, the name is bounded to 251 characters and
 * wrapped in `--`. The mapping is intentionally lossy, so the session header's
 * `cwd` (not the directory name) is the authoritative workspace path.
 *
 * @param {string} cwd absolute workspace path.
 * @returns {string} a single filesystem-safe directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Normalize a path for equality comparison (Windows is case-insensitive).
 *
 * @param {string} value raw path.
 * @returns {string} comparison key.
 */
export function pathKey(value) {
  let normalized = path.normalize(value)
  if (normalized.length > 1) normalized = normalized.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Ensure the value uses the platform separator and has no trailing separator.
 *
 * @param {string} value raw path.
 * @returns {string} normalized absolute-looking path.
 */
export function normalizePath(value) {
  let normalized = path.normalize(expandHomePath(value))
  if (normalized.length > 1) normalized = normalized.replace(/[\\/]+$/, '')
  return normalized
}

/**
 * Replace path prefixes between a repository-canonical path space and the
 * local machine path space.
 *
 * Mapping entries have the shape `{ from, to }` where `from` is the path as
 * stored in the repository (the canonical path, usually the path used by the
 * first device) and `to` is the path on this device. A plain object
 * `{ "<from>": "<to>" }` is accepted as well.
 */
export class PathMapper {
  /**
   * @param {Array<{from: string, to: string}> | Record<string, string> | undefined} mappings configured mappings.
   */
  constructor(mappings) {
    /** @type {Array<{from: string, to: string, fromKey: string}>} */
    this.entries = normalizeMappings(mappings).map((entry) => ({
      from: entry.from,
      to: entry.to,
      fromKey: pathKey(entry.from),
    }))
    // Longest prefix first so nested mappings win over their parents.
    this.entries.sort((a, b) => b.from.length - a.from.length)
  }

  /** @returns {boolean} whether any mapping is configured. */
  get active() {
    return this.entries.length > 0
  }

  /**
   * Map a repository-canonical path to this device.
   *
   * @param {string} value canonical path.
   * @returns {string} local path (unchanged when no mapping applies).
   */
  toLocal(value) {
    return this.#replace(value, 'to')
  }

  /**
   * Map a local path back to the repository-canonical path space.
   *
   * @param {string} value local path.
   * @returns {string} canonical path (unchanged when no mapping applies).
   */
  toCanonical(value) {
    return this.#replace(value, 'from')
  }

  /**
   * Replace a prefix in either direction.
   *
   * @param {string} value path to rewrite.
   * @param {'to' | 'from'} target side.
   * @returns {string} rewritten path.
   */
  #replace(value, target) {
    if (typeof value !== 'string' || value.length === 0) return value
    const sourceKey = process.platform === 'win32' ? value.toLowerCase() : value
    for (const entry of this.entries) {
      const sourcePrefix = target === 'to' ? entry.fromKey : pathKey(entry.to)
      if (sourceKey === sourcePrefix) return target === 'to' ? entry.to : entry.from
      if (!sourceKey.startsWith(sourcePrefix)) continue
      const rest = value.slice(sourcePrefix.length)
      if (rest.length > 0 && rest[0] !== '/' && rest[0] !== '\\') continue
      const prefix = target === 'to' ? entry.to : entry.from
      return prefix + rest
    }
    return value
  }
}

/**
 * Normalize the accepted mapping shapes into a list.
 *
 * @param {Array<{from: string, to: string}> | Record<string, string> | undefined} mappings raw value.
 * @returns {Array<{from: string, to: string}>} normalized entries with absolute local paths.
 */
export function normalizeMappings(mappings) {
  if (mappings === undefined || mappings === null) return []
  /** @type {Array<{from: unknown, to: unknown}>} */
  let raw = []
  if (Array.isArray(mappings)) raw = mappings
  else if (typeof mappings === 'object') raw = Object.entries(mappings).map(([from, to]) => ({ from, to }))
  else throw new TypeError('pathMappings must be an array of {from,to} or an object map')
  const result = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') throw new TypeError('pathMappings entries must be objects')
    const from = entry.from
    const to = entry.to
    if (!isNonEmptyString(from) || !isNonEmptyString(to)) throw new TypeError('pathMappings entries need non-empty "from" and "to" strings')
    result.push({ from: normalizePath(from), to: normalizePath(to) })
  }
  return result
}

/**
 * Join a POSIX-style relative path (as used inside the snapshot repository)
 * onto an absolute base directory.
 *
 * @param {string} base absolute base directory.
 * @param {string} relative repository-relative path using `/` separators.
 * @returns {string} absolute path.
 */
export function joinRepoRelative(base, relative) {
  return path.join(base, ...relative.split('/').filter((segment) => segment.length > 0))
}
