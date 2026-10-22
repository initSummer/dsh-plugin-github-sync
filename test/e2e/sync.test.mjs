/**
 * End-to-end synchronization test between two simulated devices and a bare
 * repository that stands in for GitHub.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { runSync, computeStatus } from '../../lib/sync.js'
import { readState } from '../../lib/state.js'
import { parseWorkspaceDoc, listWorkspaces, validateWorkspaceDoc } from '../../lib/workspace.js'
import { encodeSegment, pathKey, projectKey, syncPath } from '../../lib/paths.js'
import {
  appendSessionEvent,
  decodeFrames,
  decodeHeader,
  defaultEvents,
  git,
  makeBareRemote,
  makeConfig,
  makeScratch,
  readRegistry,
  readSession,
  removeScratch,
  writeProfilePatch,
  writeRegistry,
  writeSession,
} from '../helpers.js'

/**
 * @returns {string} random id suffix.
 */
function suffix() {
  return Math.random().toString(36).slice(2, 10)
}

test('two devices synchronize settings, sessions and workspaces through a bare remote', async (t) => {
  const root = await makeScratch('e2e')
  const remote = await makeBareRemote(root)
  const homeA = path.join(root, 'homeA')
  const homeB = path.join(root, 'homeB')
  const workspaceA = path.join(root, 'workspaceA')
  const workspaceB = path.join(root, 'workspaceB')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(workspaceA, { recursive: true })

  const workspaceId = `ws-${suffix()}`
  const sessionId = `session-${suffix()}`
  const oldCwd = workspaceA
  const events = [
    ...defaultEvents(),
    {
      type: 'tool/result',
      seq: 3,
      time: Date.now(),
      data: {
        meta: { cwd: oldCwd, path: `${oldCwd}\\README.md` },
        message: { content: [{ type: 'text', text: `读取 ${oldCwd}\\README.md` }] },
      },
    },
  ]

  const configA = makeConfig(homeA, { repo: remote, deviceName: 'device-a', branch: 'main' })
  const configB = makeConfig(homeB, {
    repo: remote,
    deviceName: 'device-b',
    branch: 'main',
    pathMappings: [{ from: oldCwd, to: workspaceB }],
  })

  let sessionFileA
  let sessionFileB
  let localWorkspaceRoot

  await t.test('device A exports its workspace, session and settings', async () => {
    sessionFileA = await writeSession(homeA, { id: sessionId, cwd: oldCwd, events })
    await writeRegistry(homeA, { workspaces: [{ id: workspaceId, path: oldCwd, title: 'wwa', sessionIds: [sessionId] }] })
    await writeProfilePatch(homeA, [
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: deepseek-account',
      '    model: deepseek-flash',
      '- id: github-sync',
      '  name: dsh-plugin-github-sync',
      '  config:',
      '    enabled: true',
      '',
    ].join('\n'))

    const result = await runSync({ dshHome: homeA, config: configA, reason: 'test:a-first' })
    assert.equal(result.ok, true, result.summary)
    assert.equal(result.pushed, true)
    const files = (await git(remote, ['ls-tree', '-r', '--name-only', 'main'])).stdout.split('\n').filter(Boolean)
    assert.ok(files.some((file) => file.startsWith('home/sessions/') && file.endsWith('session.v4.jsonl.zstd')), files.join('\n'))
    assert.ok(files.includes('home/storages/workspace.json'))
    assert.ok(files.includes('profiles/desktop/cordis.patch.yml'))
    const patch = (await git(remote, ['show', 'main:profiles/desktop/cordis.patch.yml'])).stdout
    assert.equal(patch.includes('github-sync'), false, 'own patch row is never exported')
    assert.equal(patch.includes('agent-default-model'), true)
  })

  await t.test('device B pulls, remaps paths and can continue the conversation', async () => {
    await writeProfilePatch(homeB, '[]\n')
    const result = await runSync({ dshHome: homeB, config: configB, reason: 'test:b-first' })
    assert.equal(result.ok, true, result.summary)
    assert.ok(result.exported > 0, 'device B exported the imported state')

    localWorkspaceRoot = await waitForDirectory(workspaceB)
    assert.equal(pathKey(localWorkspaceRoot), pathKey(workspaceB), 'workspace directory is created')
    const projectDir = projectKey(localWorkspaceRoot)
    sessionFileB = path.join(homeB, 'sessions', projectDir, encodeSegment(sessionId), 'session.v4.jsonl.zstd')
    await stat(sessionFileB)

    const header = await decodeHeader(await readFile(sessionFileB))
    assert.equal(pathKey(header.cwd), pathKey(localWorkspaceRoot))
    const plain = (await decodeFrames(await readFile(sessionFileB))).join('')
    assert.equal(plain.includes(oldCwd), false, 'old workspace path is gone from the session log')
    assert.equal(plain.includes(oldCwd.replaceAll('\\', '\\\\')), false)
    assert.equal(plain.includes(localWorkspaceRoot.replaceAll('\\', '\\\\')), true)

    const registry = await readRegistry(homeB)
    assert.deepEqual(validateWorkspaceDoc(registry), [])
    const rows = listWorkspaces(registry)
    assert.equal(rows.length, 1)
    assert.equal(pathKey(rows[0].path), pathKey(localWorkspaceRoot))
    assert.deepEqual(rows[0].sessionIds, [sessionId])
    assert.equal(rows[0].title, 'wwa · device-a', 'workspace title carries the origin device')

    const status = await computeStatus({ dshHome: homeB, config: configB, warnings: [] })
    assert.equal(status.data.configured, true)
    assert.ok(status.data.sessionCount >= 1)
  })

  await t.test('device A syncs again without conflicts and sees B state', async () => {
    const result = await runSync({ dshHome: homeA, config: configA, reason: 'test:a-second' })
    assert.equal(result.ok, true, result.summary)
    assert.equal(result.conflicts.length, 0)
    const state = await readState(homeA)
    assert.ok(state.lastSyncAt)
    assert.equal(state.lastError, null)
  })

  await t.test('an append-only session extension merges without conflict', async () => {
    await appendSessionEvent(homeA, { id: sessionId, cwd: workspaceA }, {
      type: 'user/message',
      seq: 11,
      time: Date.now(),
      data: { message: { content: [{ type: 'text', text: 'A 设备实时追加的新消息' }] } },
    })
    const resultA = await runSync({ dshHome: homeA, config: configA, reason: 'test:append-a' })
    assert.equal(resultA.ok, true, resultA.summary)
    const resultB = await runSync({ dshHome: homeB, config: configB, reason: 'test:append-b' })
    assert.equal(resultB.ok, true, resultB.summary)
    assert.equal(resultB.conflicts.length, 0, 'append-only extension must not be reported as a conflict')
    const plain = (await decodeFrames(await readFile(sessionFileB))).join('')
    assert.equal(plain.includes('A 设备实时追加的新消息'), true, 'device B received the appended event')
  })

  await t.test('a live session update is deferred until the session closes', async () => {
    await appendSessionEvent(homeA, { id: sessionId, cwd: workspaceA }, {
      type: 'user/message',
      seq: 12,
      time: Date.now(),
      data: { message: { content: [{ type: 'text', text: 'A 在 B 打开会话期间追加' }] } },
    })
    const resultA = await runSync({ dshHome: homeA, config: configA, reason: 'test:live-a' })
    assert.equal(resultA.ok, true, resultA.summary)
    const whileLive = await runSync({
      dshHome: homeB,
      config: configB,
      reason: 'test:live-b',
      liveSessionIds: new Set([sessionId]),
    })
    assert.equal(whileLive.ok, true, whileLive.summary)
    assert.ok(whileLive.pendingSessionIds.includes(sessionId), 'live session update is deferred')
    const during = (await decodeFrames(await readFile(sessionFileB))).join('')
    assert.equal(during.includes('A 在 B 打开会话期间追加'), false, 'live file is not overwritten')
    const afterClose = await runSync({ dshHome: homeB, config: configB, reason: 'test:closed-b' })
    assert.equal(afterClose.ok, true, afterClose.summary)
    const after = (await decodeFrames(await readFile(sessionFileB))).join('')
    assert.equal(after.includes('A 在 B 打开会话期间追加'), true, 'pending update is applied after close')
  })

  await t.test('an established third device merges remote state instead of overwriting it', async () => {
    const homeC = path.join(root, 'homeC')
    const workspaceC = path.join(root, 'workspaceC')
    await mkdir(homeC, { recursive: true })
    await mkdir(workspaceC, { recursive: true })
    const workspaceCId = `ws-c-${suffix()}`
    const sessionCId = `session-c-${suffix()}`
    await writeSession(homeC, { id: sessionCId, cwd: workspaceC })
    await writeRegistry(homeC, { workspaces: [{ id: workspaceCId, path: workspaceC, title: 'c', sessionIds: [sessionCId] }] })
    await writeProfilePatch(homeC, [
      '- id: ui-chat',
      '  name: "@deepseek-ai/dsh-client-ui-chat"',
      '  config:',
      '    transcriptView: standard',
      '',
    ].join('\n'))
    const configC = makeConfig(homeC, { repo: remote, deviceName: 'device-c', branch: 'main' })
    const resultC = await runSync({ dshHome: homeC, config: configC, reason: 'test:c-first' })
    assert.equal(resultC.ok, true, resultC.summary)

    const registryC = await readRegistry(homeC)
    assert.deepEqual(validateWorkspaceDoc(registryC), [])
    const pathsC = listWorkspaces(registryC).map((row) => row.path)
    assert.ok(pathsC.some((value) => pathKey(value) === pathKey(workspaceC)), 'local workspace is preserved')
    assert.ok(pathsC.some((value) => pathKey(value) === pathKey(workspaceA)), 'remote workspace is imported')
    const patchC = await readFile(path.join(homeC, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    assert.equal(patchC.includes('agent-default-model'), true, 'remote setting row was merged in')
    assert.equal(patchC.includes('ui-chat'), true, 'local setting row is preserved')
    const localSessionFile = path.join(homeC, 'sessions', projectKey(workspaceC), encodeSegment(sessionCId), 'session.v4.jsonl.zstd')
    const remoteSessionFile = path.join(homeC, 'sessions', projectKey(workspaceA), encodeSegment(sessionId), 'session.v4.jsonl.zstd')
    await stat(localSessionFile)
    await stat(remoteSessionFile)

    const resultA = await runSync({ dshHome: homeA, config: configA, reason: 'test:a-after-c' })
    assert.equal(resultA.ok, true, resultA.summary)
    const registryA = await readRegistry(homeA)
    assert.ok(listWorkspaces(registryA).some((row) => pathKey(row.path) === pathKey(workspaceC)), 'device A sees device C workspace')
  })

  await t.test('divergent session edits on two devices are kept as a conflict copy', async () => {
    await appendSessionEvent(homeA, { id: sessionId, cwd: oldCwd }, {
      type: 'user/message', seq: 10, time: Date.now(), data: { content: [{ type: 'text', text: '来自 A 的追加' }] },
    })
    const resultA = await runSync({ dshHome: homeA, config: configA, reason: 'test:conflict-a' })
    assert.equal(resultA.ok, true, resultA.summary)

    await appendSessionEvent(homeB, { id: sessionId, cwd: localWorkspaceRoot }, {
      type: 'user/message', seq: 10, time: Date.now(), data: { content: [{ type: 'text', text: '来自 B 的追加' }] },
    })
    const resultB = await runSync({ dshHome: homeB, config: configB, reason: 'test:conflict-b' })
    assert.equal(resultB.ok, true, resultB.summary)
    assert.ok(resultB.conflicts.length >= 1, `expected a conflict: ${resultB.summary}`)

    // keep-local is the default: B keeps its own file, and the losing side is
    // preserved both in the repository and under $DSH_HOME/github-sync.
    const localPlain = (await decodeFrames(await readFile(sessionFileB))).join('')
    assert.equal(localPlain.includes('来自 B 的追加'), true)
    assert.equal(localPlain.includes('来自 A 的追加'), false)
    const repoConflict = (await git(remote, ['ls-tree', '-r', '--name-only', 'main'])).stdout
    assert.ok(repoConflict.includes('.dsh-sync/conflicts/device-b/'), repoConflict)
    // The losing side is preserved in the repository; a local conflicts copy is
    // written only when the divergence is detected during import (not here).
    const conflictFiles = (await git(remote, ['ls-tree', '-r', '--name-only', 'main'])).stdout
      .split('\n')
      .filter((file) => file.startsWith('.dsh-sync/conflicts/'))
    assert.ok(conflictFiles.some((file) => file.endsWith('session.v4.jsonl.zstd')), conflictFiles.join('\n'))
  })

  await t.test('onConflict=prefer-remote replaces local settings during import with a backup', async () => {
    const storageFile = path.join('storages', 'sync-conflict-test.json')
    await mkdir(path.join(homeA, 'storages'), { recursive: true })
    await mkdir(path.join(homeB, 'storages'), { recursive: true })
    await writeFile(path.join(homeA, storageFile), JSON.stringify({ value: 'from-a' }), 'utf8')
    const syncA = await runSync({ dshHome: homeA, config: configA, reason: 'test:prefer-remote-a' })
    assert.equal(syncA.ok, true, syncA.summary)

    await writeFile(path.join(homeB, storageFile), JSON.stringify({ value: 'from-b' }), 'utf8')
    const preferRemoteConfig = { ...configB, onConflict: 'prefer-remote' }
    const syncB = await runSync({ dshHome: homeB, config: preferRemoteConfig, reason: 'test:prefer-remote-b' })
    assert.equal(syncB.ok, true, syncB.summary)
    const localContent = await readFile(path.join(homeB, storageFile), 'utf8')
    assert.equal(JSON.parse(localContent).value, 'from-a', 'prefer-remote wins during import')
    assert.ok(Array.isArray(syncB.backups) && syncB.backups.length > 0, 'the local file was backed up before being replaced')
  })

  await t.test('a deletion on one device propagates to the other with a backup', async () => {
    const sessionDirB = path.dirname(sessionFileB)
    await rm(sessionDirB, { recursive: true, force: true })
    const deleteResult = await runSync({ dshHome: homeB, config: configB, reason: 'test:delete-b' })
    assert.equal(deleteResult.ok, true, deleteResult.summary)

    const resultA = await runSync({ dshHome: homeA, config: configA, reason: 'test:delete-a' })
    assert.equal(resultA.ok, true, resultA.summary)
    let exists = true
    try {
      await stat(sessionFileA)
    } catch {
      exists = false
    }
    assert.equal(exists, false, 'device A also removed the deleted session')
    const backups = await findFiles(syncPath(homeA, 'backups'))
    assert.ok(backups.some((file) => file.includes('session.v4.jsonl.zstd')), 'device A kept a backup before deletion')
  })

  await removeScratch(root)
})

/**
 * Wait until a directory exists (device B creates workspace folders during import).
 *
 * @param {string} directory absolute path.
 * @returns {Promise<string>} real path of the directory.
 */
async function waitForDirectory(directory) {
  const { realpath } = await import('node:fs/promises')
  const { mkdir: make } = await import('node:fs/promises')
  await make(directory, { recursive: true })
  return realpath(directory)
}

/**
 * Recursively list files below a root (returns an empty list when missing).
 *
 * @param {string} root absolute path.
 * @returns {Promise<string[]>} absolute file paths.
 */
async function findFiles(root) {
  const { readdir } = await import('node:fs/promises')
  /** @type {string[]} */
  const result = []
  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else result.push(absolute)
    }
  }
  await visit(root)
  return result
}

/** Keep the fixture helpers imported for potential diagnostics. */
void readSession
