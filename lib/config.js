/**
 * Configuration loading, validation and defaults for the DSH GitHub sync
 * plugin.
 *
 * The authoritative, machine-local configuration file is
 * `$DSH_HOME/github-sync.json`. It is intentionally NOT synchronized: every
 * device needs its own device name, path mappings and (optionally) token
 * environment variable name. Values supplied through the DSH profile patch row
 * (`config:` in `cordis.patch.yml`) are merged on top as defaults, so a fresh
 * install can be configured either way.
 *
 * @module dsh-plugin-github-sync/config
 */

import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { configPath, isNonEmptyString, normalizeMappings, normalizePath } from './paths.js'

/** Current configuration schema version. */
export const CONFIG_VERSION = 1

/** Repository-relative prefixes this plugin manages inside the snapshot repo. */
export const MANAGED_PREFIXES = Object.freeze({
  home: 'home/',
  profile: 'profiles/',
  sessions: 'home/sessions/',
})

/** All synchronization scopes, with human-readable labels (Chinese first). */
export const SCOPE_LABELS = Object.freeze({
  settings: '设置（storages 设置域、home/profile 的 cordis.patch.yml）',
  sessions: '对话记录（sessions/**）',
  workspaces: '工作区注册表（storages/workspace.json）',
  skills: '技能与全局 Agent 指令（skills/**、AGENTS.md）',
  attachments: '附件（attachments/**）',
  market: '插件市场源（storages/community_market/**）',
  projections: '会话投影缓存（storages/session_projcache/**，可重建）',
  plugins: '插件清单（profile 的 package.json / pnpm-lock.yaml）',
})

/**
 * Create a fresh default configuration object.
 *
 * @param {{ dshHome?: string, hostnameValue?: string }} [options] environment overrides.
 * @returns {object} default configuration.
 */
export function defaultConfig(options = {}) {
  const device = options.hostnameValue ?? hostname()
  return {
    $schema: 'https://github.com/deepseek-harness/dsh-plugin-github-sync#configuration',
    version: CONFIG_VERSION,
    enabled: true,
    repo: '',
    branch: 'main',
    remoteName: 'origin',
    deviceName: sanitizeDeviceName(device) || 'device',
    profileName: 'desktop',
    auto: {
      startup: true,
      intervalMinutes: 10,
      sessionDebounceSeconds: 120,
    },
    realtime: {
      enabled: true,
      intervalSeconds: 3,
      idleIntervalSeconds: 15,
      activeWindowSeconds: 90,
      pushDebounceSeconds: 2,
      workspaceDeviceLabel: true,
      mergeAppendOnlySessions: true,
    },
    scopes: {
      settings: true,
      sessions: true,
      workspaces: true,
      skills: true,
      attachments: true,
      market: true,
      projections: false,
      plugins: false,
    },
    pathMappings: [],
    rewriteSessionPaths: true,
    createMissingWorkspaceDirs: true,
    onConflict: 'keep-local',
    backup: {
      enabled: true,
      keepDays: 30,
    },
    limits: {
      maxFileMB: 100,
      maxTotalMB: 4096,
      maxSessions: 0,
    },
    excludeSessionIds: [],
    excludeWorkspacePaths: [],
    git: {
      path: 'git',
      timeoutMs: 180000,
      tokenEnv: 'DSH_SYNC_GITHUB_TOKEN',
      fallbackTokenEnvs: ['GH_TOKEN', 'GITHUB_TOKEN'],
      batchMode: true,
      authorName: 'DSH GitHub Sync',
      authorEmail: 'dsh-sync@localhost',
    },
    commit: {
      messagePrefix: 'dsh-sync',
    },
  }
}

/**
 * Load and validate the effective configuration.
 *
 * @param {{ dshHome: string, patchConfig?: object | undefined, env?: NodeJS.ProcessEnv }} options loader inputs.
 * @returns {Promise<{ config: object, warnings: string[], configFile: string, exists: boolean }>} effective config.
 */
