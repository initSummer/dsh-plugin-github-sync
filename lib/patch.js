/**
 * Helpers for the line-oriented patch files (`cordis.patch.yml`).
 *
 * Profile patches are YAML arrays whose entries are addressed by `id`, so a
 * full YAML parser is not required for the one operation the sync engine
 * needs: removing (and re-inserting) the entries that belong to this plugin
 * itself, because those entries describe the *local device* and must not be
 * imported from another machine.
 *
 * @module dsh-plugin-github-sync/patch
 */

/** Package name that identifies this plugin inside patch rows. */
export const OWN_PACKAGE_NAME = 'dsh-plugin-github-sync'

/** Row id that identifies this plugin inside patch rows. */
export const OWN_ROW_ID = 'github-sync'

/**
 * Split a patch file into top-level `- ...` entries, preserving text exactly.
 *
 * @param {string} text patch file content.
 * @returns {{ preamble: string[], entries: string[], newline: string }} split text.
 */
export function splitPatchEntries(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const preamble = []
  const entries = []
  let current = null
  for (const line of lines) {
    if (/^-(\s|$)/.test(line)) {
      if (current !== null) entries.push(current.join(newline))
      current = [line]
      continue
    }
    if (current === null) preamble.push(line)
    else current.push(line)
  }
  if (current !== null) entries.push(current.join(newline))
  // A trailing empty line belongs to the file, not to the last entry.
  if (entries.length > 0) {
    const last = entries[entries.length - 1]
    if (last.endsWith(newline)) entries[entries.length - 1] = last.slice(0, -newline.length)
    else if (last === '') entries.pop()
  }
  return { preamble, entries, newline }
}

/**
 * Whether a top-level patch entry configures this plugin.
 *
 * @param {string} entry single entry text.
 * @returns {boolean} true when the entry mentions this plugin.
 */
export function isOwnEntry(entry) {
  return entry.includes(OWN_PACKAGE_NAME) || new RegExp(`(^|\\s)id:\\s*['"]?${OWN_ROW_ID}['"]?(\\s|$)`, 'u').test(entry)
}

/**
 * Remove this plugin's rows from a patch file.
 *
 * Nested `- insert:` entries are handled by removing only the indented item
 * that names this plugin, leaving sibling rows untouched.
 *
 * @param {string} text patch file content.
 * @returns {{ text: string, removed: number }} filtered content.
 */
export function filterOwnPatchRows(text) {
  if (typeof text !== 'string' || text.length === 0) return { text, removed: 0 }
  const { preamble, entries, newline } = splitPatchEntries(text)
  if (entries.length === 0) return { text, removed: 0 }
  let removed = 0
  const kept = []
  for (const entry of entries) {
    if (!isOwnEntry(entry)) {
      kept.push(entry)
      continue
    }
    const stripped = stripNestedOwnRows(entry)
    if (stripped === null) {
      removed += 1
      continue
    }
    kept.push(stripped)
    removed += 1
  }
  if (removed === 0) return { text, removed: 0 }
  const head = preamble.join(newline).trimEnd()
  if (kept.length === 0) {
    return { text: head.length > 0 ? `${head}${newline}[]${newline}` : `[]${newline}`, removed }
  }
  return { text: `${head}${head.length > 0 ? newline : ''}${kept.join(newline)}${newline}`, removed }
}

/**
 * Extract this plugin's top-level rows from a patch file.
 *
 * @param {string} text patch file content.
 * @returns {string[]} entry texts (without trailing newline).
 */
export function extractOwnPatchRows(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const { entries } = splitPatchEntries(text)
  return entries.filter(isOwnEntry)
}

/**
 * Append rows to patch text when they are not already present.
 *
 * @param {string} text patch file content.
 * @param {string[]} rows entry texts to append.
 * @returns {string} combined patch text.
 */
export function appendPatchRows(text, rows) {
  if (rows.length === 0) return text
  const existing = new Set(extractOwnPatchRows(text).map(normalizeEntry))
  const missing = rows.filter((row) => !existing.has(normalizeEntry(row)))
  if (missing.length === 0) return text
  const base = text.trimEnd()
  if (base.length === 0 || base.trim() === '[]') {
    return `${missing.join('\n')}\n`
  }
  return `${base}\n${missing.join('\n')}\n`
}

