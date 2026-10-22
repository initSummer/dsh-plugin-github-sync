/**
 * Session-log helpers.
 *
 * DSH stores one session per `sessions/<project-key>/<encoded-id>/` directory;
 * the current log generation is a concatenation of independent Zstandard
 * frames (the first frame carries the JSON header line, later frames carry
 * durable event batches). A session header records its workspace `cwd`, which
 * is the authoritative mapping between a session and a workspace path. When a
 * workspace lives at different paths on two devices, the header and event text
 * must be rewritten so the imported session belongs to the local path.
 *
 * @module dsh-plugin-github-sync/sessions
 */

import { readFile } from 'node:fs/promises'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Little-endian bytes of the Zstandard frame magic number. */
export const ZSTD_MAGIC = 4247762216

/** Maximum size of a single decompressed frame we are willing to handle. */
const MAX_FRAME_INPUT = 1024 * 1024 * 1024

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * Mirrors the framing rules of `@deepseek-ai/dsh-session-persistence-jsonl`:
 * each frame begins with the 4-byte magic, a frame header descriptor, optional
 * header fields, blocks and an optional checksum. A torn final frame is
 * reported instead of thrown so exported data can preserve crash tails.
 *
 * @param {Buffer} buffer complete file bytes.
 * @returns {{ frames: Array<{ start: number, end: number }>, tornStart: number | null }} frame layout.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`损坏的 Zstandard 会话日志：字节 ${offset} 处的帧魔数无效`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`损坏的 Zstandard 会话日志：字节 ${offset - 1} 处的帧头保留位非零`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`损坏的 Zstandard 会话日志：字节 ${offset - 3} 处的块类型保留值非法`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: null }
}

/**
 * Decode one complete Zstandard frame.
 *
 * @param {Buffer} source complete file bytes.
 * @param {{ start: number, end: number }} frame frame range.
 * @returns {Buffer} decompressed plaintext.
 */
export function decodeZstdFrame(source, frame) {
  return zstdDecompressSync(source.subarray(frame.start, frame.end), { maxOutputLength: MAX_FRAME_INPUT })
}

/**
 * Compress one plaintext block into one independently decodable frame with a
 * checksum, matching what DSH's JSONL backend writes.
 *
 * @param {Buffer | string} plaintext frame payload.
 * @returns {Buffer} encoded frame.
 */
export function encodeZstdFrame(plaintext) {
  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext
  return zstdCompressSync(input, {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  })
}

/**
 * Read a session header from raw log bytes.
 *
 * @param {Buffer} bytes log file bytes (compressed or plaintext).
 * @returns {{ header: object | null, text: string, compressed: boolean }} parsed header information.
 */
export function readSessionHeaderBytes(bytes) {
  if (isZstd(bytes)) {
    const { frames, tornStart } = scanZstdFrames(bytes)
    if (frames.length === 0) {
      if (tornStart !== null) return { header: null, text: '', compressed: true }
      return { header: null, text: '', compressed: true }
    }
    const first = decodeZstdFrame(bytes, frames[0]).toString('utf8')
    return { header: parseHeaderLine(first), text: first, compressed: true }
  }
  const text = bytes.toString('utf8')
  return { header: parseHeaderLine(text), text, compressed: false }
}

/**
 * Read the header of a session log file.
 *
 * @param {string} file absolute file path.
 * @returns {Promise<{ header: object | null, text: string, compressed: boolean }>} header information.
 */
export async function readSessionHeader(file) {
  const bytes = await readFile(file)
  return readSessionHeaderBytes(bytes)
}

/**
 * Extract the workspace `cwd` recorded in a session header.
 *
 * @param {object | null} header parsed header object.
 * @returns {string | null} absolute workspace path, or null when absent.
 */
