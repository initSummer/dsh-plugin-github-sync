/**
 * Unit tests for path mapping, session-log rewriting, workspace merging,
 * patch filtering and configuration loading.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { loadConfig, mergeConfig, defaultConfig, normalizeConfig, readToken, redactRemote } from '../../lib/config.js'
import { encodeSegment, projectKey, PathMapper, pathKey } from '../../lib/paths.js'
import {
  compareSessionLogs,
  encodeZstdFrame,
  readSessionHeaderBytes,
  rewritePathText,
  rewriteSessionBytes,
  scanZstdFrames,
} from '../../lib/sessions.js'
import { decorateWorkspaceTitles, stripDeviceSuffix } from '../../lib/devices.js'
import { mergeWorkspaceDocs, validateWorkspaceDoc, emptyWorkspaceDoc } from '../../lib/workspace.js'
import { filterOwnPatchRows, extractOwnPatchRows, appendPatchRows, splitPatchEntries, mergePatchTexts } from '../../lib/patch.js'
import { initializeConfig } from '../../lib/sync.js'
import { applyRuntimeUpdates } from '../../lib/runtime.js'
import { decodeFrames, decodeHeader, makeScratch, makeSessionBytes, removeScratch } from '../helpers.js'

test('paths: session segment and project keys match the DSH backend', () => {
  assert.equal(encodeSegment('session-66d5e7df'), 'session-66d5e7df')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a b/c'), 'a~0020b~002Fc')
  assert.equal(projectKey('E:\\work_with_yan'), '--E-work_with_yan--')
  assert.equal(projectKey('C:\\Users\\sys_s\\Documents\\x'), '--C-Users-sys_s-Documents-x--')
  assert.equal(projectKey('D:\\wwa'), '--D-wwa--')
  // Separator runs collapse into one dash and are lossy, as in DSH.
  assert.equal(projectKey('E:/work//with'), '--E-work-with--')
})

test('paths: PathMapper maps both directions on the current platform', () => {
  const mapper = new PathMapper([
    { from: 'E:\\work_with_yan', to: 'D:\\wwa' },
    { from: 'E:\\work_with_yan\\sub', to: 'D:\\wwa\\nested' },
  ])
  assert.equal(mapper.toLocal('E:\\work_with_yan\\a.txt'), 'D:\\wwa\\a.txt')
  assert.equal(mapper.toLocal('E:\\work_with_yan\\sub\\b.txt'), 'D:\\wwa\\nested\\b.txt')
  assert.equal(mapper.toCanonical('D:\\wwa\\nested\\b.txt'), 'E:\\work_with_yan\\sub\\b.txt')
  assert.equal(mapper.toLocal('C:\\elsewhere'), 'C:\\elsewhere')
  assert.equal(pathKey('D:\\WWA\\x'), pathKey('D:\\wwa\\x'))
})

test('sessions: frame-preserving rewrite changes header.cwd and keeps frame count', async () => {
  const oldCwd = 'E:\\work_with_yan'
  const newCwd = 'D:\\wwa'
  const id = 'session-test-1'
  const bytes = makeSessionBytes({
    id,
    cwd: oldCwd,
    events: [
      { type: 'tool/result', seq: 0, time: 1, data: { meta: { cwd: oldCwd }, message: { content: [{ type: 'text', text: `读取 ${oldCwd}\\README.md` }] } } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: `Current working directory: "${oldCwd.replaceAll('\\', '\\\\')}"` }] } },
    ],
  })
  const before = scanZstdFrames(bytes)
  assert.equal(before.frames.length, 2)
  const headerBefore = readSessionHeaderBytes(bytes).header
  assert.equal(headerBefore.cwd, oldCwd)

  const result = rewriteSessionBytes(bytes, [{ from: oldCwd, to: newCwd }])
  assert.equal(result.changed, true)
  assert.equal(result.warnings.length, 0)
  const after = scanZstdFrames(result.bytes)
  assert.equal(after.frames.length, before.frames.length, 'frame count is preserved')
  const header = await decodeHeader(result.bytes)
  assert.equal(header.cwd, newCwd)
  const plain = (await decodeFrames(result.bytes)).join('')
  assert.equal(plain.includes(oldCwd), false)
  assert.equal(plain.includes(oldCwd.replaceAll('\\', '\\\\')), false)
  assert.equal(plain.includes(newCwd.replaceAll('\\', '\\\\')), true)
})

test('sessions: plaintext (compression:none) logs are rewritten as text', async () => {
  const oldCwd = 'E:\\work_with_yan'
  const text = `${JSON.stringify({ type: 'session', version: 4, id: 's', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: oldCwd })}\n${JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: { text: oldCwd } })}\n`
  const result = rewriteSessionBytes(Buffer.from(text, 'utf8'), [{ from: oldCwd, to: 'D:\\wwa' }])
  assert.equal(result.changed, true)
  assert.equal(result.bytes.toString('utf8').includes(oldCwd), false)
  assert.equal(result.bytes.toString('utf8').includes('D:\\\\wwa'), true)
})

test('sessions: rewrite refuses invalid framing instead of corrupting the file', () => {
  const headerFrame = encodeZstdFrame(`${JSON.stringify({ type: 'session', version: 4, id: 's', createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: 'E:\\a' })}\n`)
  const tornBody = encodeZstdFrame('{"type":"user/message","seq":0}') // no trailing newline
  const bytes = Buffer.concat([headerFrame, tornBody])
  const result = rewriteSessionBytes(bytes, [{ from: 'E:\\a', to: 'D:\\b' }])
  assert.equal(result.changed, false)
  assert.ok(result.warnings.length > 0)
  assert.deepEqual(result.bytes, bytes)
})

test('sessions: path variants cover raw, escaped and forward-slash spellings', () => {
  const from = 'E:\\work_with_yan'
  const to = 'D:\\wwa'
  const samples = [
    `raw ${from}`,
    `json ${JSON.stringify({ p: from })}`,
    `forward ${from.replaceAll('\\', '/')}`,
    `nested ${JSON.stringify({ p: from.replaceAll('\\', '/') })}`,
    `double ${from.replaceAll('\\', '\\\\')}`,
  ]
  for (const sample of samples) {
    const result = rewritePathText(sample, [{ from, to }])
    assert.equal(result.changed, true, sample)
    assert.equal(result.text.includes('work_with_yan'), false, sample)
    assert.equal(result.text.includes('wwa'), true, sample)
  }
})

test('workspace: merging keeps one record per path, unions sessions and enforces invariants', () => {
  const local = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'local-a',
      workspaceIds: ['local-a', 'local-b'],
      archivedSessionIds: ['s3'],
      pinnedSessionIds: ['s3'],
    },
    tables: {
      workspaces: {
        'local-a': { path: 'D:\\wwa', title: 'wwa', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
        'local-b': { path: 'D:\\other', title: 'other', sessionIds: ['s2'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      },
    },
  }
  const remote = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'remote-a',
      workspaceIds: ['remote-a', 'remote-c'],
      archivedSessionIds: ['s4'],
      pinnedSessionIds: ['s1'],
    },
    tables: {
      workspaces: {
        // Same folder as local-a but a different id: must collapse into local-a.
        'remote-a': { path: 'D:\\wwa', title: 'wwa-remote', sessionIds: ['s1', 's4'], createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        // New workspace only present remotely.
        'remote-c': { path: 'D:\\third', title: 'third', sessionIds: ['s5'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    },
  }
  const { doc, changed } = mergeWorkspaceDocs(local, remote)
  assert.equal(changed, true)
  assert.deepEqual(doc.global.workspaceIds.sort(), ['local-a', 'local-b', 'remote-c'].sort())
  assert.deepEqual(doc.tables.workspaces['local-a'].sessionIds, ['s1', 's4'])
  assert.equal(doc.tables.workspaces['remote-a'], undefined)
  assert.deepEqual(validateWorkspaceDoc(doc), [])
  // s3 was only referenced by local sets but belongs to no workspace after the
  // merge, so it is pruned from both global lists (DSH invariant).
  assert.deepEqual(doc.global.archivedSessionIds, ['s4'])
  assert.equal(doc.global.pinnedSessionIds.includes('s3'), false, 'pinned and archived are disjoint')
})

test('workspace: one session id belongs to exactly one workspace', () => {
  const local = emptyWorkspaceDoc()
  local.global.initialized = true
  local.global.workspaceIds = ['a', 'b']
  local.tables.workspaces = {
    a: { path: 'D:\\a', title: 'a', sessionIds: ['s1'] },
    b: { path: 'D:\\b', title: 'b', sessionIds: ['s1', 's2'] },
  }
  const { doc } = mergeWorkspaceDocs(local, emptyWorkspaceDoc())
  assert.deepEqual(doc.tables.workspaces.a.sessionIds, ['s1'])
  assert.deepEqual(doc.tables.workspaces.b.sessionIds, ['s2'])
  assert.deepEqual(validateWorkspaceDoc(doc), [])
})

test('patch: own rows are stripped on export and re-appended from the local file on import', () => {
  const text = [
    '# user patch',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepseek-account',
    '- id: github-sync',
    '  name: dsh-plugin-github-sync',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n')
  const filtered = filterOwnPatchRows(text)
  assert.equal(filtered.removed, 1)
  assert.equal(filtered.text.includes('github-sync'), false)
  assert.equal(filtered.text.includes('agent-default-model'), true)
  const own = extractOwnPatchRows(text)
  assert.equal(own.length, 1)
  const combined = appendPatchRows(filtered.text, own)
  assert.equal(combined.includes('github-sync'), true)
  assert.equal(combined.includes('agent-default-model'), true)
  assert.equal(splitPatchEntries(combined).entries.length, 2)
})

test('patch: mergePatchTexts never emits a second YAML document', () => {
  const template = '# Your patch layer for this dsh profile.\n# a top-level YAML array\n[]\n'
  const withEntries = '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: deepseek-account\n'
  assert.equal(mergePatchTexts('[]\n', '[]\n'), '[]\n')
  assert.equal(mergePatchTexts(template, template, 'keep-local'), template)
  for (const merged of [
    mergePatchTexts(template, withEntries, 'keep-local'),
    mergePatchTexts(template, withEntries, 'prefer-remote'),
    mergePatchTexts('[]\n', withEntries, 'keep-local'),
  ]) {
    const emptyDocumentMarkers = merged.split(/\r?\n/u).filter((line) => line.trim() === '[]')
    assert.equal(emptyDocumentMarkers.length, 0, `an entry array must not also contain []:\n${merged}`)
    assert.equal(merged.startsWith('# Your patch layer') || merged.trimStart().startsWith('- id:'), true)
    assert.equal(merged.includes('agent-default-model'), true)
  }
  const merged = mergePatchTexts(template, withEntries)
  assert.equal(mergePatchTexts(merged, withEntries), merged, 'idempotent')
})

test('patch: preserving the local preamble comments', () => {
  const local = '# Your patch layer for this dsh profile.\n# Keep this file as a YAML array.\n[]\n'
  const remote = '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: deepseek-account\n'
  const merged = mergePatchTexts(local, remote, 'keep-local')
  assert.equal(merged.startsWith('# Your patch layer'), true, merged)
  assert.equal(merged.includes('agent-default-model'), true)
  const second = mergePatchTexts(merged, remote, 'keep-local')
  assert.equal(second, merged, 'merge is idempotent')
})

test('patch: filtering an empty patch document is idempotent', () => {
  for (const text of ['[]\n', '# comment\n[]\n', '', '- id: other\n  name: other-pkg\n']) {
    const filtered = filterOwnPatchRows(text)
    assert.equal(filtered.removed, 0)
    assert.equal(filtered.text, text)
    assert.equal(filterOwnPatchRows(filtered.text).text, text, 'second pass is stable')
  }
})

test('patch: nested insert blocks keep sibling rows when our row is removed', () => {
  const text = [
    '- insert:',
    '    - id: keep-me',
    '      name: some-package',
    '    - id: github-sync',
    '      name: dsh-plugin-github-sync',
  ].join('\n')
  const filtered = filterOwnPatchRows(text)
  assert.equal(filtered.text.includes('github-sync'), false)
  assert.equal(filtered.text.includes('keep-me'), true)
})

test('init: writes a complete, self-documenting config document', async () => {
  const root = await makeScratch('init')
  try {
    const home = path.join(root, 'home')
    await mkdir(home, { recursive: true })
    const init = await initializeConfig({
      dshHome: home,
      repo: 'https://github.com/me/dsh-sync.git',
      deviceName: 'my-device',
      profileName: 'desktop',
    })
    const parsed = JSON.parse(await readFile(init.file, 'utf8'))
    assert.equal(parsed.repo, 'https://github.com/me/dsh-sync.git')
    assert.equal(parsed.deviceName, 'my-device')
    assert.equal(typeof parsed.$schema, 'string')
    assert.deepEqual(parsed.pathMappings, [])
    assert.equal(parsed.auto.intervalMinutes, 10)
    assert.equal(parsed.scopes.sessions, true)
    assert.equal(parsed.git.tokenEnv, 'DSH_SYNC_GITHUB_TOKEN')
  } finally {
    await removeScratch(root)
  }
})

test('config: layering, token lookup and remote redaction', async () => {
  const root = await makeScratch('config')
  try {
    const home = path.join(root, 'home')
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, 'github-sync.json'), JSON.stringify({
      repo: 'https://github.com/me/dsh-sync.git',
      deviceName: 'machine-a',
      pathMappings: { 'E:\\work': 'D:\\wwa' },
      auto: { intervalMinutes: 3 },
    }), 'utf8')
    const patchConfig = { repo: 'https://github.com/other/repo.git', branch: 'dev', deviceName: 'from-patch' }
    const loaded = await loadConfig({ dshHome: home, patchConfig })
    assert.equal(loaded.config.repo, 'https://github.com/me/dsh-sync.git', 'local JSON wins over patch config')
    assert.equal(loaded.config.branch, 'dev')
    assert.equal(loaded.config.deviceName, 'machine-a')
    assert.equal(loaded.config.auto.intervalMinutes, 3)
    assert.equal(loaded.config.auto.sessionDebounceSeconds, 120)
    assert.deepEqual(loaded.config.pathMappings, [{ from: 'E:\\work', to: 'D:\\wwa' }])

    const token = readToken({ git: { tokenEnv: 'TEST_DSH_TOKEN', fallbackTokenEnvs: [] } }, { TEST_DSH_TOKEN: 'secret' })
    assert.equal(token?.token, 'secret')
    assert.equal(redactRemote('https://user:pass@github.com/me/repo.git').includes('pass'), false)
  } finally {
    await removeScratch(root)
  }
})

test('config: default scopes include settings, sessions, workspaces, skills and attachments', () => {
  const config = normalizeConfig(mergeConfig(defaultConfig({ hostnameValue: 'x' }), {}), { dshHome: 'C:\\x', env: {}, warnings: [] })
  assert.equal(config.scopes.settings, true)
  assert.equal(config.scopes.sessions, true)
  assert.equal(config.scopes.workspaces, true)
  assert.equal(config.scopes.skills, true)
  assert.equal(config.scopes.attachments, true)
  assert.equal(config.scopes.projections, false)
  assert.equal(config.scopes.plugins, false)
  assert.equal(config.onConflict, 'keep-local')
  assert.equal(config.enabled, false, 'no repo means disabled')
  assert.equal(config.realtime.enabled, true)
  assert.equal(config.realtime.intervalSeconds, 3)
  assert.equal(config.realtime.workspaceDeviceLabel, true)
})

test('sessions: compareSessionLogs detects append-only extension and divergence', () => {
  const base = makeSessionBytes({ id: 'session-cmp', cwd: 'E:\\work' })
  const extended = Buffer.concat([
    base,
    encodeZstdFrame(`${JSON.stringify({ type: 'user/message', seq: 9, time: Date.now(), data: { message: { content: [{ type: 'text', text: 'B 追加' }] } } })}\n`),
  ])
  const other = Buffer.concat([
    base,
    encodeZstdFrame(`${JSON.stringify({ type: 'user/message', seq: 9, time: Date.now(), data: { message: { content: [{ type: 'text', text: 'A 追加' }] } } })}\n`),
  ])
  assert.equal(compareSessionLogs(base, extended).relation, 'left-prefix')
  assert.equal(compareSessionLogs(extended, base).relation, 'right-prefix')
  assert.equal(compareSessionLogs(extended, extended).relation, 'equal')
  const diverged = compareSessionLogs(extended, other)
  assert.equal(diverged.relation, 'diverged')
  assert.ok(diverged.commonEvents >= 0)
})

test('runtime: hot-applies workspaces and emits client session events', async () => {
  const calls = []
  const emitted = []
  const entity = {
    id: 'w-new',
    path: 'E:\\wwa',
    title: 'wwa · device-a',
    sessionIds: [],
    attachSession: async (sessionId) => { calls.push(['attach', sessionId]) },
    setTitle: async (title) => { calls.push(['title', title]) },
  }
  const registry = {
    list: () => [],
    create: async (workspacePath, title) => {
      calls.push(['create', workspacePath, title])
      return entity
    },
  }
  const sessionController = {
    list: async () => [{
      sessionId: 'session-imported',
      updatedAt: 42,
      running: false,
      blank: false,
      agentAvailable: false,
    }],
  }
  const ctx = {
    get: (name) => ({ workspaceRegistry: registry, sessionController })[name],
    emit: (name, ...args) => { emitted.push([name, ...args]) },
  }
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w-new', workspaceIds: ['w-new'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'w-new': {
          path: 'E:\\wwa',
          title: 'wwa · device-a',
          sessionIds: ['session-imported'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  const applied = await applyRuntimeUpdates({
    ctx,
    config: { deviceName: 'b', realtime: { workspaceDeviceLabel: true } },
    dshHome: 'C:\\x',
    result: {
      workspaceChanged: true,
      localWorkspaceDoc: doc,
      newSessionIds: ['session-imported'],
      updatedSessionIds: [],
      deletedSessionIds: ['session-gone'],
      sessionSummaries: {},
    },
  })
  assert.equal(applied.applied, true)
  assert.deepEqual(calls[0], ['create', 'E:\\wwa', 'wwa · device-a'])
  assert.ok(calls.some((call) => call[0] === 'attach' && call[1] === 'session-imported'))
  assert.ok(emitted.some(([name, summary]) => name === 'api-session/added' && summary.sessionId === 'session-imported'))
  assert.ok(emitted.some(([name, id]) => name === 'api-session/removed' && id === 'session-gone'))
})

test('devices: workspace titles are decorated with and stripped of the origin device', () => {
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'a', workspaceIds: ['a'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { a: { path: 'E:\\wwa', title: 'wwa', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } },
  }
  const origins = new Map([[pathKey('E:\\wwa'), 'jackfruit']])
  const decorated = decorateWorkspaceTitles(doc, origins, { canonicalizePath: (value) => value })
  assert.equal(decorated.changed, true)
  assert.equal(decorated.doc.tables.workspaces.a.title, 'wwa · jackfruit')
  assert.equal(stripDeviceSuffix('wwa · jackfruit', 'jackfruit'), 'wwa')
  const again = decorateWorkspaceTitles(decorated.doc, origins, { canonicalizePath: (value) => value })
  assert.equal(again.changed, false, 'decoration is idempotent')
  assert.equal(decorateWorkspaceTitles(decorated.doc, origins, { canonicalizePath: (value) => value, enabled: false }).doc.tables.workspaces.a.title, 'wwa · jackfruit')
})
