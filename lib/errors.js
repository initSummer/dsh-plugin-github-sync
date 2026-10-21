/**
 * Typed errors used by the sync engine so the plugin, the CLI and the model
 * tool can distinguish user-actionable failures from unexpected bugs.
 *
 * @module dsh-plugin-github-sync/errors
 */

/** Base class for expected sync failures. */
export class SyncError extends Error {
  /**
   * @param {string} message user-facing message (Chinese).
   * @param {{ code?: string, hint?: string, cause?: unknown }} [details] extra context.
   */
  constructor(message, details = {}) {
    super(message, { cause: details.cause })
    this.name = 'SyncError'
    this.code = details.code ?? 'SYNC_ERROR'
    this.hint = details.hint ?? ''
  }
}

/** Raised when the configuration is incomplete or invalid. */
export class SyncConfigError extends SyncError {
  /**
   * @param {string} message user-facing message.
   * @param {{ hint?: string, cause?: unknown }} [details] extra context.
   */
  constructor(message, details = {}) {
    super(message, { ...details, code: 'SYNC_CONFIG' })
    this.name = 'SyncConfigError'
  }
}

/** Raised when two devices changed the same file and the policy is `fail`. */
export class SyncConflictError extends SyncError {
  /**
   * @param {string[]} files conflicting repository-relative paths.
   */
  constructor(files) {
    super(`同步冲突：${files.length} 个文件在两台设备上都有改动。`, {
      code: 'SYNC_CONFLICT',
      hint: '把 onConflict 调整为 keep-local（默认，保留本机版本）或 prefer-remote 后重试，或手动处理下列文件：\n' + files.join('\n'),
    })
    this.name = 'SyncConflictError'
    this.files = files
  }
}