export function headerCwd(header) {
  if (!header || typeof header !== 'object') return null
  const value = header.cwd
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Extract the session id recorded in a session header.
 *
 * @param {object | null} header parsed header object.
 * @returns {string | null} session id, or null when absent.
 */
export function headerSessionId(header) {
  if (!header || typeof header !== 'object') return null
  return typeof header.id === 'string' && header.id.length > 0 ? header.id : header.id === undefined ? null : String(header.id)
}

/**
 * Extract a display title and list metadata from a session log.
 *
 * Used when a session is imported from another device: its projection cache is
 * not synchronized, so the title is recovered from the durable `session/title`
 * event (or the first user message) for the live session list update.
 *
 * @param {Buffer} bytes session log bytes (localized already).
 * @returns {{ title: string | null, maxSeq: number, updatedAt: number, blank: boolean, header: object | null }} extracted metadata.
 */
export function extractSessionMeta(bytes) {
  const header = readSessionHeaderBytes(bytes).header
  let title = null
  let firstUserText = null
  let maxSeq = -1
  let lastTime = 0
  let blank = true
  if (!isZstd(bytes)) {
    return {
      title: null,
      maxSeq,
      updatedAt: typeof header?.createdAt === 'number' ? header.createdAt : Date.now(),
      blank,
      header,
    }
  }
  try {
    const { frames } = scanZstdFrames(bytes)
    for (let index = 1; index < frames.length; index++) {
      const text = decodeZstdFrame(bytes, frames[index]).toString('utf8')
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (!event || typeof event !== 'object') continue
        if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
        if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time
        if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
        if (event.type === 'user/message') {
          blank = false
          if (firstUserText === null) firstUserText = messageText(event.data)
        }
      }
    }
  } catch {
    // A corrupt tail should not prevent listing the session.
  }
  return {
    title: title ?? firstUserText,
    maxSeq,
    updatedAt: lastTime > 0 ? lastTime : (typeof header?.createdAt === 'number' ? header.createdAt : Date.now()),
    blank,
    header,
  }
}

/**
 * @param {unknown} data user message event data.
 * @returns {string | null} first text content, trimmed for a title.
 */
function messageText(data) {
  const content = data?.message?.content ?? data?.content
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
      const text = part.text.trim().replace(/\s+/g, ' ')
      return text.length > 80 ? `${text.slice(0, 77)}…` : text
    }
  }
  return null
}

/**
 * Whether a file name looks like a session log artifact.
 *
 * @param {string} fileName base name.
 * @returns {boolean} true for `session[.vN].jsonl[.zstd]` and historical names.
 */
export function isSessionLogFile(fileName) {
  return /^session(?:\.[A-Za-z0-9]+)?\.jsonl(?:\.zstd)?$/.test(fileName)
}

/**
 * Parse a repository-relative session path into its parts.
 *
 * @param {string} repoRelative path such as `home/sessions/--E-work--/session-x/session.v4.jsonl.zstd`.
 * @returns {{ projectKey: string, sessionDir: string, fileName: string, directory: string } | null} parts, or null.
 */
export function parseSessionRepoPath(repoRelative) {
  const normalized = repoRelative.split('\\').join('/')
  const match = /^home\/sessions\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(normalized)
  if (!match) return null
  const [, projectKeyValue, sessionDir, fileName] = match
  return {
    projectKey: projectKeyValue,
    sessionDir,
    fileName,
    directory: `home/sessions/${projectKeyValue}/${sessionDir}`,
  }
}

/**
 * Rewrite path occurrences inside one session log file's bytes.
 *
 * The transformation is frame-preserving for compressed logs: each complete
 * frame is decompressed, text-replaced and recompressed into exactly one frame,
 * so the header frame remains a header frame and DSH's frame scanner keeps
 * working. A torn final frame (crash remnant) is copied verbatim and reported.
 *
 * @param {Buffer} bytes log file bytes.
 * @param {Array<{ from: string, to: string }>} replacements path replacements (`from` is replaced by `to`).
 * @returns {{ bytes: Buffer, changed: boolean, warnings: string[] }} transformed bytes.
 */
