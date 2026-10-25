class AppError extends Error {
  /**
   * @param {string} message - user-safe message
   * @param {number} statusCode - HTTP status
   * @param {{ code?: string, reasonCode?: string, details?: object }} [meta]
   *   Machine-readable operational error. `code` is stable and safe to branch
   *   on in clients; `details` must never contain raw provider errors or
   *   payment internals. Prefixed as `errorCode` so it cannot collide with
   *   Node/Prisma `error.code` values.
   */
  constructor(message, statusCode, meta = {}) {
    super(message);

    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.errorCode = meta.code || null;
    this.reasonCode = meta.reasonCode || null;
    this.details = meta.details || null;

    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
