/**
 * Sync engine: bidirectional synchronization between the local DSH home and a
 * GitHub repository used as the transport.
 *
 * One `runSync` does, in order:
 *
 * 1. export the local DSH state into the snapshot repository working tree;
 * 2. commit it on behalf of this device;
 * 3. fetch and merge the remote branch (file conflicts resolved according to
 *    `onConflict`, with semantic merges for `workspace.json` and patch files);
 * 4. import the merged tree back into the local DSH home;
 * 5. export once more so semantically merged files are canonical in the repo;
 * 6. push, retrying the merge when another device pushed concurrently;
 * 7. persist machine-local state.
 *
 * @module dsh-plugin-github-sync/sync
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { parseWorkspaceDoc, mergeWorkspaceDocs, serializeWorkspaceDoc, listWorkspaces } from './workspace.js'
import { mergePatchTexts, filterOwnPatchRows } from './patch.js'
import { mergeDeviceRegistries, originMap, readDeviceRegistry, applyLocalWorkspaceLabels } from './devices.js'
import { compareSessionLogs } from './sessions.js'
import { defaultConfig, mergeConfig, redactRemote, readToken, sanitizeDeviceName } from './config.js'
import { SyncConflictError, SyncConfigError, SyncError } from './errors.js'
import { atomicWriteFile } from './fsutil.js'
import { hashBytes, hashFile } from './fsutil.js'
import {
  commitAll,
  ensureRepo,
  fetchRemote,
  headCommit,
  listTrackedFiles,
  mergeRemote,
  push,
  remoteUrl,
  resolveGitPath,
  runGit,
} from './git.js'
import { configPath, isNonEmptyString, joinRepoRelative, normalizePath, PathMapper, repoPath, statePath, syncPath } from './paths.js'
import {
  collectLocalEntries,
  exportLocalToRepo,
  importRepoToLocal,
  pruneBackups,
  timestamp,
} from './snapshot.js'
import { readState, recordOutcome, writeState } from './state.js'

/** Module-level single-flight guard so timer, command and tool cannot overlap. */
let activeSync = null

/**
 * Run one synchronization, refusing to overlap with an in-flight one.
 *
 * @param {object} options sync options.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.config effective configuration.
 * @param {string} [options.reason] why the sync was started (manual/timer/startup).
 * @param {boolean} [options.dryRun] when true, do not touch local files or push.
 * @returns {Promise<object>} sync result.
 */
export async function runSync(options) {
  if (activeSync !== null) {
    return {
      ok: false,
      busy: true,
      skipped: true,
      error: '另一个同步任务正在进行中，本次请求已跳过。',
      summary: '另一个同步任务正在进行中。',
    }
  }
  activeSync = (async () => runSyncInner(options))()
  try {
    return await activeSync
  } finally {
    activeSync = null
  }
}

/**
 * @param {object} options sync options.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.config effective configuration.
 * @param {string} [options.reason] why the sync was started.
 * @param {boolean} [options.dryRun] dry-run flag.
 * @returns {Promise<object>} sync result.
 */
