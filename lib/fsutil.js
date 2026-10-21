/**
 * Small filesystem helpers with atomic publishing and hashing.
 *
 * @module dsh-plugin-github-sync/fsutil
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Hash arbitrary bytes with SHA-256.
 *
 * @param {Buffer | string} value data.
 * @returns {string} hex digest.
 */
export function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Hash a file's content.
 *
 * @param {string} file absolute path.
 * @returns {Promise<string | null>} hex digest, or null when the file is absent.
 */
export async function hashFile(file) {
  try {
    return hashBytes(await readFile(file))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Atomically replace a file: write a sibling temp file, fsync it and rename.
 *
 * @param {string} file destination path.
 * @param {Buffer | string} data content.
 * @returns {Promise<void>} resolves after the rename.
 */
export async function atomicWriteFile(file, data) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Read a file, returning null when it does not exist.
 *
 * @param {string} file absolute path.
 * @returns {Promise<Buffer | null>} file bytes or null.
 */
export async function readFileIfExists(file) {
  try {
    return await readFile(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Read a UTF-8 text file, returning null when it does not exist.
 *
 * @param {string} file absolute path.
 * @returns {Promise<string | null>} text or null.
 */
export async function readTextIfExists(file) {
  const bytes = await readFileIfExists(file)
  return bytes === null ? null : bytes.toString('utf8')
}

/**
 * Recursively list regular files under a root.
 *
 * Symbolic links are skipped so a sync never follows a link outside the
 * harness home. Missing roots yield an empty list.
 *
 * @param {string} root absolute root directory.
 * @param {(relativePath: string) => boolean} [filter] optional filter using `/` separators.
 * @returns {Promise<Array<{ relative: string, absolute: string, size: number, mtimeMs: number }>>} file records.
 */
export async function walkFiles(root, filter) {
  const result = []
  async function visit(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(absolute, relative)
      } else if (entry.isFile()) {
        if (filter && !filter(relative)) continue
        const info = await stat(absolute)
        result.push({ relative, absolute, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  await visit(root, '')
  return result
}

/**
 * Copy a file into a backup directory, preserving its path relative to a base.
 *
 * @param {object} options backup options.
 * @param {string} options.file absolute source file.
 * @param {string} options.backupRoot absolute backup root for this run.
 * @param {string} options.baseDir base directory used to derive the relative name.
 * @returns {Promise<string>} absolute backup path.
 */
export async function backupFile(options) {
  const { file, backupRoot, baseDir } = options
  const relative = path.relative(baseDir, file)
  const safeRelative = relative.startsWith('..') ? path.join('_external', path.basename(file)) : relative
  const target = path.join(backupRoot, safeRelative)
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(file, target)
  return target
}

/**
 * Whether an error is a Windows sharing/lock violation.
 *
 * @param {unknown} error candidate.
 * @returns {boolean} true for EBUSY/EPERM/EACCES-style locking errors.
 */
export function isFileBusyError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

/**
 * Format a byte count for user-facing summaries.
 *
 * @param {number} bytes byte count.
 * @returns {string} human-readable size.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
