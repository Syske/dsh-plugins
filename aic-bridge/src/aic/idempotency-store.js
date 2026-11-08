/**
 * Durable task records + idempotency (S3.1-B) over the DSH Storage Domain.
 *
 * Storage landing zone (verified S3.1-A2): `ctx.storageDomain` (dsh-storage +
 * dsh-storage-json + dsh-storage-domain). The Storage Domain API consumes the
 * table schema duck-typed — it only calls `valueSchema.parse(raw)` at OPEN time
 * — so this module supplies a plain object with a `parse(raw)` method and needs
 * NO `zod` import and NO `@deepseek-ai/dsh-storage-domain` import. This keeps
 * the plugin dependency-free and inside the 7-file S3.1-B boundary.
 *
 * Record schema is validated on EVERY write-before-commit (put/update) AND at
 * OPEN (via `spec.tables.task.valueSchema.parse`). See validateTaskRecord.
 *
 * Single-writer: storage-json is atomic+fsync but has NO cross-process lock
 * ("one writer per process, last-write-wins"). Callers must assume a single
 * writer process per storage root; this store does not add locking.
 */

/** Legal task states. NOTE: `completed` is reachable ONLY with real AIC evidence. */
export const TASK_STATES = Object.freeze([
  'created', 'dispatching', 'dispatched', 'worker_done', 'completed', 'failed', 'cancelled', 'unknown',
]);
const STATE_SET = new Set(TASK_STATES);

/** Deterministic 32-bit hash (djb2) -> 8 hex chars. */
function hash32(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}
function hex8(n) { return ('0000000' + n.toString(16)).slice(-8); }

/** Stable payload hash used for idempotent-conflict detection. */
export function payloadHash(text) { return 'ph_' + hex8(hash32(text)); }

/** Deterministic worker session id derived from taskId (stable across restarts). */
export function deriveWorkerSessionId(taskId) {
  return 'wkr-aic-' + hex8(hash32(taskId)) + hex8(hash32('#' + taskId));
}

/**
 * Validate a TaskRecord against the schema. Throws on violation (write-side
 * guard + the Storage Domain open-time `parse`). Returns the record.
 * @param {any} r
 * @returns {any}
 */
export function validateTaskRecord(r) {
  if (!r || typeof r !== 'object') throw new Error('TaskRecord must be an object');
  if (typeof r.taskId !== 'string' || !r.taskId) throw new Error('TaskRecord.taskId required (string)');
  if (typeof r.payloadHash !== 'string') throw new Error('TaskRecord.payloadHash must be a string');
  if (!STATE_SET.has(r.state)) throw new Error(`TaskRecord.state invalid: ${String(r.state)}`);
  if (typeof r.managerSessionId !== 'string' || !r.managerSessionId) throw new Error('TaskRecord.managerSessionId required');
  if (r.workerSessionId !== undefined && typeof r.workerSessionId !== 'string') throw new Error('TaskRecord.workerSessionId must be a string');
  if (r.runId !== undefined && typeof r.runId !== 'string') throw new Error('TaskRecord.runId must be a string');
  if (!Number.isInteger(r.attempt) || r.attempt < 0) throw new Error('TaskRecord.attempt must be an integer >= 0');
  if (r.completionBasis !== 'unknown' && r.completionBasis !== 'aic-evaluated') throw new Error("TaskRecord.completionBasis must be 'unknown'|'aic-evaluated'");
  if (r.lastError !== undefined && (typeof r.lastError !== 'object' || r.lastError === null)) throw new Error('TaskRecord.lastError must be an object');
  if (typeof r.createdAt !== 'number') throw new Error('TaskRecord.createdAt must be a number');
  if (typeof r.updatedAt !== 'number') throw new Error('TaskRecord.updatedAt must be a number');
  return r;
}

const DOMAIN_NAME = 'aic_bridge_tasks';
const DOMAIN_VERSION = 1;
const TABLE_NAME = 'task';

/**
 * Durable TaskRecord store over `ctx.storageDomain`.
 * Lazy-opens the domain on first use; `close()` idempotently releases it.
 */
export class TaskStore {
  /** @param {any} ctx Cordis context (expects ctx.storageDomain). @param {object} [config] */
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.dom = null;
    this.opening = null;
    this.closed = false;
  }

  #facility() {
    const f = this.ctx?.storageDomain ?? this.ctx?.get?.('storageDomain');
    if (!f || typeof f.open !== 'function') {
      const e = new Error('storage-domain unavailable (ctx.storageDomain) — cannot persist task records');
      e.code = 'AIC_STORAGE_UNAVAILABLE';
      throw e;
    }
    return f;
  }

  /** Literal DomainSpec (duck-typed schema; no zod/domain import needed). */
  #spec() {
    return {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      layout: 'single',
      tables: {
        [TABLE_NAME]: { valueSchema: { parse(raw) { return validateTaskRecord(raw); } } },
      },
    };
  }

  /** @returns {Promise<any>} the open domain (idempotent). */
  async open() {
    if (this.dom) return this.dom;
    if (this.closed) throw new Error('TaskStore closed');
    if (!this.opening) {
      this.opening = this.#facility().open(this.#spec())
        .then((d) => { this.dom = d; this.opening = null; return d; })
        .catch((e) => { this.opening = null; throw e; });
    }
    return this.opening;
  }

  async close() {
    this.closed = true;
    if (this.dom) { const d = this.dom; this.dom = null; try { await d.close(); } catch { /* best-effort */ } }
  }

  #table() { if (!this.dom) throw new Error('TaskStore not open'); return this.dom.table(TABLE_NAME); }

  /** @param {string} taskId @returns {Promise<any|undefined>} */
  async get(taskId) {
    await this.open();
    const rec = this.#table().get(taskId);
    // Self-heal: a non-`failed` record must not carry a stale `lastError` left by an
    // earlier failed attempt (older builds persisted it). Rewrite once so reads are
    // consistent with the current invariant. Best-effort (the host owns the store;
    // this is a plugin process write).
    if (rec && rec.state !== 'failed' && 'lastError' in rec) {
      const cleaned = { ...rec };
      delete cleaned.lastError;
      try { await this.#table().put(taskId, cleaned); return cleaned; } catch { /* keep original */ }
    }
    return rec;
  }

  /** Write-before validation, then durable put. @param {any} record */
  async put(record) {
    validateTaskRecord(record);
    await this.open();
    await this.#table().put(record.taskId, record);
    return record;
  }

  /** Serialized read-modify-write with write-before validation (runs at chain slot). */
  async update(taskId, fn) {
    await this.open();
    return this.#table().update(taskId, (cur) => { const next = fn(cur); validateTaskRecord(next); return next; });
  }

  async isDispatched(taskId) { return (await this.get(taskId))?.state === 'dispatched'; }
}

/**
 * @deprecated Backward-compatible alias (S1 in-memory placeholder replaced by
 * the durable TaskStore). Kept so existing wiring/exports do not break.
 */
export const IdempotencyStore = TaskStore;