async function runSyncInner(options) {
  const {
    dshHome,
    config,
    reason = 'manual',
    dryRun = false,
    liveSessionIds = new Set(),
    deferWorkspaceFile = false,
    runtimeApply = null,
  } = options
  const state = await readState(dshHome)
  const firstSync = Object.keys(state.managed).length === 0
  const mappingKey = JSON.stringify(config.pathMappings ?? [])
  const allowUnchangedSkip = state.mappingKey === mappingKey
  if (!state.deviceId) state.deviceId = randomUUID()
  state.deviceName = config.deviceName
  const startedAt = new Date().toISOString()
  state.lastAttemptAt = startedAt
  /** @type {Set<string>} */
  const runtimeNewSessions = new Set()
  /** @type {Set<string>} */
  const runtimeUpdatedSessions = new Set()
  let runtimeWorkspaceChanged = false
  /** @type {object | null} */
  let runtimeWorkspaceDoc = null
  /** @type {Record<string, object>} */
  const runtimeSessionSummaries = {}
  const runtimeDeletedSessions = new Set()
  const runtimePendingLiveSessions = new Set()

  /**
   * Build the partial result passed to the runtime hot-apply callback. The
   * callback runs before the canonical re-export so the live registry has
   * already written `workspace.json` when the repository snapshot is taken.
   *
   * @param {object} imported import summary.
   * @returns {object} partial sync result.
   */
  const partialResult = (imported) => ({
    ok: true,
    newSessionIds: imported.newSessionIds ?? [],
    updatedSessionIds: imported.updatedSessionIds ?? [],
    deletedSessionIds: imported.deletedSessionIds ?? [],
    sessionSummaries: imported.sessionSummaries ?? {},
    workspaceChanged: imported.workspaceChanged === true,
    localWorkspaceDoc: imported.localWorkspaceDoc ?? null,
  })
  /**
   * Run the optional runtime hot-apply step.
   *
   * @param {object} imported import summary.
   * @returns {Promise<boolean>} true when the host applied the changes (or no callback is configured).
   */
  const applyToRuntime = async (imported) => {
    if (runtimeApply === null) return true
    try {
      const applied = await runtimeApply(partialResult(imported))
      if (applied !== undefined && applied !== null && applied.applied === false && imported.workspaceChanged === true) {
        warnings.push('运行时未能完整热应用工作区变更')
        return false
      }
      return true
    } catch (error) {
      warnings.push(`热应用运行时更新失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  if (!isNonEmptyString(config.repo)) {
    const message = '尚未配置同步仓库。请在 $DSH_HOME/github-sync.json 中填写 repo（GitHub 私有仓库地址），或在对话中执行 /sync init <仓库地址>。'
    state.lastError = message
    await writeState(dshHome, state)
    return { ok: false, code: 'NOT_CONFIGURED', error: message, summary: message, dryRun }
  }

  const warnings = []
  const conflictsKept = []
  let mergedFiles = 0
  let pushAttempts = 0
  let pushed = false
  let pulled = false
  let gitPath
  try {
    gitPath = await resolveGitPath(config)
  } catch (error) {
    state.lastError = error.message
    await writeState(dshHome, state)
    return { ok: false, code: 'GIT_MISSING', error: error.message, summary: `❌ ${error.message}`, dryRun }
  }

  const repoDir = repoPath(dshHome)
  const mapper = new PathMapper(config.pathMappings)
  try {
    if (dryRun) {
      const report = await planExport({ dshHome, config, mapper, repoDir })
      return {
        ok: true,
        dryRun: true,
        exported: report.files,
        written: report.changed,
        unchanged: report.unchanged,
        warnings: report.warnings,
        skipped: report.skipped,
        conflicts: [],
        summary: `（试运行）将导出 ${report.files} 个文件，其中 ${report.changed} 个相对当前快照仓库有变化；未写入本机文件、未提交、未推送。`,
      }
    }
    const setup = await ensureRepo({ repoDir, gitPath, config })
    if (setup.created || (await headCommit({ repoDir, gitPath, config })) === null) {
      // A fresh device adopts the remote history before exporting, so the
      // first merge has a common ancestor instead of joining two unrelated
      // root commits.
      const fetched = await fetchRemote({ repoDir, gitPath, config })
      if (fetched.remoteExists) {
        await runGit({
          cwd: repoDir,
          gitPath,
          args: ['reset', '--hard', `${config.remoteName}/${config.branch}`],
          config,
        })
      }
    }
    if (!dryRun) {
      // A device without snapshot state is a fresh participant: import the
      // shared state before exporting, otherwise its local defaults (an empty
      // profile patch, an empty workspace registry) would overwrite the data
      // other devices already published.
      if (firstSync) {
        const firstFetch = await fetchRemote({ repoDir, gitPath, config })
        if (firstFetch.remoteExists) {
          await runGit({
            cwd: repoDir,
            gitPath,
            args: ['reset', '--hard', `${config.remoteName}/${config.branch}`],
            config,
          })
          const trackedFirst = await listTrackedFiles({ repoDir, gitPath, config })
          const importedFirst = await importRepoToLocal({
            dshHome,
            config,
            mapper,
            repoDir,
            trackedFiles: trackedFirst,
            previousManaged: {},
            exportedMeta: {},
            preferRemoteUnknown: await detectFreshInstall(dshHome, config.profileName),
            liveSessionIds,
            deferWorkspaceFile,
          })
          warnings.push(...importedFirst.warnings)
          for (const id of importedFirst.newSessionIds ?? []) runtimeNewSessions.add(id)
          for (const id of importedFirst.updatedSessionIds ?? []) runtimeUpdatedSessions.add(id)
          for (const id of importedFirst.deletedSessionIds ?? []) runtimeDeletedSessions.add(id)
          for (const id of importedFirst.pendingLiveSessionIds ?? []) runtimePendingLiveSessions.add(id)
          Object.assign(runtimeSessionSummaries, importedFirst.sessionSummaries ?? {})
          runtimeWorkspaceChanged ||= importedFirst.workspaceChanged === true
          runtimeWorkspaceDoc = importedFirst.localWorkspaceDoc ?? runtimeWorkspaceDoc
          await applyToRuntime(importedFirst)
        }
      }
      // ---------------------------------------------------------- export + commit
      const exportOne = await exportLocalToRepo({
        dshHome,
        config,
        mapper,
        repoDir,
        previousManaged: state.managed,
        allowUnchangedSkip,
      })
      warnings.push(...exportOne.warnings)
      await commitAll({
        repoDir,
        gitPath,
        config,
        message: buildCommitMessage(config, 'export', exportOne),
      })

      // ------------------------------------------------------------- merge remote
      const fetched = await fetchRemote({ repoDir, gitPath, config })
      const headAfterExport = await headCommit({ repoDir, gitPath, config })
      // Fast path for high-frequency realtime polling: nothing changed locally
      // (no new commit) and the remote ref equals what this device already
      // synced. Avoid the expensive import pass entirely.
      if (
        !firstSync
        && (state.pendingSessionIds?.length ?? 0) === 0
        && exportOne.written === 0
        && exportOne.removed === 0
        && headAfterExport !== null
        && state.lastCommit === headAfterExport
        && fetched.remoteExists
        && fetched.ahead === 0
        && fetched.behind === 0
      ) {
        state.lastSyncAt = new Date().toISOString()
        state.lastError = null
        await writeState(dshHome, state)
        return {
          ok: true,
          unchanged: true,
          pushed: false,
          pulled: false,
          commit: headAfterExport,
          files: exportOne.files,
          exported: exportOne.files,
          written: 0,
          updated: 0,
          deleted: 0,
          mergedFiles: 0,
          conflicts: [],
          warnings: [...new Set(warnings)],
          newSessionIds: [],
          updatedSessionIds: [],
          sessionSummaries: {},
          deletedSessionIds: [],
          pendingSessionIds: [],
          workspaceChanged: false,
          dryRun: false,
          reason,
          summary: `✅ 无变化（设备 ${config.deviceName} 已是最新，轮询间隔 ${config.realtime?.enabled !== false ? `${config.realtime.intervalSeconds}s` : '定时'}）`,
        }
      }
      if (fetched.remoteExists && fetched.behind > 0) {
        pulled = true
        const mergeResult = await mergeRemote({ repoDir, gitPath, config })
        if (mergeResult.conflicts.length > 0) {
          const resolution = await resolveConflicts({
            dshHome,
            repoDir,
            gitPath,
            config,
            conflicts: mergeResult.conflicts,
            warnings,
          })
          conflictsKept.push(...resolution.conflictsKept)
          mergedFiles += resolution.resolved
          await runGit({
            cwd: repoDir,
            gitPath,
            args: [
              '-c',
              `user.name=${config.git.authorName}`,
              '-c',
              `user.email=${config.git.authorEmail}`,
              'commit',
              '--no-verify',
              '-m',
              `${config.commit.messagePrefix}[${config.deviceName}]: 合并远端更改`,
            ],
            config,
          })
        }
      }

      // --------------------------------------------------------- import to local
      const tracked = await listTrackedFiles({ repoDir, gitPath, config })
      const imported = await importRepoToLocal({
        dshHome,
        config,
        mapper,
        repoDir,
        trackedFiles: tracked,
        previousManaged: state.managed,
        exportedMeta: exportOne.exported,
        liveSessionIds,
        deferWorkspaceFile,
        dryRun,
      })
      warnings.push(...imported.warnings)
      conflictsKept.push(...imported.conflicts)
      for (const id of imported.newSessionIds ?? []) runtimeNewSessions.add(id)
      for (const id of imported.updatedSessionIds ?? []) runtimeUpdatedSessions.add(id)
      for (const id of imported.deletedSessionIds ?? []) runtimeDeletedSessions.add(id)
      for (const id of imported.pendingLiveSessionIds ?? []) runtimePendingLiveSessions.add(id)
      Object.assign(runtimeSessionSummaries, imported.sessionSummaries ?? {})
      runtimeWorkspaceChanged ||= imported.workspaceChanged === true
      runtimeWorkspaceDoc = imported.localWorkspaceDoc ?? runtimeWorkspaceDoc
      const runtimeAppliedOk = await applyToRuntime(imported)

      // ------------------------------------------------------- canonical re-export
      const stateAfterImport = {
        ...state.managed,
        ...imported.managed,
      }
      const exportTwoConfig = deferWorkspaceFile && !runtimeAppliedOk
        ? { ...config, scopes: { ...config.scopes, workspaces: false } }
        : config
      const exportTwo = await exportLocalToRepo({
        dshHome,
        config: exportTwoConfig,
        mapper,
        repoDir,
        previousManaged: stateAfterImport,
        allowUnchangedSkip,
      })
      warnings.push(...exportTwo.warnings)
      await commitAll({
        repoDir,
        gitPath,
        config,
        message: buildCommitMessage(config, 'merge-local', exportTwo),
      })

      // Apply the shared `workspace · device` display label to this device's
      // local registry as well, so the sidebar shows it without waiting for an
      // import round.
      try {
        const origins = originMap(await readDeviceRegistry(repoDir))
        const labels = await applyLocalWorkspaceLabels({ dshHome, config, mapper, origins })
        if (labels.changed) {
          runtimeWorkspaceChanged = true
          runtimeWorkspaceDoc = labels.doc ?? runtimeWorkspaceDoc
        }
      } catch (error) {
        warnings.push(`更新工作区设备标签失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // ------------------------------------------------------------------- push
      while (pushAttempts < 3) {
        pushAttempts += 1
        const result = await push({ repoDir, gitPath, config })
        if (result.pushed || result.upToDate) {
          pushed = result.pushed
          break
        }
        // Non-fast-forward: another device pushed while we were merging.
        const again = await fetchRemote({ repoDir, gitPath, config })
        if (!again.remoteExists) break
        const mergeAgain = await mergeRemote({ repoDir, gitPath, config })
        pulled = true
        if (mergeAgain.conflicts.length > 0) {
          const resolution = await resolveConflicts({
            dshHome,
            repoDir,
            gitPath,
            config,
            conflicts: mergeAgain.conflicts,
            warnings,
          })
          conflictsKept.push(...resolution.conflictsKept)
          mergedFiles += resolution.resolved
          await runGit({
            cwd: repoDir,
            gitPath,
            args: [
              '-c',
              `user.name=${config.git.authorName}`,
              '-c',
              `user.email=${config.git.authorEmail}`,
              'commit',
              '--no-verify',
              '-m',
              `${config.commit.messagePrefix}[${config.deviceName}]: 合并远端更改`,
            ],
            config,
          })
        }
        const trackedAgain = await listTrackedFiles({ repoDir, gitPath, config })
        const importAgain = await importRepoToLocal({
          dshHome,
          config,
          mapper,
          repoDir,
          trackedFiles: trackedAgain,
          previousManaged: stateAfterImport,
          exportedMeta: {},
          liveSessionIds,
          deferWorkspaceFile,
          dryRun,
        })
        warnings.push(...importAgain.warnings)
        conflictsKept.push(...importAgain.conflicts)
        for (const id of importAgain.newSessionIds ?? []) runtimeNewSessions.add(id)
        for (const id of importAgain.updatedSessionIds ?? []) runtimeUpdatedSessions.add(id)
        for (const id of importAgain.deletedSessionIds ?? []) runtimeDeletedSessions.add(id)
        for (const id of importAgain.pendingLiveSessionIds ?? []) runtimePendingLiveSessions.add(id)
        Object.assign(runtimeSessionSummaries, importAgain.sessionSummaries ?? {})
        runtimeWorkspaceChanged ||= importAgain.workspaceChanged === true
        runtimeWorkspaceDoc = importAgain.localWorkspaceDoc ?? runtimeWorkspaceDoc
        await applyToRuntime(importAgain)
        await exportLocalToRepo({
          dshHome,
          config,
          mapper,
          repoDir,
          previousManaged: { ...stateAfterImport, ...importAgain.managed },
          allowUnchangedSkip,
        })
        await commitAll({
          repoDir,
          gitPath,
          config,
          message: buildCommitMessage(config, 'retry', { written: 0, removed: 0 }),
        })
      }
      if (!pushed) {
        throw new SyncError('推送失败：远端分支在多次重试后仍被其他设备更新。', {
          code: 'PUSH_REJECTED',
          hint: '请稍后重试；如果持续失败，检查是否多个设备同时开启了自动同步。',
        })
      }

      // ------------------------------------------------------------ final state
      const finalManaged = { ...stateAfterImport, ...exportTwo.exported }
      const head = await headCommit({ repoDir, gitPath, config })
      const result = {
        ok: true,
        pushed,
        pulled,
        commit: head,
        files: exportTwo.files,
        exported: exportTwo.files,
        changedLocal: imported.changedFiles.length,
        written: imported.written,
        updated: imported.updated,
        deleted: imported.deleted,
        mergedFiles,
        conflicts: [...new Set(conflictsKept)],
        warnings: [...new Set(warnings)],
        backups: imported.backups,
        backupRoot: imported.backupRoot,
        pushAttempts,
        dryRun,
        reason,
        newSessionIds: [...runtimeNewSessions],
        updatedSessionIds: [...runtimeUpdatedSessions],
        sessionSummaries: runtimeSessionSummaries,
        deletedSessionIds: [...runtimeDeletedSessions],
        pendingSessionIds: [...runtimePendingLiveSessions],
        workspaceChanged: runtimeWorkspaceChanged,
        localWorkspaceDoc: runtimeWorkspaceDoc,
        runtimeApplied: runtimeApply !== null,
        summary: '',
      }
      result.summary = renderSummary({ config, result, state })
      state.managed = finalManaged
      state.mappingKey = mappingKey
      state.pendingSessionIds = [...runtimePendingLiveSessions]
      state.conflicts.push(...result.conflicts.map((file) => ({ at: new Date().toISOString(), repoRel: file })))
      if (state.conflicts.length > 50) state.conflicts = state.conflicts.slice(-50)
      recordOutcome(state, { ...result, ok: true })
      await writeState(dshHome, state)
      await pruneBackups(dshHome, config.backup?.keepDays ?? 30)
      return result
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    state.lastError = message
    await writeState(dshHome, state)
    return {
      ok: false,
      code: error?.code ?? 'SYNC_FAILED',
      error: message,
      hint: error?.hint ?? '',
      warnings: [...new Set(warnings)],
      conflicts: [...new Set(conflictsKept)],
      dryRun,
      summary: `❌ 同步失败：${message}${error?.hint ? `\n${error.hint}` : ''}`,
    }
  }
}

/**
 * Resolve git merge conflicts.
 *
 * `workspace.json` and patch files are merged semantically (union by workspace
 * id / patch row id); other files follow `onConflict`, and the losing side is
 * always preserved under `.dsh-sync/conflicts/<device>/<timestamp>/`.
 *
 * @param {object} options resolution options.
 * @param {string} options.dshHome resolved harness home.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config normalized configuration.
 * @param {string[]} options.conflicts conflicted repository-relative paths.
 * @param {string[]} options.warnings warning sink.
 * @returns {Promise<{ resolved: number, conflictsKept: string[] }>} resolution summary.
 */
async function resolveConflicts(options) {
  const { dshHome, repoDir, gitPath, config, conflicts, warnings } = options
  const conflictsKept = []
  let resolved = 0
  const stamp = timestamp()
  for (const file of conflicts) {
    const normalized = file.split('\\').join('/')
    const ours = await gitShowStage({ repoDir, gitPath, config, stage: 2, file: normalized })
    const theirs = await gitShowStage({ repoDir, gitPath, config, stage: 3, file: normalized })
    if (normalized === 'home/storages/workspace.json') {
      const oursDoc = ours === null ? null : parseWorkspaceDoc(ours.toString('utf8'))
      const theirsDoc = theirs === null ? null : parseWorkspaceDoc(theirs.toString('utf8'))
      if (oursDoc !== null || theirsDoc !== null) {
        const merged = mergeWorkspaceDocs(oursDoc, theirsDoc)
        const bytes = Buffer.from(serializeWorkspaceDoc(merged.doc), 'utf8')
        await writeWorktreeFile(repoDir, normalized, bytes)
        await runGit({ cwd: repoDir, gitPath, args: ['add', '--', normalized], config })
        resolved += 1
        warnings.push('workspace.json 冲突已按工作区 id 与 sessionId 并集自动合并。')
        continue
      }
    }
    if (normalized === 'meta/workspaces.json') {
      const merged = mergeDeviceRegistries(parseJsonOrNull(ours), parseJsonOrNull(theirs))
      const bytes = Buffer.from(`${JSON.stringify(merged.doc, null, 2)}\n`, 'utf8')
      await writeWorktreeFile(repoDir, normalized, bytes)
      await runGit({ cwd: repoDir, gitPath, args: ['add', '--', normalized], config })
      resolved += 1
      warnings.push('工作区来源设备映射（meta/workspaces.json）冲突已按路径并集合并。')
      continue
    }
    if (/^home\/cordis(\.patch)?\.yml$/u.test(normalized) || /^profiles\/[^/]+\/cordis\.patch\.yml$/u.test(normalized)) {
      const oursText = ours === null ? '' : ours.toString('utf8')
      const theirsText = theirs === null ? '' : theirs.toString('utf8')
      const mergedText = mergePatchTexts(oursText, theirsText, config.onConflict)
      const bytes = Buffer.from(mergedText, 'utf8')
      await writeWorktreeFile(repoDir, normalized, bytes)
      await runGit({ cwd: repoDir, gitPath, args: ['add', '--', normalized], config })
      resolved += 1
      warnings.push(`${normalized} 冲突已按行 id 合并（同 id 行采用 onConflict=${config.onConflict} 策略）。`)
      continue
    }
    if (normalized.startsWith('home/sessions/') && config.realtime?.mergeAppendOnlySessions !== false) {
      const left = ours ?? Buffer.alloc(0)
      const right = theirs ?? Buffer.alloc(0)
      const comparison = compareSessionLogs(left, right)
      if (comparison.relation === 'equal') {
        const bytes = left.length >= right.length ? left : right
        await writeWorktreeFile(repoDir, normalized, bytes)
        await runGit({ cwd: repoDir, gitPath, args: ['add', '--', normalized], config })
        resolved += 1
        continue
      }
      if (comparison.relation === 'left-prefix' || comparison.relation === 'right-prefix') {
        const winner = comparison.relation === 'left-prefix' ? right : left
        await writeWorktreeFile(repoDir, normalized, winner)
        await runGit({ cwd: repoDir, gitPath, args: ['add', '--', normalized], config })
        resolved += 1
        warnings.push(`${normalized} 的会话日志是追加扩展关系，已按时间线合并（保留较长的一份，共 ${comparison.commonEvents} 条共同事件）。`)
        continue
      }
      warnings.push(`${normalized} 的会话日志在两端都有新增事件（分叉），按 onConflict=${config.onConflict} 处理并保存另一方副本。`)
    }
    if (config.onConflict === 'fail') throw new SyncConflictError(conflicts)
    const preferRemote = config.onConflict === 'prefer-remote'
    const chosen = preferRemote ? (theirs ?? ours) : (ours ?? theirs)
    const losing = preferRemote ? ours : theirs
    if (losing !== null && losing !== undefined) {
      const copyRel = `.dsh-sync/conflicts/${config.deviceName}/${stamp}/${normalized}`
      await writeWorktreeFile(repoDir, copyRel, losing)
    }
    if (chosen === null || chosen === undefined) {
      // One side deleted the file: follow the chosen side.
      await runGit({ cwd: repoDir, gitPath, args: ['rm', '--ignore-unmatch', '--', normalized], config })
    } else {
      await writeWorktreeFile(repoDir, normalized, chosen)
      await runGit({ cwd: repoDir, gitPath, args: ['add', '--', normalized], config })
    }
    conflictsKept.push(normalized)
    warnings.push(`${normalized} 存在冲突，已保留${preferRemote ? '远端' : '本机'}版本，另一方保存在 .dsh-sync/conflicts/ 下。`)
    resolved += 1
  }
  return { resolved, conflictsKept }
}

/**
 * Parse JSON bytes, returning null for missing or malformed content.
 *
 * @param {Buffer | null | undefined} bytes candidate bytes.
 * @returns {object | null} parsed object.
 */
function parseJsonOrNull(bytes) {
  if (bytes === null || bytes === undefined) return null
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Read one merge stage of a conflicted file.
 *
 * @param {object} options stage options.
 * @param {string} options.repoDir working tree.
 * @param {string} options.gitPath git executable.
 * @param {object} options.config configuration.
 * @param {2 | 3} options.stage merge stage.
 * @param {string} options.file repository-relative path.
 * @returns {Promise<Buffer | null>} file bytes, or null when that stage does not exist.
 */
async function gitShowStage(options) {
  const { repoDir, gitPath, config, stage, file } = options
  const result = await runGit({
    cwd: repoDir,
    gitPath,
    args: ['show', `:${stage}:${file}`],
    config,
    allowFailure: true,
    binary: true,
  })
  if (result.code !== 0) return null
  if (!Buffer.isBuffer(result.stdout)) return Buffer.from(result.stdout, 'utf8')
  return result.stdout
}

/**
 * Write a repository worktree file, creating parent directories.
 *
 * @param {string} repoDir working tree root.
 * @param {string} repoRel repository-relative path with `/`.
 * @param {Buffer} bytes content.
 * @returns {Promise<void>} resolves after write.
 */
async function writeWorktreeFile(repoDir, repoRel, bytes) {
  const target = joinRepoRelative(repoDir, repoRel)
  await mkdir(path.dirname(target), { recursive: true })
  await atomicWriteFile(target, bytes)
}

/**
 * Merge two patch files by top-level row id.
 *
 * @param {string} ours local side text.
 * @param {string} theirs remote side text.
 * @param {'keep-local' | 'prefer-remote' | 'fail'} policy conflict policy.
 * @returns {string} merged patch text.
 */
function mergePatchTextsCompat(ours, theirs, policy) {
  return mergePatchTexts(ours, theirs, policy)
}

/**
 * Build a human-readable commit message.
 *
 * @param {object} config normalized configuration.
 * @param {string} phase phase label.
 * @param {{ written?: number, unchanged?: number, removed?: number }} summary export summary.
 * @returns {string} commit message.
 */
function buildCommitMessage(config, phase, summary) {
  const stamp = new Date().toISOString()
  const counts = `+${summary.written ?? 0} ~${summary.unchanged ?? 0} -${summary.removed ?? 0}`
  return `${config.commit.messagePrefix}[${config.deviceName}]: ${phase} ${stamp} (${counts})`
}

/**
 * Render the Chinese summary shown in the chat and by the CLI.
 *
 * @param {{ config: object, result: object, state: object }} options render inputs.
 * @returns {string} summary text.
 */
function renderSummary({ config, result, state }) {
  const lines = []
  lines.push(`✅ DSH GitHub 同步完成（设备 ${config.deviceName}，分支 ${config.branch}）`)
  lines.push(`仓库：${redactRemote(config.repo)}`)
  if (result.commit) lines.push(`提交：${result.commit.slice(0, 12)}`)
  lines.push(`方向：${result.pulled ? '拉取远端更改' : '无远端新更改'} / ${result.pushed ? '已推送' : '无本地新提交'}`)
  lines.push(`文件：导出 ${result.files} 个；本机写入 ${result.written} 个、更新 ${result.updated} 个、删除 ${result.deleted} 个`)
  if (result.conflicts.length > 0) {
    lines.push(`冲突：${result.conflicts.length} 个文件发生冲突，已按 onConflict=${config.onConflict} 处理；另一方版本/本机备份见仓库 .dsh-sync/conflicts/ 与 $DSH_HOME/github-sync/（backups/、conflicts/）`)
  }
  if (result.warnings.length > 0) {
    const preview = result.warnings.slice(0, 5)
    lines.push(`提示：${preview.join('；')}${result.warnings.length > preview.length ? ` …等 ${result.warnings.length} 条` : ''}`)
  }
  lines.push(`上次同步：${state.lastSyncAt ?? '无'}`)
  return lines.join('\n')
}

/**
 * Detect whether this harness home still looks like a fresh install.
 *
 * A fresh device (no sessions, no registered workspaces, default/empty profile
 * patch) should let the remote win for opaque settings files; an established
 * device keeps its local settings and stores the remote variant as a conflict
 * copy instead.
 *
 * @param {string} dshHome resolved harness home.
 * @param {string} profileName current profile name.
 * @returns {Promise<boolean>} true when the home looks fresh.
 */
async function detectFreshInstall(dshHome, profileName) {
  try {
    let sessionCount = 0
    const projects = await readdir(path.join(dshHome, 'sessions'), { withFileTypes: true }).catch(() => [])
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const entries = await readdir(path.join(dshHome, 'sessions', project.name), { withFileTypes: true }).catch(() => [])
      sessionCount += entries.filter((entry) => entry.isDirectory()).length
    }
    if (sessionCount > 0) return false
    const workspaceText = await readFile(path.join(dshHome, 'storages', 'workspace.json'), 'utf8').catch(() => null)
    if (workspaceText !== null) {
      const doc = parseWorkspaceDoc(workspaceText)
      if (doc !== null && listWorkspaces(doc).length > 0) return false
    }
    const patchText = await readFile(path.join(dshHome, 'profiles', profileName, 'cordis.patch.yml'), 'utf8').catch(() => null)
    if (patchText !== null) {
      const meaningful = filterOwnPatchRows(patchText).text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#') && line !== '[]')
      if (meaningful.length > 0) return false
    }
    return true
  } catch {
    return true
  }
}

/**
 * Compute what a dry-run export would change without touching the repository.
 *
 * @param {{ dshHome: string, config: object, mapper: PathMapper, repoDir: string }} options plan inputs.
 * @returns {Promise<{ files: number, changed: number, unchanged: number, warnings: string[], skipped: object[] }>} plan.
 */
async function planExport(options) {
  const { dshHome, config, mapper, repoDir } = options
  const collection = await collectLocalEntries({ dshHome, config, mapper })
  let changed = 0
  let unchanged = 0
  for (const [repoRel, entry] of collection.entries) {
    const bytes = await entry.read()
    const hash = hashBytes(bytes)
    const existing = await hashFile(joinRepoRelative(repoDir, repoRel))
    if (existing === hash) unchanged += 1
    else changed += 1
  }
  return {
    files: collection.entries.size,
    changed,
    unchanged,
    warnings: collection.warnings,
    skipped: collection.skipped,
  }
}

/**
 * Compute a status report without touching the network or the local state.
 *
 * @param {object} options status options.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.config effective configuration.
 * @param {string[]} [options.warnings] configuration warnings.
 * @returns {Promise<{ text: string, data: object }>} status report.
 */
export async function computeStatus(options) {
  const { dshHome, config, warnings = [] } = options
  const state = await readState(dshHome)
  const lines = []
  const data = {
    configured: isNonEmptyString(config.repo),
    repo: config.repo ? redactRemote(config.repo) : '',
    branch: config.branch,
    deviceName: config.deviceName,
    profileName: config.profileName,
    configFile: configPath(dshHome),
    repoDir: repoPath(dshHome),
    stateFile: statePath(dshHome),
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    conflicts: state.conflicts,
    warnings: [...warnings],
  }
  lines.push('DSH GitHub 同步状态')
  lines.push(`仓库：${data.repo || '（未配置）'}`)
  lines.push(`分支：${config.branch}　设备：${config.deviceName}　profile：${config.profileName}`)
  lines.push(`配置文件：${data.configFile}`)
  const scopeNames = Object.entries(config.scopes ?? {}).filter(([, enabled]) => enabled).map(([name]) => name)
  lines.push(`同步范围：${scopeNames.join(', ') || '（无）'}`)
  data.realtime = config.realtime
  if (config.realtime?.enabled !== false) {
    lines.push(`实时同步：开启（活跃 ${config.realtime.intervalSeconds}s / 空闲 ${config.realtime.idleIntervalSeconds}s 轮询；写后约 ${config.realtime.pushDebounceSeconds}s 推送）`)
  } else {
    lines.push('实时同步：关闭（使用定时同步）')
  }
  lines.push(`工作区设备标签：${config.realtime?.workspaceDeviceLabel !== false ? `开启（标题形如「wwa · ${config.deviceName}」）` : '关闭'}`)
  if (config.pathMappings.length > 0) {
    lines.push(`路径映射：${config.pathMappings.map((entry) => `${entry.from} → ${entry.to}`).join('；')}`)
  }
  try {
    const gitPath = await resolveGitPath(config)
    data.gitPath = gitPath
    if (await pathExists(data.repoDir)) {
      data.repoUrl = await remoteUrl({ repoDir: data.repoDir, gitPath, config })
      data.head = await headCommit({ repoDir: data.repoDir, gitPath, config })
      if (data.head) lines.push(`本地快照仓库 HEAD：${data.head.slice(0, 12)}`)
    } else {
      lines.push('本地快照仓库：尚未初始化（首次同步时创建）')
    }
  } catch (error) {
    lines.push(`git：不可用（${error.message}）`)
  }
  if (state.lastSyncAt) lines.push(`最近同步：${state.lastSyncAt}`)
  else lines.push('最近同步：从未')
  if (state.lastError) lines.push(`最近错误：${state.lastError}`)
  if ((state.pendingSessionIds?.length ?? 0) > 0) {
    lines.push(`待应用（本机打开中的会话）：${state.pendingSessionIds.length} 个 — 关闭这些会话后自动拉取远端更新`)
  }
  if (state.conflicts.length > 0) {
    lines.push(`最近冲突（${state.conflicts.length}）：${state.conflicts.slice(-3).map((entry) => entry.repoRel).join('；')}`)
  }
  try {
    const sessionDirs = await readdir(path.join(dshHome, 'sessions'), { withFileTypes: true }).catch(() => [])
    let sessionCount = 0
    for (const project of sessionDirs) {
      if (!project.isDirectory()) continue
      const entries = await readdir(path.join(dshHome, 'sessions', project.name), { withFileTypes: true }).catch(() => [])
      sessionCount += entries.filter((entry) => entry.isDirectory()).length
    }
    data.sessionCount = sessionCount
    lines.push(`本机会话：${sessionCount} 个`)
  } catch {
    // status must never fail on counting
  }
  if (warnings.length > 0) lines.push('配置提示：\n- ' + warnings.join('\n- '))
  lines.push('可用命令：/sync status | /sync sync | /sync init <仓库地址>')
  return { text: lines.join('\n'), data }
}

/**
 * Create or update the machine-local config file (used by `/sync init`).
 *
 * @param {object} options init options.
 * @param {string} options.dshHome resolved harness home.
 * @param {string} [options.repo] repository URL.
 * @param {string} [options.branch] branch name.
 * @param {string} [options.deviceName] device name.
 * @param {string} [options.profileName] DSH profile name.
 * @param {boolean} [options.overwrite] replace an existing repo value.
 * @returns {Promise<{ file: string, created: boolean, repo: string }>} init result.
 */
export async function initializeConfig(options) {
  const { dshHome } = options
  const file = configPath(dshHome)
  /** @type {object} */
  let existing = {}
  let created = true
  try {
    existing = JSON.parse(await readFile(file, 'utf8'))
    created = false
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw new SyncConfigError(`读取 ${file} 失败：${error.message}`)
  }
  const repo = options.repo?.trim() || existing.repo
  if (!isNonEmptyString(repo)) {
    throw new SyncConfigError('请提供 GitHub 仓库地址，例如：/sync init https://github.com/<账号>/dsh-sync.git', {
      hint: '仓库必须是私有仓库；插件不会同步 .credentials.yaml 等密钥文件，但对话内容仍然敏感。',
    })
  }
  if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(repo)) {
    throw new SyncConfigError(`仓库地址看起来不合法：${repo}`, { hint: '支持 https://github.com/<user>/<repo>.git 或 git@github.com:<user>/<repo>.git。' })
  }
  const deviceName = sanitizeDeviceName(options.deviceName) || existing.deviceName || sanitizeDeviceName(hostname()) || 'device'
  const branch = options.branch?.trim() || existing.branch || 'main'
  const profileName = options.profileName?.trim() || existing.profileName || 'desktop'
  // Seed a complete configuration document (schema hint, scopes, auto, limits,
  // pathMappings, git...) so the JSON file is self-documenting in editors.
  const updated = mergeConfig(
    defaultConfig({ hostnameValue: deviceName }),
    existing,
    { enabled: true, repo, branch, deviceName, profileName },
  )
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  return { file, created, repo }
}

/**
 * Mention a token source in status text when a token is configured, without
 * revealing it.
 *
 * @param {object} config normalized configuration.
 * @returns {string} human-readable token source label.
 */
export function describeTokenSource(config) {
  const token = readToken(config)
  if (token === null) return '（未检测到 Token 环境变量；将使用本机 git credential / SSH）'
  return `（使用环境变量 ${token.variable}）`
}

/**
 * @param {string} value filesystem path.
 * @returns {Promise<boolean>} existence.
 */
async function pathExists(value) {
  try {
    await stat(value)
    return true
  } catch {
    return false
  }
}

/** Re-export helpers that the plugin entry and CLI share. */
export { normalizePath, syncPath }