export function rewriteSessionBytes(bytes, replacements) {
  const effective = replacements.filter((entry) => entry.from && entry.to && entry.from !== entry.to)
  if (effective.length === 0) return { bytes, changed: false, warnings: [] }
  const warnings = []
  if (!isZstd(bytes)) {
    const text = bytes.toString('utf8')
    const replaced = rewritePathText(text, effective)
    const next = Buffer.from(replaced.text, 'utf8')
    return { bytes: next, changed: replaced.changed, warnings }
  }
  const { frames, tornStart } = scanZstdFrames(bytes)
  const chunks = []
  let changed = false
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]
    const plaintext = decodeZstdFrame(bytes, frame).toString('utf8')
    // DSH requires the first frame to be exactly one header line and every
    // later frame to end on a complete JSONL record boundary. Re-framing text
    // must never violate either rule.
    const validHeaderFrame = index !== 0 || /^[^\n]*\n$/u.test(plaintext)
    const validRecordBoundary = plaintext.length === 0 || plaintext.endsWith('\n')
    if (!validHeaderFrame || !validRecordBoundary) {
      warnings.push('会话日志的 zstd 帧边界不符合 DSH 规范（首帧必须恰好一行 header，其余帧必须以换行结束），已跳过路径重写以避免损坏文件。')
      return { bytes, changed: false, warnings }
    }
    const replaced = rewritePathText(plaintext, effective)
    if (replaced.changed) changed = true
    chunks.push(encodeZstdFrame(replaced.text))
  }
  if (tornStart !== null) {
    warnings.push('会话日志尾部存在不完整的 Zstandard 帧（通常是上次异常退出的残留），已按原始字节保留。')
    chunks.push(bytes.subarray(tornStart))
  }
  return { bytes: Buffer.concat(chunks), changed, warnings }
}

/**
 * Compare two session logs for append-only compatibility.
 *
 * DSH only appends events, so a device that pulled before continuing has a log
 * that is a strict line prefix of the other device's log. When that holds, the
 * longer log can be taken without losing either side's events. Divergent
 * histories (both devices appended different events) are reported instead of
 * being merged silently.
 *
 * @param {Buffer} left first log (repository/canonical space).
 * @param {Buffer} right second log.
 * @returns {{ relation: 'equal' | 'left-prefix' | 'right-prefix' | 'diverged', leftLines: number, rightLines: number, commonEvents: number }} comparison.
 */
export function compareSessionLogs(left, right) {
  // Fast path: DSH-written frame bytes are usually a stable prefix, so the
  // byte comparison answers without decompressing anything.
  if (left.equals(right)) return { relation: 'equal', leftLines: 0, rightLines: 0, commonEvents: 0 }
  if (left.length > 0 && right.length > 0) {
    const leftIsPrefix = left.length <= right.length && right.subarray(0, left.length).equals(left)
    const rightIsPrefix = right.length <= left.length && left.subarray(0, right.length).equals(right)
    if (leftIsPrefix || rightIsPrefix) {
      return {
        relation: leftIsPrefix ? 'left-prefix' : 'right-prefix',
        leftLines: 0,
        rightLines: 0,
        commonEvents: -1,
      }
    }
  }
  const leftLines = sessionLines(left)
  const rightLines = sessionLines(right)
  const max = Math.min(leftLines.length, rightLines.length)
  let common = 0
  while (common < max && leftLines[common] === rightLines[common]) common += 1
  const leftEvents = leftLines.length - 1
  const rightEvents = rightLines.length - 1
  let relation
  if (common === leftLines.length && common === rightLines.length) relation = 'equal'
  else if (common === leftLines.length) relation = 'left-prefix'
  else if (common === rightLines.length) relation = 'right-prefix'
  else relation = 'diverged'
  return {
    relation,
    leftLines: leftLines.length,
    rightLines: rightLines.length,
    commonEvents: Math.max(0, common - 1),
  }
}