export async function loadConfig(options) {
  const { dshHome, patchConfig, env = process.env } = options
  const file = configPath(dshHome)
  /** @type {object} */
  let fileConfig = {}
  let exists = false
  try {
    const text = await readFile(file, 'utf8')
    fileConfig = JSON.parse(stripBom(text))
    exists = true
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw new Error(`无法读取配置文件 ${file}: ${error.message}`, { cause: error })
    }
  }
  const merged = mergeConfig(defaultConfig({ dshHome }), patchConfig, fileConfig)
  const warnings = []
  const config = normalizeConfig(merged, { dshHome, env, warnings })
  return { config, warnings, configFile: file, exists }
}

/**
 * Merge config layers: defaults <- profile patch row <- local JSON file.
 * Arrays replace instead of concatenating; plain objects merge recursively.
 *
 * @param {...(object | undefined)} layers configuration layers.
 * @returns {object} merged plain object (new instance).
 */
export function mergeConfig(...layers) {
  const result = {}
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue
    for (const [key, value] of Object.entries(layer)) {
      if (isPlainObject(value) && isPlainObject(result[key])) result[key] = mergeConfig(result[key], value)
      else result[key] = value
    }
  }
  return result
}

/**
 * Validate and canonicalize a merged configuration object.
 *
 * @param {object} input merged configuration.
 * @param {{ dshHome: string, env: NodeJS.ProcessEnv, warnings: string[] }} context validation context.
 * @returns {object} validated configuration.
 */
export function normalizeConfig(input, context) {
  const warnings = context.warnings ?? []
  const config = structuredClone(input)

  config.enabled = config.enabled !== false
  config.repo = isNonEmptyString(config.repo) ? config.repo.trim() : ''
  config.branch = isNonEmptyString(config.branch) ? config.branch.trim() : 'main'
  config.remoteName = isNonEmptyString(config.remoteName) ? config.remoteName.trim() : 'origin'
  config.deviceName = sanitizeDeviceName(config.deviceName) || sanitizeDeviceName(hostname()) || 'device'
  config.profileName = isNonEmptyString(config.profileName) ? config.profileName.trim() : 'desktop'
  config.pathMappings = normalizeMappings(config.pathMappings)
  config.rewriteSessionPaths = config.rewriteSessionPaths !== false
  config.createMissingWorkspaceDirs = config.createMissingWorkspaceDirs !== false
  config.onConflict = normalizeConflictPolicy(config.onConflict, warnings)

  config.auto = {
    startup: config.auto?.startup !== false,
    intervalMinutes: coerceNumber(config.auto?.intervalMinutes, 10, 0, 24 * 60),
    sessionDebounceSeconds: coerceNumber(config.auto?.sessionDebounceSeconds, 120, 0, 3600),
  }
  config.realtime = {
    enabled: config.realtime?.enabled !== false,
    intervalSeconds: coerceNumber(config.realtime?.intervalSeconds, 3, 1, 3600),
    idleIntervalSeconds: coerceNumber(config.realtime?.idleIntervalSeconds, 15, 1, 3600),
    activeWindowSeconds: coerceNumber(config.realtime?.activeWindowSeconds, 90, 5, 3600),
    pushDebounceSeconds: coerceNumber(config.realtime?.pushDebounceSeconds, 2, 0, 600),
    workspaceDeviceLabel: config.realtime?.workspaceDeviceLabel !== false,
    mergeAppendOnlySessions: config.realtime?.mergeAppendOnlySessions !== false,
  }
  config.scopes = normalizeScopes(config.scopes, warnings)
  config.backup = {
    enabled: config.backup?.enabled !== false,
    keepDays: coerceNumber(config.backup?.keepDays, 30, 1, 3650),
  }
  config.limits = {
    maxFileMB: coerceNumber(config.limits?.maxFileMB, 100, 0.1, 4096),
    maxTotalMB: coerceNumber(config.limits?.maxTotalMB, 4096, 1, 1024 * 1024),
    maxSessions: coerceNumber(config.limits?.maxSessions, 0, 0, 1_000_000),
  }
  config.excludeSessionIds = toStringArray(config.excludeSessionIds)
  config.excludeWorkspacePaths = toStringArray(config.excludeWorkspacePaths).map((value) => normalizePath(value))

  config.git = {
    path: isNonEmptyString(config.git?.path) ? config.git.path.trim() : 'git',
    timeoutMs: coerceNumber(config.git?.timeoutMs, 180000, 5000, 3600000),
    tokenEnv: isNonEmptyString(config.git?.tokenEnv) ? config.git.tokenEnv.trim() : 'DSH_SYNC_GITHUB_TOKEN',
    fallbackTokenEnvs: toStringArray(config.git?.fallbackTokenEnvs),
    batchMode: config.git?.batchMode !== false,
    authorName: isNonEmptyString(config.git?.authorName) ? config.git.authorName : 'DSH GitHub Sync',
    authorEmail: isNonEmptyString(config.git?.authorEmail) ? config.git.authorEmail : 'dsh-sync@localhost',
  }
  config.commit = {
    messagePrefix: isNonEmptyString(config.commit?.messagePrefix) ? config.commit.messagePrefix : 'dsh-sync',
  }

  if (config.enabled && !config.repo) {
    warnings.push('尚未配置同步仓库（repo）。插件已加载，但自动同步会跳过；请编辑 $DSH_HOME/github-sync.json 设置 repo。')
  }
  if (!config.repo) config.enabled = false
  return config
}

