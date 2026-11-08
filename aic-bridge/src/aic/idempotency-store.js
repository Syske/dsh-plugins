/**
 * IdempotencyStore (S1 placeholder) — durable task-level idempotency + linkage
 * record for the Manager.
 *
 * CONTRACT / GAP (A1-IMPLEMENTATION-CONTRACT.md §7.3/§7.4/§8.3):
 *  - The existing Bridge `ExecutionIdempotencyManager` is IN-MEMORY only and is
 *    insufficient: a process restart loses it, so it cannot prevent re-dispatch.
 *  - The real store MUST be durable and MUST go through the persistence FLUSH
 *    BARRIER (append is best-effort; only flush guarantees crash survival).
 *  - It must hold an EXPLICIT run_id <-> session_id linkage (no inference).
 *
 * S3 scope (durable implementation via SessionPersistenceAdapter write+flush) is
 * NOT implemented here. This class is an in-memory placeholder that documents
 * the required semantics and states the record shape. Do not rely on it for
 * crash-safe dedup.
 */

/**
 * @typedef {Object} IdempotencyRecord
 * @property {string} taskId      stable task key
 * @property {string} state       'dispatched' | 'completed' | 'failed'
 * @property {string} [runId]     AIC run id (explicit linkage)
 * @property {string} [sessionId] DSH worker session id (explicit linkage)
 * @property {number} [updatedAt] epoch ms
 */

export class IdempotencyStore {
  constructor() {
    /** @type {Map<string, IdempotencyRecord>} */
    this.map = new Map();
  }

  /**
   * TODO(S3): persist via sessionPersistence append(...) + flush() barrier.
   * @param {string} taskId
   * @returns {IdempotencyRecord|undefined}
   */
  get(taskId) {
    return this.map.get(taskId);
  }

  /**
   * TODO(S3): durably persist (append + flush barrier) before returning.
   * @param {string} taskId
   * @param {Partial<IdempotencyRecord>} record
   * @returns {IdempotencyRecord}
   */
  set(taskId, record) {
    const next = { taskId, updatedAt: Date.now(), ...record };
    this.map.set(taskId, next);
    return next;
  }

  /** @param {string} taskId @returns {boolean} */
  isDispatched(taskId) {
    return this.map.get(taskId)?.state === 'dispatched';
  }
}
