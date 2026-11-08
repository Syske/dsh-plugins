/**
 * SessionPersistenceAdapter (S1) — read-only wrapper over `ctx.sessionPersistence`
 * (DSH 0.2.1-rc.5).
 *
 * Verified contract (A1-IMPLEMENTATION-CONTRACT.md §8.3):
 *  - ctx.sessionPersistence.open(id, access: 'read'|'write', options?): Promise<SessionHandle>
 *      `read` never takes ownership and works while another handle holds `write`;
 *      `write` atomically claims single-writer ownership.
 *  - SessionHandle.read(offset?, length?, options?): Promise<{ eventState, events }>
 *  - SessionHandle.close(): Promise<void> (idempotent)
 *  - `append` is best-effort; `flush` is the durability barrier.
 *
 * A1 uses this adapter READ-ONLY. A write path (append+flush) is intentionally
 * NOT exposed here: durable Manager idempotency/linkage metadata belongs to S3
 * and, when added, MUST go through a `flush` barrier (see idempotency-store.js).
 */
export class SessionPersistenceAdapter {
  /** @param {any} ctx Cordis context (expects `ctx.sessionPersistence`). */
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** @returns {any} the persistence service, if available. */
  get service() {
    return this.ctx?.sessionPersistence ?? this.ctx?.get?.('sessionPersistence');
  }

  /**
   * Open a READ handle for a stored session (no write ownership taken).
   * @param {string} sessionId
   * @param {{signal?:AbortSignal}} [options]
   * @returns {Promise<any>} SessionHandle
   */
  async openRead(sessionId, options) {
    const svc = this.service;
    if (!svc || typeof svc.open !== 'function') {
      throw new Error('sessionPersistence.open unavailable');
    }
    return svc.open(sessionId, 'read', options);
  }

  /**
   * Read a contiguous event slice from a handle.
   * @param {any} handle
   * @param {number} [offset] first logical event seq (defaults to 0).
   * @param {number} [length] max events (defaults to rest of log).
   * @param {any} [options]
   * @returns {Promise<{eventState:string, events:ReadonlyArray<any>}>}
   */
  async readEvents(handle, offset, length, options) {
    if (!handle || typeof handle.read !== 'function') {
      throw new Error('handle.read unavailable');
    }
    return handle.read(offset, length, options);
  }

  /**
   * Close a handle (idempotent).
   * @param {any} handle
   */
  async closeHandle(handle) {
    if (handle && typeof handle.close === 'function') {
      await handle.close();
    }
  }

  /**
   * Durability barrier: flush every active write handle owned by the service so
   * acknowledged appends become durable (append is best-effort; flush persists).
   * A1 evidence collection MUST call this before reading (whenIdle is NOT a
   * durability barrier — see A1-IMPLEMENTATION-CONTRACT.md §8.3).
   * @returns {Promise<void>}
   */
  async flush() {
    const svc = this.service;
    if (!svc || typeof svc.flush !== 'function') {
      throw new Error('sessionPersistence.flush unavailable');
    }
    return svc.flush();
  }
}