/**
 * Normalize the conflict policy value.
 *
 * @param {unknown} value raw value.
 * @param {string[]} warnings warning sink.
 * @returns {'keep-local' | 'prefer-remote' | 'fail'} normalized policy.
 */
export function normalizeConflictPolicy(value, warnings = []) {
  if (value === 'prefer-remote' || value === 'remote') return 'prefer-remote'
  if (value === 'fail') return 'fail'
  if (value !== undefined && value !== 'keep-local' && value !== 'local') {
    warnings.push(`未知的 onConflict 值 ${JSON.stringify(value)}，已回退为 keep-local。`)
  }
  return 'keep-local'
}

/**
 * Normalize the scope map, filling defaults for omitted keys.
 *
 * @param {unknown} value raw scopes.
 * @param {string[]} warnings warning sink.
 * @returns {Record<string, boolean>} normalized scopes.
 */
export function normalizeScopes(value, warnings = []) {
  const known = Object.keys(SCOPE_LABELS)
  const defaults = defaultConfig().scopes
  /** @type {Record<string, boolean>} */
  const result = {}
  for (const key of known) result[key] = value && typeof value === 'object' && key in value ? value[key] === true : defaults[key]
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) warnings.push(`未知的同步范围 scopes.${key} 将被忽略。`)
    }
  }
  if (result.sessions !== true && result.workspaces === true) {
    // Not an error, but sessions without their registry are rarely useful.
    warnings.push('sessions 范围已关闭但 workspaces 仍开启：远端工作区可能指向缺失的会话。')
  }
  return result
}

/**
 * Read a GitHub token from the configured environment variables.
 *
 * @param {object} config normalized configuration.
 * @param {NodeJS.ProcessEnv} [env] environment mapping.
 * @returns {{ token: string, variable: string } | null} token and its source variable.
 */
export function readToken(config, env = process.env) {
  const names = [config.git?.tokenEnv, ...(config.git?.fallbackTokenEnvs ?? [])].filter(isNonEmptyString)
  for (const name of names) {
    const value = env[name]
    if (isNonEmptyString(value)) return { token: value.trim(), variable: name }
  }
  return null
}

/**
 * Produce a redacted form of a git remote URL for display and error messages.
 *
 * @param {string} url remote URL.
 * @returns {string} URL without embedded credentials.
 */
export function redactRemote(url) {
  if (!isNonEmptyString(url)) return ''
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      parsed.username = '***'
      parsed.password = ''
      return parsed.toString().replace('***@', '***@')
    }
    return url
  } catch {
    return url.replace(/(https?:\/\/)[^@/\s]+@/i, '$1***@')
  }
}

/**
 * Strip a UTF-8 byte order mark.
 *
 * @param {string} text file content.
 * @returns {string} content without BOM.
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Sanitize a device name so it is safe inside commit messages and state files.
 *
 * @param {unknown} value raw device name.
 * @returns {string} sanitized name.
 */
export function sanitizeDeviceName(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

/**
 * @param {unknown} value candidate.
 * @returns {boolean} whether the value is a plain object.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value raw number-like value.
 * @param {number} fallback default.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {number} coerced number.
 */
function coerceNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * @param {unknown} value raw value.
 * @returns {string[]} string values only.
 */
function toStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}
