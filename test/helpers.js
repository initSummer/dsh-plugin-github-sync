/**
 * Shared test fixtures for dsh-plugin-github-sync.
 *
 * Everything is created under `<repo>/.tmp-tests/` so tests never touch a real
 * DSH home.
 *
 * @module dsh-plugin-github-sync/test/helpers
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defaultConfig, mergeConfig, normalizeConfig } from '../lib/config.js'
import { configPath, encodeSegment, projectKey } from '../lib/paths.js'
import { encodeZstdFrame, scanZstdFrames } from '../lib/sessions.js'
import { atomicWriteFile } from '../lib/fsutil.js'
import { runGit } from '../lib/git.js'
import { serializeWorkspaceDoc } from '../lib/workspace.js'

/** Repository root. */
export const repoRoot = path.resolve(import.meta.dirname, '..')

/** Scratch root for one test run. */
export const scratchRoot = path.join(repoRoot, '.tmp-tests')

/**
 * Create a fresh scratch directory.
 *
 * @param {string} label directory label.
 * @returns {Promise<string>} absolute directory.
 */
export async function makeScratch(label) {
  await mkdir(scratchRoot, { recursive: true })
  const directory = path.join(scratchRoot, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(directory, { recursive: true })
  return directory
}

/**
 * Remove a scratch directory.
 *
 * @param {string} directory absolute path.
 * @returns {Promise<void>} resolves after removal.
 */
export async function removeScratch(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
}

/**
 * Run git in a directory (uses the plugin's sandbox-aware wrapper).
 *
 * @param {string} cwd working directory.
 * @param {string[]} args git arguments.
 * @returns {Promise<{ stdout: string, stderr: string }>} command output.
 */
export async function git(cwd, args) {
  const result = await runGit({ cwd, gitPath: 'git', args })
  return { stdout: result.stdout, stderr: result.stderr }
}

/**
 * Create a bare repository to act as the GitHub remote.
 *
 * @param {string} root scratch root.
 * @returns {Promise<string>} bare repository path.
 */
export async function makeBareRemote(root) {
  const directory = path.join(root, 'remote.git')
  await mkdir(directory, { recursive: true })
  await git(directory, ['init', '--bare', '-b', 'main'])
  return directory
}

/**
 * Build the bytes of a valid v4 session log (header frame + one event frame).
 *
 * @param {{ id: string, cwd: string | null, events?: object[], createdAt?: number }} options session fields.
 * @returns {Buffer} session log bytes.
 */
export function makeSessionBytes(options) {
  const { id, cwd, events = defaultEvents(), createdAt = Date.now() } = options
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  if (typeof cwd === 'string') header.cwd = cwd
  const headerFrame = encodeZstdFrame(`${JSON.stringify(header)}\n`)
  const bodyFrame = encodeZstdFrame(events.map((event) => `${JSON.stringify(event)}\n`).join(''))
  return Buffer.concat([headerFrame, bodyFrame])
}

/**
 * Default event list for fixtures.
 *
 * @returns {object[]} events.
 */
export function defaultEvents() {
  return [
    { type: 'permission/preset', seq: 0, time: Date.now(), data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, time: Date.now(), data: { mode: 'workspace-write' } },
    {
      type: 'user/message',
      seq: 2,
      time: Date.now(),
      data: { message: { content: [{ type: 'text', text: '请处理工作区里的文件' }] } },
    },
  ]
}

/**
 * Write a session log into a home's sessions tree, following DSH's layout.
 *
 * @param {string} home harness home.
 * @param {{ id: string, cwd: string | null, events?: object[], bytes?: Buffer }} options session fields.
 * @returns {Promise<string>} absolute session log path.
 */
export async function writeSession(home, options) {
  const bytes = options.bytes ?? makeSessionBytes(options)
  const projectDirectory = options.cwd === null ? '_no-cwd' : projectKey(options.cwd)
  const directory = path.join(home, 'sessions', projectDirectory, encodeSegment(options.id))
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'session.v4.jsonl.zstd')
  await writeFile(file, bytes)
  return file
}

/**
 * Read a session log from a home.
 *
 * @param {string} home harness home.
 * @param {{ id: string, cwd: string | null }} options session lookup fields.
 * @returns {Promise<Buffer>} session bytes.
 */