/**
 * Decode a session log to its physical JSONL rows.
 *
 * @param {Buffer} bytes session log bytes.
 * @returns {string[]} rows without trailing newlines.
 */
function sessionLines(bytes) {
  if (!isZstd(bytes)) {
    return bytes.toString('utf8').split(/\r?\n/u).filter((line) => line.length > 0)
  }
  const lines = []
  try {
    const { frames } = scanZstdFrames(bytes)
    for (const frame of frames) {
      const text = decodeZstdFrame(bytes, frame).toString('utf8')
      for (const line of text.split('\n')) {
        if (line.length > 0) lines.push(line)
      }
    }
  } catch {
    return []
  }
  return lines
}

/**
 * Rewrite exact path occurrences in JSON-ish text.
 *
 * Both raw and JSON-escaped spellings are matched, and forward-slash variants
 * are covered. On Windows matching is case-insensitive because the filesystem
 * is; on POSIX it is case-sensitive.
 *
 * @param {string} text source text.
 * @param {Array<{ from: string, to: string }>} replacements path pairs.
 * @returns {{ text: string, changed: boolean }} rewritten text.
 */
export function rewritePathText(text, replacements) {
  /** @type {Map<string, string>} */
  const variants = new Map()
  for (const { from, to } of replacements) {
    for (const { source, target } of pathVariants(from, to)) {
      if (!variants.has(source)) variants.set(source, target)
    }
  }
  if (variants.size === 0) return { text, changed: false }
  const caseInsensitive = process.platform === 'win32'
  const lookup = new Map()
  for (const [source, target] of variants) lookup.set(caseInsensitive ? source.toLowerCase() : source, target)
  const sources = [...variants.keys()].sort((a, b) => b.length - a.length)
  const pattern = sources.map(escapeRegExp).join('|')
  const flags = caseInsensitive ? 'giu' : 'gu'
  let changed = false
  const regex = new RegExp(pattern, flags)
  const result = text.replace(regex, (matched) => {
    const key = caseInsensitive ? matched.toLowerCase() : matched
    const replacement = lookup.get(key)
    if (replacement === undefined) return matched
    changed = true
    return replacement
  })
  return { text: result, changed }
}

/**
 * Produce aligned source/target spellings for one path pair.
 *
 * Four spellings are covered, each replaced by the same spelling shape of the
 * target: raw, JSON-escaped, forward-slash and JSON-escaped forward-slash.
 *
 * @param {string} from source path.
 * @param {string} to target path.
 * @returns {Array<{ source: string, target: string }>} replacement pairs.
 */
export function pathVariants(from, to) {
  const rawSource = from
  const rawTarget = to
  const forwardSource = from.replaceAll('\\', '/')
  const forwardTarget = to.replaceAll('\\', '/')
  return [
    { source: rawSource, target: rawTarget },
    { source: jsonEscape(rawSource), target: jsonEscape(rawTarget) },
    { source: forwardSource, target: forwardTarget },
    { source: jsonEscape(forwardSource), target: jsonEscape(forwardTarget) },
  ]
}

/**
 * Apply the escaping JSON uses for a string's contents (without quotes).
 *
 * @param {string} value raw string.
 * @returns {string} escaped contents.
 */
export function jsonEscape(value) {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * @param {Buffer} bytes file bytes.
 * @returns {boolean} whether the bytes begin with a Zstandard frame.
 */
function isZstd(bytes) {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC
}

/**
 * @param {string} text log prefix.
 * @returns {object | null} parsed first JSON line.
 */
function parseHeaderLine(text) {
  const newline = text.indexOf('\n')
  const line = (newline === -1 ? text : text.slice(0, newline)).trim()
  if (line.length === 0) return null
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param {string} value raw text.
 * @returns {string} regex-escaped text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