/**
 * Strip this plugin's nested rows from an `insert:` entry.
 *
 * @param {string} entry top-level entry text.
 * @returns {string | null} entry without this plugin's nested rows, or null when nothing else remains.
 */
function stripNestedOwnRows(entry) {
  if (!/^-\s*insert:/u.test(entry.trimStart())) return null
  const lines = entry.split(/\r?\n/)
  const kept = []
  let skipping = false
  let hasRows = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (index === 0) {
      kept.push(line)
      continue
    }
    if (/^ {2,4}-\s+/.test(line)) {
      // Start of a nested row. Look ahead within this item for our marker.
      let end = index + 1
      while (end < lines.length && !/^ {2,4}-\s+/.test(lines[end])) end += 1
      const block = lines.slice(index, end).join('\n')
      if (isOwnEntry(block)) {
        skipping = true
        index = end - 1
        continue
      }
      skipping = false
      hasRows = true
      kept.push(line)
      continue
    }
    if (!skipping) kept.push(line)
  }
  return hasRows ? kept.join('\n') : null
}

/**
 * Merge two patch files by top-level row id.
 *
 * Remote rows form the base; local-only rows are appended; when both sides
 * changed the same id the conflict policy decides (local default). Our own
 * rows are stripped before merging and re-appended by the caller.
 *
 * @param {string} ours local side text.
 * @param {string} theirs remote side text.
 * @param {'keep-local' | 'prefer-remote' | 'fail'} policy conflict policy for equal ids.
 * @returns {string} merged patch text.
 */
export function mergePatchTexts(ours, theirs, policy = 'keep-local') {
  const local = splitPatchEntries(filterOwnPatchRows(ours).text)
  const remote = splitPatchEntries(filterOwnPatchRows(theirs).text)
  const rows = new Map()
  const order = []
  for (const entry of remote.entries) {
    const id = patchRowId(entry) ?? `text:${normalizeEntry(entry)}`
    rows.set(id, { text: entry, source: 'remote' })
    order.push(id)
  }
  for (const entry of local.entries) {
    const id = patchRowId(entry) ?? `text:${normalizeEntry(entry)}`
    if (!rows.has(id)) {
      rows.set(id, { text: entry, source: 'local' })
      order.push(id)
      continue
    }
    const existing = rows.get(id)
    if (normalizeEntry(existing.text) !== normalizeEntry(entry)) {
      if (policy === 'fail') throw new Error(`patch 行冲突：${id}`)
      if (policy !== 'prefer-remote') rows.set(id, { text: entry, source: 'local' })
    }
  }
  // Keep the user's explanatory comments, but never carry document content
  // (such as the template's standalone `[]`) into the header: that would emit
  // two YAML documents and break DSH's patch parser.
  const localHead = patchPreamble(local.preamble)
  const remoteHead = patchPreamble(remote.preamble)
  const head = localHead.trim().length > 0 ? localHead : remoteHead
  const entries = order.map((id) => rows.get(id).text)
  const body = entries.length === 0 ? '[]' : entries.join('\n')
  return `${head}${head.length > 0 ? '\n' : ''}${body}\n`
}

/**
 * Extract only the comment/blank lines of a patch preamble.
 *
 * @param {string[]} preamble preamble lines from {@link splitPatchEntries}.
 * @returns {string} comment header without trailing whitespace.
 */
function patchPreamble(preamble) {
  return preamble
    .filter((line) => line.trim().length === 0 || line.trim().startsWith('#'))
    .join('\n')
    .replace(/\s+$/u, '')
}

/**
 * @param {string} entry patch entry text.
 * @returns {string | null} row id when present.
 */
function patchRowId(entry) {
  const match = /(?:^|\s)id:\s*['"]?([A-Za-z0-9@/._-]+)['"]?/u.exec(entry)
  return match ? match[1] : null
}

/**
 * @param {string} entry entry text.
 * @returns {string} whitespace-normalized entry for equality checks.
 */
function normalizeEntry(entry) {
  return entry.trim().replace(/\s+/g, ' ')
}