export async function readSession(home, options) {
  const projectDirectory = options.cwd === null ? '_no-cwd' : projectKey(options.cwd)
  return readFile(path.join(home, 'sessions', projectDirectory, encodeSegment(options.id), 'session.v4.jsonl.zstd'))
}

/**
 * Append one event frame to an existing session log (simulates continuing a
 * conversation).
 *
 * @param {string} home harness home.
 * @param {{ id: string, cwd: string | null }} options session lookup fields.
 * @param {object} event event to append.
 * @returns {Promise<void>} resolves after appending.
 */
export async function appendSessionEvent(home, options, event) {
  const file = path.join(home, 'sessions', projectKey(options.cwd), encodeSegment(options.id), 'session.v4.jsonl.zstd')
  const bytes = await readFile(file)
  const { frames } = scanZstdFrames(bytes)
  const last = frames[frames.length - 1]
  const appended = encodeZstdFrame(`${JSON.stringify(event)}\n`)
  await writeFile(file, Buffer.concat([bytes.subarray(0, last.end), appended, bytes.subarray(last.end)]))
}

/**
 * Write `storages/workspace.json`.
 *
 * @param {string} home harness home.
 * @param {{ workspaces: Array<{ id: string, path: string, title?: string, sessionIds?: string[] }>, defaultWorkspaceId?: string }} options registry data.
 * @returns {Promise<string>} absolute registry path.
 */
export async function writeRegistry(home, options) {
  /** @type {Record<string, object>} */
  const workspaces = {}
  for (const workspace of options.workspaces) {
    workspaces[workspace.id] = {
      path: workspace.path,
      title: workspace.title ?? path.basename(workspace.path),
      sessionIds: workspace.sessionIds ?? [],
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    }
  }
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: options.defaultWorkspaceId ?? options.workspaces[0]?.id,
      workspaceIds: options.workspaces.map((workspace) => workspace.id),
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: { workspaces },
  }
  const file = path.join(home, 'storages', 'workspace.json')
  await atomicWriteFile(file, Buffer.from(serializeWorkspaceDoc(doc), 'utf8'))
  return file
}

/**
 * Read `storages/workspace.json`.
 *
 * @param {string} home harness home.
 * @returns {Promise<object>} parsed registry.
 */
export async function readRegistry(home) {
  return JSON.parse(await readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
}

/**
 * Write a profile patch file into a home.
 *
 * @param {string} home harness home.
 * @param {string} text patch content.
 * @param {string} [profileName] profile name.
 * @returns {Promise<string>} absolute file path.
 */
export async function writeProfilePatch(home, text, profileName = 'desktop') {
  const directory = path.join(home, 'profiles', profileName)
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'cordis.patch.yml')
  await writeFile(file, text, 'utf8')
  return file
}

/**
 * Build a normalized plugin configuration for tests.
 *
 * @param {string} home harness home.
 * @param {object} overrides configuration overrides.
 * @returns {object} normalized configuration.
 */
export function makeConfig(home, overrides) {
  const warnings = []
  const merged = mergeConfig(defaultConfig({ hostnameValue: overrides.deviceName ?? 'test-device' }), {
    repo: '',
    profileName: 'desktop',
    ...overrides,
  })
  return normalizeConfig(merged, { dshHome: home, env: {}, warnings })
}

/**
 * Write the machine-local config file.
 *
 * @param {string} home harness home.
 * @param {object} config normalized configuration.
 * @returns {Promise<string>} path written.
 */
export async function writeConfigFile(home, config) {
  const file = configPath(home)
  await atomicWriteFile(file, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'))
  return file
}

/**
 * Decode every frame of a session log into plaintext.
 *
 * @param {Buffer} bytes session log bytes.
 * @returns {Promise<string[]>} per-frame plaintext.
 */
export async function decodeFrames(bytes) {
  const { zstdDecompressSync } = await import('node:zlib')
  const { frames } = scanZstdFrames(bytes)
  return frames.map((frame) => zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8'))
}

/**
 * Decode a session header from bytes.
 *
 * @param {Buffer} bytes session log bytes.
 * @returns {Promise<object>} header object.
 */
export async function decodeHeader(bytes) {
  const [first] = await decodeFrames(bytes)
  return JSON.parse(first.split('\n')[0])
}
