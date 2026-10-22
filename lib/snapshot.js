/**
 * Snapshot projection: turn the local DSH home into the repository tree and
 * apply the merged repository tree back to the local home.
 *
 * The repository layout mirrors `$DSH_HOME` under `home/` plus the current
 * profile's manifest under `profiles/<name>/`, for example:
 *
 * ```text
 * home/
 *   sessions/--E-work_with_yan--/session-<id>/session.v4.jsonl.zstd
 *   storages/workspace.json
 *   storages/settings.json
 *   cordis.patch.yml
 *   skills/<skill>/SKILL.md
 *   attachments/v1/objects/<xx>/<sha256>
 * profiles/desktop/cordis.patch.yml
 * ```
 *
 * Workspace paths are canonicalized on export (local -> repository) and
 * localized on import (repository -> local) so a workspace that lives at
 * different paths on two devices keeps working.
 *
 * @module dsh-plugin-github-sync/snapshot
 */

import { mkdir, readdir, realpath, rm, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { SyncConflictError } from './errors.js'
import {
  atomicWriteFile,
  backupFile,
  formatBytes,
  hashBytes,
  hashFile,
  isFileBusyError,
  readFileIfExists,
  readTextIfExists,
  walkFiles,
} from './fsutil.js'
import { isNonEmptyString, joinRepoRelative, pathKey, projectKey, syncPath, decodeSegment } from './paths.js'
import {
  extractSessionMeta,
  headerCwd,
  headerSessionId,
  isSessionLogFile,
  parseSessionRepoPath,
  readSessionHeaderBytes,
  rewriteSessionBytes,
} from './sessions.js'
import {
  excludeWorkspaces,
  listWorkspaces,
  mapWorkspacePaths,
  mergeWorkspaceDocs,
  parseWorkspaceDoc,
  serializeWorkspaceDoc,
  validateWorkspaceDoc,
} from './workspace.js'
import { appendPatchRows, extractOwnPatchRows, filterOwnPatchRows, mergePatchTexts } from './patch.js'
import {
  decorateWorkspaceTitles,
  originMap,
  prepareDeviceRegistry,
  readDeviceRegistry,
  readLocalWorkspaceDoc,
} from './devices.js'

/** File-size ceiling used when the configuration does not specify one. */
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024

/**
 * Collect all local files that should be exported to the snapshot repository.
 *
 * @param {object} options collection options.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.config normalized configuration.
 * @param {import('./paths.js').PathMapper} options.mapper path mapper.
 * @param {Map<string, string> | null} [options.workspaceTitleOrigins] canonical path key -> origin device.
 * @returns {Promise<{ entries: Map<string, object>, warnings: string[], skipped: Array<{ path: string, reason: string }> }>} collected entries.
 */
export async function collectLocalEntries(options) {
  const { dshHome, config, mapper, workspaceTitleOrigins = null, preservedWorkspaceRecords = [] } = options
  /** @type {Map<string, object>} */
  const entries = new Map()
  const warnings = []
  const skipped = []
  const maxFileBytes = (config.limits?.maxFileMB ?? 100) * 1024 * 1024 || DEFAULT_MAX_FILE_BYTES
  const maxTotalBytes = (config.limits?.maxTotalMB ?? 4096) * 1024 * 1024
  let totalBytes = 0
  let limitHit = false
  const scopes = config.scopes ?? {}

  /**
   * Register one file.
   *
   * @param {string} repoRel repository-relative path using `/` separators.
   * @param {string} localAbs absolute local path.
   * @param {string} kind logical kind.
   * @param {() => Promise<Buffer>} read content reader/transformer.
   * @param {{ size: number, mtimeMs: number }} meta local file metadata.
   */
  const add = (repoRel, localAbs, kind, read, meta) => {
    if (limitHit) return
    const { size, mtimeMs } = meta
    if (size > maxFileBytes) {
      skipped.push({ path: repoRel, reason: `文件超过单文件上限 ${formatBytes(maxFileBytes)}（${formatBytes(size)}）` })
      return
    }
    if (totalBytes + size > maxTotalBytes) {
      limitHit = true
      warnings.push(`同步数据超过总大小上限 ${formatBytes(maxTotalBytes)}，超出部分已跳过。可在 github-sync.json 的 limits.maxTotalMB 中调整。`)
      return
    }
    totalBytes += size
    entries.set(repoRel, {
      repoRel,
      localPath: localAbs,
      kind,
      read,
      localSize: size,
      localMtimeMs: mtimeMs,
    })
  }

  // ---------------------------------------------------------------- sessions
  if (scopes.sessions) {
    const sessionsRoot = path.join(dshHome, 'sessions')
    const dirs = await listSessionDirectories(sessionsRoot)
    let sessionCount = 0
    for (const dir of dirs) {
      if (dir.files.length === 0) continue
      let sessionId = null
      let cwd = null
      for (const file of dir.files) {
        if (!isSessionLogFile(file.name)) continue
        try {
          const bytes = (await readFileIfExists(file.absolute)) ?? Buffer.alloc(0)
          const { header } = readSessionHeaderBytes(bytes)
          sessionId = headerSessionId(header) ?? sessionId
          cwd = headerCwd(header) ?? cwd
        } catch (error) {
          warnings.push(`无法读取会话头 ${file.absolute}: ${error.message}`)
        }
        if (cwd !== null) break
      }
      if (sessionId !== null && config.excludeSessionIds.includes(sessionId)) {
        skipped.push({ path: dir.relative, reason: '会话 id 在 excludeSessionIds 中' })
        continue
      }
      if (cwd !== null && config.excludeWorkspacePaths.some((value) => pathKey(value) === pathKey(cwd))) {
        skipped.push({ path: dir.relative, reason: '会话所属工作区在 excludeWorkspacePaths 中' })
        continue
      }
      if (config.limits?.maxSessions > 0 && sessionCount >= config.limits.maxSessions) {
        warnings.push(`会话数量超过 limits.maxSessions=${config.limits.maxSessions}，剩余会话已跳过。`)
        break
      }
      sessionCount += 1
      const canonicalCwd = cwd === null ? null : mapper.toCanonical(cwd)
      if (cwd !== null && canonicalCwd !== null && canonicalCwd !== cwd && config.rewriteSessionPaths === false) {
        warnings.push(`路径映射需要 rewriteSessionPaths=true 才能重写会话 ${dir.relative} 的 header.cwd，已跳过该会话目录。`)
        continue
      }
      const projectDirName = canonicalCwd === null ? dir.projectDirName : projectKey(canonicalCwd)
      for (const file of dir.files) {
        const repoRel = `home/sessions/${projectDirName}/${dir.sessionDirName}/${file.name}`
        const read = async () => {
          const bytes = (await readFileIfExists(file.absolute)) ?? Buffer.alloc(0)
          if (cwd === null || canonicalCwd === null || !config.rewriteSessionPaths) return bytes
          if (canonicalCwd === cwd) return bytes
          const result = rewriteSessionBytes(bytes, [{ from: cwd, to: canonicalCwd }])
          for (const message of result.warnings) warnings.push(`${file.absolute}: ${message}`)
          return result.bytes
        }
        add(repoRel, file.absolute, 'session', read, { size: file.size, mtimeMs: file.mtimeMs })
      }
    }
  }

  // ------------------------------------------------------ storages / settings
  const storageFiles = await walkFiles(path.join(dshHome, 'storages'))
  for (const file of storageFiles) {
    const repoRel = `home/storages/${file.relative}`
    const meta = { size: file.size, mtimeMs: file.mtimeMs }
    if (file.relative === 'workspace.json') {
      if (!scopes.workspaces) continue
      add(repoRel, file.absolute, 'workspace', async () => canonicalizeWorkspaceFile(
        await readFileIfExists(file.absolute),
        mapper,
        config.excludeWorkspacePaths.map((value) => mapper.toCanonical(value)),
        workspaceTitleOrigins,
        config.realtime?.workspaceDeviceLabel !== false,
        preservedWorkspaceRecords,
      ), meta)
      continue
    }
    if (file.relative.startsWith('session_projcache/')) {
      if (!scopes.projections) continue
      add(repoRel, file.absolute, 'file', () => readFileOrEmpty(file.absolute), meta)
      continue
    }
    if (file.relative.startsWith('community_market/')) {
      if (!scopes.market) continue
      const rest = file.relative.slice('community_market/'.length)
      // Only the authoritative user intent (sources) and the domain global
      // document are synced; catalog caches are derived and machine-specific.
      if (rest !== 'global.json' && !rest.startsWith('sources/')) continue
      add(repoRel, file.absolute, 'file', () => readFileOrEmpty(file.absolute), meta)
      continue
    }
    if (!scopes.settings) continue
    add(repoRel, file.absolute, 'file', () => readFileOrEmpty(file.absolute), meta)
  }

  // Home-level patch layers (`$DSH_HOME/cordis.patch.yml`, `cordis.yml`).
  if (scopes.settings) {
    for (const name of ['cordis.patch.yml', 'cordis.yml']) {
      const absolute = path.join(dshHome, name)
      const info = await statIfExists(absolute)
      if (!info) continue
      add(`home/${name}`, absolute, 'patch', async () => {
        const text = (await readTextIfExists(absolute)) ?? ''
        return Buffer.from(filterOwnPatchRows(text).text, 'utf8')
      }, { size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  // ------------------------------------------------------------- profile files
  const profileDir = path.join(dshHome, 'profiles', config.profileName)
  if (scopes.settings) {
    const absolute = path.join(profileDir, 'cordis.patch.yml')
    const info = await statIfExists(absolute)
    if (info) {
      add(`profiles/${config.profileName}/cordis.patch.yml`, absolute, 'patch', async () => {
        const text = (await readTextIfExists(absolute)) ?? ''
        return Buffer.from(filterOwnPatchRows(text).text, 'utf8')
      }, { size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  if (scopes.plugins) {
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json', '.npmrc']) {
      const absolute = path.join(profileDir, name)
      const info = await statIfExists(absolute)
      if (!info) continue
      add(`profiles/${config.profileName}/${name}`, absolute, 'file', () => readFileOrEmpty(absolute), { size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  // ------------------------------------------------------------------- skills
  if (scopes.skills) {
    for (const file of await walkFiles(path.join(dshHome, 'skills'))) {
      add(`home/skills/${file.relative}`, file.absolute, 'file', () => readFileOrEmpty(file.absolute), { size: file.size, mtimeMs: file.mtimeMs })
    }
    for (const name of ['AGENTS.md', 'agents.md']) {
      const absolute = path.join(dshHome, name)
      const info = await statIfExists(absolute)
      if (info) add(`home/${name}`, absolute, 'file', () => readFileOrEmpty(absolute), { size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  // -------------------------------------------------------------- attachments
  if (scopes.attachments) {
    for (const file of await walkFiles(path.join(dshHome, 'attachments'))) {
      add(`home/attachments/${file.relative}`, file.absolute, 'file', () => readFileOrEmpty(file.absolute), { size: file.size, mtimeMs: file.mtimeMs })
    }
  }

  return { entries, warnings, skipped }
}

/**
 * Export the local state into the snapshot repository working tree.
 *
 * @param {object} options export options.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.config normalized configuration.
 * @param {import('./paths.js').PathMapper} options.mapper path mapper.
 * @param {string} options.repoDir snapshot working tree.
 * @param {Record<string, { writer?: string, localPath?: string }>} [options.previousManaged] last known managed map.
 * @returns {Promise<object>} export summary and per-path metadata.
 */
export async function exportLocalToRepo(options) {
  const {
    dshHome,
    config,
    mapper,
    repoDir,
    previousManaged = {},
    allowUnchangedSkip = false,
  } = options
  // Record the origin device of any newly created workspace in the sidecar and
  // decorate canonical titles (`wwa · jackfruit`) before projecting the file.
  const prepared = await prepareDeviceRegistry({ repoDir, dshHome, config, mapper })
  // Workspaces whose local directory cannot exist on this device (for example
  // another machine's F:\ drive) must not be deleted from the repository just
  // because this device cannot materialize them.
  const preservedWorkspaceRecords = await collectPreservedWorkspaceRecords({ repoDir, dshHome, mapper })
  const collection = await collectLocalEntries({
    dshHome,
    config,
    mapper,
    workspaceTitleOrigins: prepared.origins,
    preservedWorkspaceRecords,
  })
  const warnings = [...collection.warnings]
  const skipped = [...collection.skipped]
  /** @type {Record<string, { hash: string, localPath: string, kind: string, writer: string, localSize: number, localMtimeMs: number }>} */
  const exported = {}
  let written = 0
  let unchanged = 0
  for (const [repoRel, entry] of collection.entries) {
    const previous = previousManaged[repoRel]
    if (
      allowUnchangedSkip &&
      entry.kind !== 'workspace' &&
      previous !== undefined &&
      typeof previous.hash === 'string' &&
      previous.localSize === entry.localSize &&
      previous.localMtimeMs === entry.localMtimeMs
    ) {
      exported[repoRel] = {
        hash: previous.hash,
        localPath: path.relative(dshHome, entry.localPath).split(path.sep).join('/'),
        kind: entry.kind,
        writer: 'local',
        localSize: entry.localSize,
        localMtimeMs: entry.localMtimeMs,
      }
      unchanged += 1
      continue
    }
    let bytes
    try {
      bytes = await entry.read()
    } catch (error) {
      skipped.push({ path: repoRel, reason: `读取失败：${error.message}` })
      continue
    }
    const hash = hashBytes(bytes)
    const target = joinRepoRelative(repoDir, repoRel)
    const existingHash = await hashFile(target)
    if (existingHash === hash) {
      unchanged += 1
    } else {
      await mkdir(path.dirname(target), { recursive: true })
      await atomicWriteFile(target, bytes)
      written += 1
    }
    exported[repoRel] = {
      hash,
      localPath: path.relative(dshHome, entry.localPath).split(path.sep).join('/'),
      kind: entry.kind,
      writer: 'local',
      localSize: entry.localSize,
      localMtimeMs: entry.localMtimeMs,
    }
  }

  // Remove repository files whose local counterpart disappeared. A previous
  // managed entry is authoritative, but the parent directory must still exist
  // (an unmounted disk or a changed path mapping would otherwise look like a
  // mass deletion), and the path must still be in an enabled scope.
  let removed = 0
  for (const [repoRel, previous] of Object.entries(previousManaged)) {
    if (repoRel in exported) continue
    if (!isNonEmptyString(previous.localPath)) continue
    const info = classifyRepoRel(repoRel, config)
    if (info === null || config.scopes?.[info.scope] !== true) continue
    const localAbs = path.join(dshHome, ...previous.localPath.split('/'))
    if (await fileExists(localAbs)) continue
    if (!(await deletionScopeExists({ repoRel, config, dshHome, localAbs }))) {
      warnings.push(`跳过删除仓库文件 ${repoRel}：本机 ${previous.localPath} 所在目录不存在，可能是路径映射或磁盘未挂载。`)
      continue
    }
    const target = joinRepoRelative(repoDir, repoRel)
    if (await fileExists(target)) {
      await unlink(target)
      await pruneEmptyDirectories(path.dirname(target), repoDir)
      removed += 1
    }
  }

  return { exported, written, unchanged, removed, skipped, warnings, files: Object.keys(exported).length }
}

/**
 * Apply the merged repository tree to the local DSH home.
 *
 * Callers normally run the export phase first, so `exportedMeta` describes the
 * local snapshot taken during this sync. A local file that changed after that
 * point (an active session, a concurrent writer) is never overwritten.
 *
 * @param {object} options import options.
 * @param {string} options.dshHome resolved harness home.
 * @param {object} options.config normalized configuration.
 * @param {import('./paths.js').PathMapper} options.mapper path mapper.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string[]} options.trackedFiles repository-relative tracked files (post-merge).
 * @param {Record<string, object>} [options.previousManaged] state before this sync.
 * @param {Record<string, { localSize?: number, localMtimeMs?: number }>} [options.exportedMeta] metadata from this run's export phase.
 * @param {boolean} [options.dryRun] when true, only report planned changes.
 * @returns {Promise<object>} import summary.
 */
export async function importRepoToLocal(options) {
  const {
    dshHome,
    config,
    mapper,
    repoDir,
    trackedFiles,
    previousManaged = {},
    exportedMeta = {},
    preferRemoteUnknown = false,
    liveSessionIds = new Set(),
    deferWorkspaceFile = false,
    dryRun = false,
  } = options
  const warnings = []
  const conflicts = []
  const backups = []
  const changedFiles = []
  const pending = []
  const skipped = []
  /** Session ids that did not exist locally before this import (new to this device). */
  const newSessionIds = new Set()
  /** Session ids whose local copy was refreshed from the repository. */
  const updatedSessionIds = new Set()
  /** @type {Record<string, object>} */
  const sessionSummaries = {}
  /** Remote-deleted session ids (for the client list `api-session/removed` event). */
  const deletedSessionIds = new Set()
  /** Live sessions whose remote update could not be applied yet. */
  const pendingLiveSessionIds = new Set()
  let workspaceChanged = false
  /** @type {object | null} */
  let localWorkspaceDoc = null
  const deviceRegistry = await readDeviceRegistry(repoDir)
  const origins = originMap(deviceRegistry)
  /** @type {Record<string, object>} */
  const managed = {}
  let written = 0
  let updated = 0
  let unchanged = 0
  let deleted = 0
  const stamp = timestamp()
  const backupRoot = syncPath(dshHome, 'backups', stamp)
  const conflictRoot = syncPath(dshHome, 'conflicts', stamp)
  let backupReady = false

  const ensureBackupRoot = async () => {
    if (backupReady) return
    await mkdir(backupRoot, { recursive: true })
    backupReady = true
  }

  const backupLocal = async (localAbs, reason) => {
    if (dryRun || config.backup?.enabled === false) return null
    await ensureBackupRoot()
    const target = await backupFile({ file: localAbs, backupRoot, baseDir: dshHome })
    backups.push({ file: localAbs, backup: target, reason })
    return target
  }

  /**
   * Apply one file to its local destination with conflict protection.
   *
   * @param {object} args application arguments.
   * @param {string} args.repoRel repository-relative path.
   * @param {string} args.localAbs absolute destination.
   * @param {Buffer} args.bytes desired local bytes.
   * @param {string} args.repoHash hash of the repository-side bytes.
   * @param {string} args.kind logical kind.
   * @param {boolean} [args.isSession] whether this is a session log.
   * @returns {Promise<'new' | 'updated' | 'unchanged' | 'conflict' | 'pending'>} how the file was applied.
   */
  const applyBytes = async ({ repoRel, localAbs, bytes, repoHash, kind, isSession = false }) => {
    const localRel = path.relative(dshHome, localAbs).split(path.sep).join('/')
    const desiredHash = hashBytes(bytes)
    const existing = await readFileIfExists(localAbs)
    const record = (writer) => {
      managed[repoRel] = { hash: repoHash, localPath: localRel, localHash: desiredHash, kind, writer }
    }
    if (existing !== null && existing.equals(bytes)) {
      unchanged += 1
      record(exportedMeta[repoRel] ? 'local' : 'remote')
      return 'unchanged'
    }
    if (existing !== null) {
      const currentHash = hashBytes(existing)
      const meta = exportedMeta[repoRel]
      const currentStat = await stat(localAbs)
      const changedAfterExport = meta !== undefined && (
        meta.localSize !== currentStat.size ||
        Math.abs((meta.localMtimeMs ?? 0) - currentStat.mtimeMs) > 2
      )
      const previous = previousManaged[repoRel]
      const localUnchangedSinceLastSync = previous !== undefined && previous.localHash === currentHash
      const unknownFirstSync = preferRemoteUnknown && previous === undefined && meta === undefined
      const needsConflict = !unknownFirstSync && (changedAfterExport || (meta === undefined && !localUnchangedSinceLastSync))
      if (needsConflict) {
        if (config.onConflict === 'fail') {
          conflicts.push(repoRel)
          throw new SyncConflictError([...new Set(conflicts)])
        }
        if (config.onConflict === 'prefer-remote') {
          conflicts.push(repoRel)
          await backupLocal(localAbs, '被远端版本覆盖（prefer-remote）')
          if (dryRun) {
            updated += 1
            record('remote')
            return 'updated'
          }
          try {
            await atomicWriteFile(localAbs, bytes)
            updated += 1
            changedFiles.push(localRel)
            record('remote')
          } catch (error) {
            if (isSession && isFileBusyError(error)) {
              pending.push(repoRel)
              warnings.push(`会话文件正被占用，稍后重试：${localRel}`)
              return 'pending'
            }
            throw error
          }
          warnings.push(`${localRel} 在本机与远端都有改动，按 onConflict=prefer-remote 采用远端版本（本机版本已备份）。`)
          return 'updated'
        }
        conflicts.push(repoRel)
        warnings.push(`${localRel} 在本机与远端都有改动（或本机在同步过程中被修改），已保留本机版本并保存远端版本副本。`)
        await saveConflictCopy({ dshHome, repoDir, repoRel, bytes, deviceName: config.deviceName, conflictRoot, dryRun })
        record(previous?.writer ?? 'local')
        return 'conflict'
      }
      await backupLocal(localAbs, '被远端版本覆盖')
      if (dryRun) {
        updated += 1
        return 'updated'
      }
      try {
        await atomicWriteFile(localAbs, bytes)
        updated += 1
        changedFiles.push(localRel)
        record('remote')
      } catch (error) {
        if (isSession && isFileBusyError(error)) {
          pending.push(repoRel)
          warnings.push(`会话文件正被占用，稍后重试：${localRel}`)
          return 'pending'
        }
        throw error
      }
      return 'updated'
    }
    if (dryRun) {
      written += 1
      return 'new'
    }
    try {
      await atomicWriteFile(localAbs, bytes)
      written += 1
      changedFiles.push(localRel)
      record('remote')
    } catch (error) {
      if (isSession && isFileBusyError(error)) {
        pending.push(repoRel)
        warnings.push(`会话文件正被占用，稍后重试：${localRel}`)
        return 'pending'
      }
      throw error
    }
    return 'new'
  }

  // Resolve canonical workspace paths to this device's real paths before any
  // session is written: DSH compares `realpath(header.cwd)` with the registry
  // path character by character, so the imported header must use the real
  // local spelling (Windows case, junctions, short names).
  /** @type {Map<string, string>} */
  const canonicalToLocal = new Map()
  if (config.scopes?.workspaces) {
    const wsSource = joinRepoRelative(repoDir, 'home/storages/workspace.json')
    const wsBytes = await readFileIfExists(wsSource)
    if (wsBytes !== null) {
      const wsDoc = parseWorkspaceDoc(wsBytes.toString('utf8'))
      for (const row of listWorkspaces(wsDoc)) {
        if (!row.path) continue
        const mapped = mapper.toLocal(row.path)
        let resolved = mapped
        try {
          if (config.createMissingWorkspaceDirs) await mkdir(mapped, { recursive: true })
          resolved = await realpath(mapped)
        } catch {
          resolved = mapped
        }
        canonicalToLocal.set(pathKey(row.path), resolved)
      }
    }
  }

  const importable = []
  for (const repoRel of trackedFiles) {
    const info = classifyRepoRel(repoRel, config)
    if (!info) continue
    if (config.scopes?.[info.scope] !== true) continue
    importable.push({ repoRel, ...info })
  }
  importable.sort((a, b) => a.repoRel.localeCompare(b.repoRel))

  for (const { repoRel, kind } of importable) {
    const source = joinRepoRelative(repoDir, repoRel)
    const repoBytes = await readFileIfExists(source)
    if (repoBytes === null) continue
    const repoHash = hashBytes(repoBytes)

    if (kind === 'session') {
      const parsed = parseSessionRepoPath(repoRel)
      if (!parsed) continue
      let header = null
      try {
        header = readSessionHeaderBytes(repoBytes).header
      } catch (error) {
        warnings.push(`无法解析远端会话 ${repoRel}: ${error.message}`)
        continue
      }
      const cwd = headerCwd(header)
      const liveSessionId = headerSessionId(header)
      if (liveSessionId !== null && liveSessionIds.has(liveSessionId)) {
        // A live Session projects its in-memory log and holds the single
        // writer lease; overwriting its file here would desync the host and
        // risk a session/list source conflict. Retry after it closes.
        skipped.push({ path: repoRel, reason: '会话正在本机打开（live），暂不覆盖' })
        warnings.push(`会话 ${liveSessionId} 正在本机打开，已暂缓导入远端更新；关闭后下一次同步会自动应用。`)
        pendingLiveSessionIds.add(liveSessionId)
        continue
      }
      const localCwd = cwd === null ? null : (canonicalToLocal.get(pathKey(cwd)) ?? mapper.toLocal(cwd))
      if (cwd !== null && localCwd !== null && cwd !== localCwd && config.rewriteSessionPaths === false) {
        warnings.push(`路径映射需要 rewriteSessionPaths=true 才能重写会话 ${repoRel} 的 header.cwd，已跳过该会话。`)
        continue
      }
      let resolvedLocalCwd = localCwd
      if (resolvedLocalCwd !== null) {
        if (config.excludeWorkspacePaths.some((value) => pathKey(value) === pathKey(resolvedLocalCwd))) {
          skipped.push({ path: repoRel, reason: '工作区在 excludeWorkspacePaths 中' })
          continue
        }
        try {
          if (config.createMissingWorkspaceDirs) await mkdir(resolvedLocalCwd, { recursive: true })
          resolvedLocalCwd = await realpath(resolvedLocalCwd)
        } catch {
          resolvedLocalCwd = localCwd
        }
      }
      const projectDirName = resolvedLocalCwd === null ? parsed.projectKey : projectKey(resolvedLocalCwd)
      const localRel = `sessions/${projectDirName}/${parsed.sessionDir}/${parsed.fileName}`
      const localAbs = path.join(dshHome, ...localRel.split('/'))
      let localBytes = repoBytes
      if (cwd !== null && resolvedLocalCwd !== null && cwd !== resolvedLocalCwd && config.rewriteSessionPaths) {
        const result = rewriteSessionBytes(repoBytes, [{ from: cwd, to: resolvedLocalCwd }])
        localBytes = result.bytes
        for (const message of result.warnings) warnings.push(`${repoRel}: ${message}`)
      }
      const outcome = await applyBytes({ repoRel, localAbs, bytes: localBytes, repoHash, kind, isSession: true })
      const importedSessionId = headerSessionId(header)
      if (importedSessionId !== null) {
        if (outcome === 'new') {
          newSessionIds.add(importedSessionId)
          const meta = extractSessionMeta(localBytes)
          sessionSummaries[importedSessionId] = buildSessionSummary({
            sessionId: importedSessionId,
            header,
            meta,
            localCwd: resolvedLocalCwd ?? (typeof header.cwd === 'string' ? header.cwd : undefined),
          })
        } else if (outcome === 'updated') {
          updatedSessionIds.add(importedSessionId)
        }
      }
      continue
    }

    if (kind === 'workspace') {
      const remoteText = repoBytes.toString('utf8')
      const remoteDoc = parseWorkspaceDoc(remoteText)
      if (remoteDoc === null) {
        warnings.push('远端 workspace.json 无法解析，已跳过。')
        continue
      }
      const localPath = path.join(dshHome, 'storages', 'workspace.json')
      const localText = (await readTextIfExists(localPath)) ?? null
      const localDoc = localText === null ? null : parseWorkspaceDoc(localText)
      const remoteLocalDoc = excludeWorkspaces(
        mapWorkspacePaths(remoteDoc, (value) => canonicalToLocal.get(pathKey(value)) ?? mapper.toLocal(value)),
        config.excludeWorkspacePaths,
      ).doc
      const merged = mergeWorkspaceDocs(localDoc, remoteLocalDoc)
      for (const issue of merged.issues ?? []) warnings.push(issue)
      // Normalize merged paths through the real local directories so the
      // registry matches `realpath(header.cwd)` exactly.
      for (const row of listWorkspaces(merged.doc)) {
        if (!row.path) continue
        let resolved = row.path
        try {
          if (config.createMissingWorkspaceDirs) await mkdir(row.path, { recursive: true })
          resolved = await realpath(row.path)
        } catch {
          resolved = row.path
        }
        if (resolved !== row.path) {
          const entry = merged.doc.tables.workspaces[row.id]
          if (entry && typeof entry === 'object') entry.path = resolved
        }
      }
      // Decorate shared titles with the workspace origin device so every
      // device's sidebar shows `wwa · jackfruit`.
      const decorated = decorateWorkspaceTitles(merged.doc, origins, {
        canonicalizePath: (value) => mapper.toCanonical(value),
        enabled: config.realtime?.workspaceDeviceLabel !== false,
      })
      const docToWrite = decorated.doc
      const problems = validateWorkspaceDoc(docToWrite)
      if (problems.length > 0) {
        warnings.push(`workspace.json 合并后未通过 DSH 不变量校验，已保留本机注册表不写入：${problems.join('；')}`)
        continue
      }
      localWorkspaceDoc = docToWrite
      if (deferWorkspaceFile) {
        // The live workspace registry is authoritative in a running host:
        // applying the file directly would be overwritten by the registry's
        // in-memory state. runtime.js reconciles it through the registry API.
        const wouldChange = merged.changed || decorated.changed || localText === null
        workspaceChanged ||= wouldChange
        if (wouldChange) updated += 1
        else unchanged += 1
        managed[repoRel] = {
          hash: repoHash,
          localPath: 'storages/workspace.json',
          localHash: hashBytes(Buffer.from(serializeWorkspaceDoc(docToWrite), 'utf8')),
          kind,
          writer: 'remote',
        }
        continue
      }
      if (merged.changed || decorated.changed || localText === null) {
        workspaceChanged = true
        if (!dryRun) {
          if (localText !== null) await backupLocal(localPath, 'workspace.json 合并')
          await atomicWriteFile(localPath, Buffer.from(serializeWorkspaceDoc(docToWrite), 'utf8'))
          changedFiles.push('storages/workspace.json')
        }
        updated += 1
      } else {
        unchanged += 1
      }
      managed[repoRel] = {
        hash: repoHash,
        localPath: 'storages/workspace.json',
        localHash: hashBytes(Buffer.from(serializeWorkspaceDoc(docToWrite), 'utf8')),
        kind,
        writer: 'remote',
      }
      continue
    }

    if (kind === 'patch') {
      const localAbs = path.join(dshHome, ...repoRel.split('/'))
      const localText = (await readTextIfExists(localAbs)) ?? null
      const remoteFiltered = filterOwnPatchRows(repoBytes.toString('utf8')).text
      const localFiltered = localText === null ? '' : filterOwnPatchRows(localText).text
      const policy = config.onConflict === 'prefer-remote' ? 'prefer-remote' : 'keep-local'
      let mergedText
      try {
        mergedText = mergePatchTexts(localFiltered, remoteFiltered, policy)
      } catch (error) {
        warnings.push(`${repoRel} 的 patch 行在两端冲突且 onConflict=fail，已保留本机文件：${error.message}`)
        continue
      }
      const ownRows = localText === null ? [] : extractOwnPatchRows(localText)
      const combined = appendPatchRows(mergedText, ownRows)
      if (localText !== null && localText === combined) {
        unchanged += 1
        managed[repoRel] = {
          hash: repoHash,
          localPath: path.relative(dshHome, localAbs).split(path.sep).join('/'),
          localHash: hashBytes(Buffer.from(combined, 'utf8')),
          kind,
          writer: 'remote',
        }
        continue
      }
      // Patch files are merged row by row, so the merged document is safe to
      // apply even when the local file changed: both sides' rows are kept and
      // same-id rows already followed onConflict.
      if (!dryRun) {
        if (localText !== null) await backupLocal(localAbs, 'patch 行合并')
        await atomicWriteFile(localAbs, Buffer.from(combined, 'utf8'))
        changedFiles.push(path.relative(dshHome, localAbs).split(path.sep).join('/'))
      }
      updated += 1
      managed[repoRel] = {
        hash: repoHash,
        localPath: path.relative(dshHome, localAbs).split(path.sep).join('/'),
        localHash: hashBytes(Buffer.from(combined, 'utf8')),
        kind,
        writer: 'remote',
      }
      continue
    }

    const localRel = repoRel.startsWith('profiles/') ? repoRel : repoRel.slice('home/'.length)
    const localAbs = path.join(dshHome, ...localRel.split('/'))
    await applyBytes({ repoRel, localAbs, bytes: repoBytes, repoHash, kind })
  }

  // ------------------------------------------------------------- deletions
  // A previously managed local file whose repository counterpart vanished was
  // deleted on another device; propagate the deletion when the local copy is
  // unchanged since the last sync (otherwise keep the local edit and warn).
  for (const [repoRel, previous] of Object.entries(previousManaged)) {
    if (importable.some((item) => item.repoRel === repoRel)) continue
    if (!isNonEmptyString(previous?.localPath)) continue
    const info = classifyRepoRel(repoRel, config)
    if (info === null || config.scopes?.[info.scope] !== true) continue
    const localAbs = path.join(dshHome, ...previous.localPath.split('/'))
    if (!(await fileExists(localAbs))) continue
    const currentHash = await hashFile(localAbs)
    if (previous.localHash && currentHash !== previous.localHash) {
      warnings.push(`远端删除了 ${repoRel}，但本机文件已被修改，已保留本机版本并跳过删除。`)
      continue
    }
    if (dryRun) {
      deleted += 1
      continue
    }
    await backupLocal(localAbs, '远端删除')
    try {
      await unlink(localAbs)
      await pruneEmptyDirectories(path.dirname(localAbs), dshHome)
      deleted += 1
      changedFiles.push(path.relative(dshHome, localAbs).split(path.sep).join('/'))
      const sessionMatch = /sessions\/[^/]+\/([^/]+)\/[^/]+$/u.exec(previous.localPath)
      if (sessionMatch) deletedSessionIds.add(decodeSegment(sessionMatch[1]))
    } catch (error) {
      warnings.push(`删除本机文件失败 ${localAbs}: ${error.message}`)
    }
  }

  return {
    managed,
    written,
    updated,
    unchanged,
    deleted,
    conflicts,
    pending,
    skipped,
    backups,
    changedFiles,
    warnings,
    dryRun,
    backupRoot: backups.length > 0 ? backupRoot : null,
    newSessionIds: [...newSessionIds],
    updatedSessionIds: [...updatedSessionIds],
    sessionSummaries,
    deletedSessionIds: [...deletedSessionIds],
    pendingLiveSessionIds: [...pendingLiveSessionIds],
    workspaceChanged,
    localWorkspaceDoc,
  }
}

/**
 * Build the client-facing SessionSummary for a session imported from another
 * device. The shape follows `SessionSummary` in the DSH API schema.
 *
 * @param {{ sessionId: string, header: object | null, meta: object, localCwd?: string }} options summary inputs.
 * @returns {object} session summary.
 */
function buildSessionSummary(options) {
  const { sessionId, header, meta, localCwd } = options
  /** @type {Record<string, unknown>} */
  const summary = {
    agentAvailable: false,
    sessionId,
    updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now(),
    running: false,
    blank: meta.blank === true,
  }
  if (isNonEmptyString(localCwd)) summary.cwd = localCwd
  if (header && header.origin === 'subagent') summary.origin = 'subagent'
  const parent = header?.parentSession ?? header?.parentSessionId
  if (isNonEmptyString(parent)) summary.parentSessionId = parent
  if (isNonEmptyString(meta.title)) {
    summary.projections = {
      kind: 'cached',
      asOfSeq: Math.max(0, typeof meta.maxSeq === 'number' ? meta.maxSeq : 0),
      values: {
        title: meta.title,
        sessionListMetadata: {
          blank: meta.blank === true,
          lastPromptAt: summary.updatedAt,
        },
      },
    }
  }
  return summary
}

/**
 * Remove old backup directories according to `backup.keepDays`.
 *
 * @param {string} dshHome resolved harness home.
 * @param {number} keepDays retention in days.
 * @returns {Promise<number>} number of removed run directories.
 */
export async function pruneBackups(dshHome, keepDays) {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return 0
  const root = syncPath(dshHome, 'backups')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const info = await stat(path.join(root, entry.name))
    if (info.mtimeMs >= cutoff) continue
    await rm(path.join(root, entry.name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}

/**
 * Save the losing side of a conflict into the repository (so it is recoverable
 * on every device) and into the local conflicts directory.
 *
 * @param {object} options conflict-copy options.
 * @param {string} options.dshHome resolved harness home.
 * @param {string} options.repoDir snapshot working tree.
 * @param {string} options.repoRel repository-relative path.
 * @param {Buffer} options.bytes losing-side content.
 * @param {string} options.deviceName device label.
 * @param {string} options.conflictRoot local conflicts root.
 * @param {boolean} options.dryRun dry-run flag.
 * @returns {Promise<string>} repository-relative conflict copy path.
 */
async function saveConflictCopy(options) {
  const { dshHome, repoDir, repoRel, bytes, deviceName, conflictRoot, dryRun } = options
  const stamp = timestamp()
  if (!dryRun) {
    const localCopy = path.join(conflictRoot, repoRel.split('/').join(path.sep))
    await mkdir(path.dirname(localCopy), { recursive: true })
    await atomicWriteFile(localCopy, bytes)
  }
  const safeRel = repoRel.replace(/[\\/]+/g, '/')
  const repoCopyRel = `.dsh-sync/conflicts/${deviceName}/${stamp}/${safeRel}`
  if (!dryRun) {
    const repoCopy = joinRepoRelative(repoDir, repoCopyRel)
    await mkdir(path.dirname(repoCopy), { recursive: true })
    await atomicWriteFile(repoCopy, bytes)
  }
  return repoCopyRel
}

/**
 * Determine which scope and logical kind a repository path belongs to.
 *
 * @param {string} repoRel repository-relative path with `/` separators.
 * @param {object} config normalized configuration.
 * @returns {{ scope: string, kind: 'session' | 'workspace' | 'patch' | 'file' } | null} classification, or null.
 */
export function classifyRepoRel(repoRel, config) {
  const normalized = repoRel.split('\\').join('/')
  if (normalized.startsWith('.dsh-sync/')) return null
  if (normalized === 'home/.credentials.yaml' || normalized === 'home/.anonymous-user-id') return null
  if (normalized.startsWith('home/github-sync/')) return null
  if (normalized.startsWith('home/cache/')) return null
  if (normalized === 'home/storages/workspace.json') return { scope: 'workspaces', kind: 'workspace' }
  if (normalized.startsWith('home/sessions/')) return { scope: 'sessions', kind: 'session' }
  if (normalized.startsWith('home/storages/session_projcache/')) return { scope: 'projections', kind: 'file' }
  if (normalized.startsWith('home/storages/community_market/')) return { scope: 'market', kind: 'file' }
  if (normalized.startsWith('home/storages/')) return { scope: 'settings', kind: 'file' }
  if (normalized === 'home/cordis.patch.yml' || normalized === 'home/cordis.yml') return { scope: 'settings', kind: 'patch' }
  if (normalized.startsWith('home/skills/') || normalized === 'home/AGENTS.md' || normalized === 'home/agents.md') return { scope: 'skills', kind: 'file' }
  if (normalized.startsWith('home/attachments/')) return { scope: 'attachments', kind: 'file' }
  const profileMatch = /^profiles\/([^/]+)\/(.+)$/.exec(normalized)
  if (profileMatch) {
    const [, profileName, rest] = profileMatch
    if (profileName !== config.profileName) return null
    if (rest === 'cordis.patch.yml') return { scope: 'settings', kind: 'patch' }
    if (['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json', '.npmrc'].includes(rest)) {
      return { scope: 'plugins', kind: 'file' }
    }
    return null
  }
  return null
}

/**
 * Canonicalize the workspace registry content before writing it to the repo.
 *
 * @param {Buffer | null} bytes local file bytes.
 * @param {import('./paths.js').PathMapper} mapper path mapper.
 * @returns {Buffer} canonical bytes.
 */
function canonicalizeWorkspaceFile(bytes, mapper, excludedCanonicalPaths = [], origins = null, decorateTitles = true, preservedRecords = []) {
  if (bytes === null) return Buffer.alloc(0)
  const doc = parseWorkspaceDoc(bytes.toString('utf8'))
  if (doc === null) return bytes
  let canonical = mapWorkspacePaths(doc, (value) => mapper.toCanonical(value))
  if (excludedCanonicalPaths.length > 0) canonical = excludeWorkspaces(canonical, excludedCanonicalPaths).doc
  if (origins !== null && decorateTitles) {
    canonical = decorateWorkspaceTitles(canonical, origins, { enabled: true }).doc
  }
  canonical = mergePreservedWorkspaces(canonical, preservedRecords)
  return Buffer.from(serializeWorkspaceDoc(canonical), 'utf8')
}

/**
 * Re-attach repository-only workspace records whose local directory cannot
 * exist on this device (another machine's drive), so an export never deletes
 * them.
 *
 * @param {object} doc canonical workspace document.
 * @param {Array<{ id: string, record: object }>} preserved repository records.
 * @returns {object} document including the preserved records.
 */
function mergePreservedWorkspaces(doc, preserved) {
  if (!Array.isArray(preserved) || preserved.length === 0) return doc
  const clone = structuredClone(doc)
  clone.global = clone.global ?? {}
  clone.tables = clone.tables ?? {}
  clone.tables.workspaces = clone.tables.workspaces ?? {}
  const table = clone.tables.workspaces
  const existingPaths = new Set(Object.values(table).map((entry) => pathKey(entry?.path ?? '')).filter((value) => value.length > 0))
  const ids = Array.isArray(clone.global.workspaceIds) ? clone.global.workspaceIds : []
  for (const { id, record } of preserved) {
    if (!record || typeof record !== 'object') continue
    if (id in table) continue
    if (typeof record.path === 'string' && existingPaths.has(pathKey(record.path))) continue
    table[id] = structuredClone(record)
    if (!ids.includes(id)) ids.push(id)
    if (typeof record.path === 'string') existingPaths.add(pathKey(record.path))
  }
  clone.global.workspaceIds = ids
  return clone
}

/**
 * Collect repository workspace records that this device cannot materialize.
 *
 * @param {{ repoDir: string, dshHome: string, mapper: import('./paths.js').PathMapper }} options inputs.
 * @returns {Promise<Array<{ id: string, record: object }>>} preserved records.
 */
async function collectPreservedWorkspaceRecords(options) {
  const { repoDir, dshHome, mapper } = options
  const repoBytes = await readFileIfExists(joinRepoRelative(repoDir, 'home/storages/workspace.json'))
  if (repoBytes === null) return []
  const repoDoc = parseWorkspaceDoc(repoBytes.toString('utf8'))
  if (repoDoc === null) return []
  const localDoc = await readLocalWorkspaceDoc(dshHome)
  const localKeys = new Set(listWorkspaces(localDoc).map((row) => pathKey(row.path)))
  const preserved = []
  for (const [id, record] of Object.entries(repoDoc.tables?.workspaces ?? {})) {
    if (!record || typeof record !== 'object' || typeof record.path !== 'string') continue
    const localPath = mapper.toLocal(record.path)
    if (localKeys.has(pathKey(localPath))) continue
    if (await directoryExists(localPath)) continue
    preserved.push({ id, record })
  }
  return preserved
}

/**
 * List session directories under the sessions root.
 *
 * @param {string} sessionsRoot absolute sessions root.
 * @returns {Promise<Array<{ relative: string, projectDirName: string, sessionDirName: string, files: Array<{ name: string, absolute: string, size: number, mtimeMs: number }> }>>} session directories.
 */
async function listSessionDirectories(sessionsRoot) {
  const result = []
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return result
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    const projectPath = path.join(sessionsRoot, project.name)
    let sessions
    try {
      sessions = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory() || session.isSymbolicLink()) continue
      const sessionPath = path.join(projectPath, session.name)
      let files
      try {
        files = await readdir(sessionPath, { withFileTypes: true })
      } catch {
        continue
      }
      const records = []
      for (const file of files) {
        // A session directory only holds generation logs. Lock files (POSIX),
        // migration staging files and backups are machine-local artifacts.
        if (!file.isFile() || file.isSymbolicLink() || !isSessionLogFile(file.name)) continue
        const absolute = path.join(sessionPath, file.name)
        const info = await stat(absolute)
        records.push({ name: file.name, absolute, size: info.size, mtimeMs: info.mtimeMs })
      }
      result.push({
        relative: `${project.name}/${session.name}`,
        projectDirName: project.name,
        sessionDirName: session.name,
        files: records,
      })
    }
  }
  return result
}

/**
 * Whether a missing local file most plausibly means "the user deleted it"
 * rather than "the parent directory is currently unavailable".
 *
 * For sessions the project directory must still exist (deleting one session
 * directory removes its own parent, so checking the session directory would
 * suppress legitimate deletions); other scopes fall back to the harness home.
 *
 * @param {object} options check inputs.
 * @param {string} options.repoRel repository-relative path.
 * @param {object} options.config normalized configuration.
 * @param {string} options.dshHome harness home.
 * @param {string} options.localAbs absolute local path that is missing.
 * @returns {Promise<boolean>} true when deletion should propagate.
 */
async function deletionScopeExists(options) {
  const { repoRel, config, dshHome, localAbs } = options
  const info = classifyRepoRel(repoRel, config)
  if (info === null) return false
  if (info.scope === 'sessions') {
    const projectDirectory = path.dirname(path.dirname(localAbs))
    return directoryExists(projectDirectory)
  }
  return (await directoryExists(path.dirname(localAbs))) || (await directoryExists(dshHome))
}

/**
 * @param {string} file absolute path.
 * @returns {Promise<Buffer>} file bytes or an empty buffer.
 */
async function readFileOrEmpty(file) {
  return (await readFileIfExists(file)) ?? Buffer.alloc(0)
}

/**
 * @param {string} file absolute path.
 * @returns {Promise<boolean>} file existence.
 */
async function fileExists(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * @param {string} directory absolute path.
 * @returns {Promise<boolean>} directory existence.
 */
async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {string} file absolute path.
 * @returns {Promise<{ size: number, mtimeMs: number } | null>} stat info or null.
 */
async function statIfExists(file) {
  try {
    return await stat(file)
  } catch {
    return null
  }
}

/**
 * Remove now-empty directories up to (but excluding) a boundary.
 *
 * @param {string} directory starting directory.
 * @param {string} boundary absolute boundary directory.
 * @returns {Promise<void>} resolves when done.
 */
async function pruneEmptyDirectories(directory, boundary) {
  let current = directory
  const stop = path.resolve(boundary)
  while (path.resolve(current) !== stop && path.resolve(current).startsWith(stop)) {
    try {
      const entries = await readdir(current)
      if (entries.length > 0) break
      await rmdir(current)
    } catch {
      break
    }
    current = path.dirname(current)
  }
}

/**
 * Timestamp token used in backup and conflict directory names.
 *
 * @returns {string} second-resolution timestamp safe for file names.
 */
export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}
