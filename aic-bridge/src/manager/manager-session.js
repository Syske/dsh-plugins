/**
 * ManagerSessionManager — the long-lived, recoverable Manager main session.
 *
 * The Manager is a TOP-LEVEL Agent Session with a STABLE sessionId (ADR-004 /
 * ADR-006), managed via ctx.agents.create/resume, separate from workers.
 *
 * S3.0: explicit, fail-closed Manager model route (provider+model) forwarded to
 * create AND resume so a resumed Manager keeps the SAME model identity.
 *
 * S3.1-B: `dispatchTask` performs a durable, idempotent Manager→Worker dispatch:
 *   1) persist dispatch INTENT (state=dispatching) BEFORE any worker action;
 *   2) create/resume a deterministic worker session (explicit linkage);
 *   3) sendMessage (whenIdle + flush) and observe THIS turn's persisted events;
 *   4) persist the outcome. Ambiguity => `unknown` (fail-closed, no auto resend).
 * Records live in the DSH Storage Domain (see aic/idempotency-store.js TaskStore).
 * `completed` is NEVER set here (AIC evaluation is not implemented).
 */
import { WorkerLifecycleAdapter } from '../adapters/worker-lifecycle.js';
import { SessionPersistenceAdapter } from '../adapters/session-persistence.js';
import { validateManagerRoute } from '../config.js';
import { TaskStore, payloadHash, deriveWorkerSessionId } from '../aic/idempotency-store.js';

const IN_FLIGHT = new Set(['dispatching', 'dispatched', 'worker_done', 'completed']);

/** Non-empty assistant text from a worker event, or ''. */
function assistantText(event) {
  if (!event || event.type !== 'assistant/message') return '';
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('').trim();
}

export class ManagerSessionManager {
  /**
   * @param {any} ctx Cordis context.
   * @param {object} [config] resolved config (manager.sessionId/cwd/provider/model).
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.worker = new WorkerLifecycleAdapter(ctx);
    /** @type {TaskStore|null} */ this.taskStore = null;
    this.persistence = new SessionPersistenceAdapter(ctx);
  }

  /** Inject a TaskStore (used by index.js so the store shares the ctx.effect lifecycle). */
  setTaskStore(store) { this.taskStore = store; return this; }

  /** Lazily create/cache a TaskStore over ctx.storageDomain if none was injected. */
  getTaskStore() {
    if (!this.taskStore) this.taskStore = new TaskStore(this.ctx, this.config);
    return this.taskStore;
  }

  /** Release the TaskStore (called from plugin teardown). */
  async closeTasks() { if (this.taskStore) { try { await this.taskStore.close(); } finally { this.taskStore = null; } } }

  /** Look up one persisted task record. */
  async getTask(taskId) { return this.getTaskStore().get(taskId); }

  /** @returns {{ok:boolean, source:string, provider:string, model:string, reason?:string}} */
  modelRoute() { return validateManagerRoute(this.config?.manager); }

  /** Resolve agentOptions to pass to create/resume; partial config is a hard error. */
  #resolveAgentOptions(opts = {}) {
    if (opts.agentOptions && (opts.agentOptions.provider || opts.agentOptions.model)) {
      if (!opts.agentOptions.provider || !opts.agentOptions.model) throw new Error('manager agentOptions requires BOTH provider and model');
      return { provider: opts.agentOptions.provider, model: opts.agentOptions.model };
    }
    const route = this.modelRoute();
    if (route.source === 'partial') throw new Error(route.reason);
    return route.ok ? { provider: route.provider, model: route.model } : undefined;
  }

  /** Ensure a Manager session exists: create fresh or resume a persisted one. */
  async ensure(opts = {}) {
    const sessionId = opts.sessionId || this.config?.manager?.sessionId;
    if (!sessionId) throw new Error('manager.sessionId required (stable identity)');
    const agentOptions = this.#resolveAgentOptions(opts);
    if (opts.resume === true) {
      const handle = await this.worker.resumeWorkerSession({ resumeSessionId: sessionId, ...(agentOptions ? { agentOptions } : {}) });
      return { sessionId, handle, mode: 'resume' };
    }
    const cwd = opts.cwd ?? this.config?.manager?.cwd;
    const handle = await this.worker.createWorkerSession({ sessionId, cwd, ...(agentOptions ? { agentOptions } : {}) });
    return { sessionId, handle, mode: 'create' };
  }

  /** Release a Manager handle. */
  async dispose(handle) { if (handle) await handle.dispose(); }

  /** Read all persisted events of a worker session (flush barrier first). */
  async #readWorkerEvents(sessionId) {
    await this.persistence.flush();
    const h = await this.persistence.openRead(sessionId);
    try { return (await this.persistence.readEvents(h, 0, undefined))?.events ?? []; }
    finally { await this.persistence.closeHandle(h); }
  }

  /** Persist a failed terminal state with a structured error (best-effort). */
  async #persistFailure(store, rec, stage, err) {
    const lastError = { code: (err && (err.code || err.message)) ? (err.code || err.message) : String(err), message: String((err && err.message) || err), at: Date.now() };
    try { await store.put({ ...rec, state: 'failed', lastError, updatedAt: Date.now() }); } catch { /* keep intent record */ }
    return { taskId: rec.taskId, status: 'failed', state: 'failed', stage, error: lastError.message, workerSessionId: rec.workerSessionId, managerSessionId: rec.managerSessionId };
  }

  /**
   * Durable, idempotent Manager→Worker dispatch of a single task.
   * @param {{taskId:string, text:string, agentOptions?:object}} spec
   */
  async dispatchTask(spec = {}) {
    const { taskId } = spec;
    const text = typeof spec.text === 'string' ? spec.text.trim() : '';
    if (typeof taskId !== 'string' || !taskId) throw new Error('dispatchTask requires a non-empty taskId');
    if (!text) throw new Error('dispatchTask requires non-empty text');
    const route = this.modelRoute();
    if (!route.ok) { const e = new Error(`manager model route not configured: ${route.reason}`); e.code = 'AIC_MANAGER_ROUTE_UNCONFIGURED'; throw e; }
    const store = getStoreOrThrow(this.getTaskStore());

    await store.open();
    const ph = payloadHash(text);
    const existing = await store.get(taskId);
    if (existing) {
      if (existing.payloadHash !== ph) return { taskId, status: 'conflict', state: existing.state, note: 'payload hash differs for same taskId; refusing' };
      if (IN_FLIGHT.has(existing.state)) {
        return { taskId, status: existing.state === 'dispatching' ? 'unknown' : 'idempotent', state: existing.state, workerSessionId: existing.workerSessionId, managerSessionId: existing.managerSessionId, idempotentReplay: true, note: existing.state === 'dispatching' ? 'prior intent unresolved; resolve before retry' : 'already dispatched' };
      }
      if (existing.state !== 'created' && existing.state !== 'failed') {
        return { taskId, status: 'blocked', state: existing.state, note: 'terminal/uncertain state; no auto re-dispatch' };
      }
    }
    const managerSessionId = this.config?.manager?.sessionId;
    const workerSessionId = (existing && existing.workerSessionId) || deriveWorkerSessionId(taskId);
    const attempt = (existing?.attempt ?? 0) + 1;
    const now = Date.now();
    const base = existing || { taskId, payloadHash: ph, managerSessionId, workerSessionId, attempt: 0, completionBasis: 'unknown', createdAt: now };
    const intent = { ...base, state: 'dispatching', payloadHash: ph, attempt, workerSessionId, managerSessionId, completionBasis: 'unknown', updatedAt: now };
    // (1) persist INTENT FIRST — durable before any worker action (crash window W1 entry)
    await store.put(intent);

    // (2) create or reuse the deterministic worker session
    let handle;
    try {
      handle = await this.worker.createWorkerSession({ sessionId: workerSessionId, agentOptions: { provider: route.provider, model: route.model } });
    } catch (e) {
      if (/AlreadyExists|already exists|AlreadyOwned/i.test(String((e && e.message) || e))) {
        try { handle = await this.worker.resumeWorkerSession({ resumeSessionId: workerSessionId, agentOptions: { provider: route.provider, model: route.model } }); }
        catch (e2) { return this.#persistFailure(store, intent, 'worker-resume', e2); }
      } else {
        return this.#persistFailure(store, intent, 'worker-create', e);
      }
    }

    // (3) snapshot the pre-dispatch event length, then send
    let offset = 0;
    try { offset = (await this.#readWorkerEvents(workerSessionId)).length; } catch { offset = 0; }
    let send;
    try { send = await this.worker.sendMessage(handle, text); }
    catch (e) { try { await handle.dispose?.(); } catch {} return this.#persistFailure(store, intent, 'send', e); }

    // (4) observe THIS turn from persisted worker events (cannot prove => unknown)
    let fresh = null;
    try { fresh = (await this.#readWorkerEvents(workerSessionId)).slice(offset); } catch { fresh = null; }
    const accepted = !!fresh && fresh.some((e) => e.type === 'user/message');
    const replied = !!fresh && fresh.some((e) => assistantText(e).length > 0);

    // (5) persist outcome. completed is NOT reachable (AIC evaluation absent).
    let finalState;
    if (!send || !send.executed || !send.persisted) finalState = 'failed';
    else if (replied) finalState = 'worker_done';
    else finalState = 'unknown'; // executed+persisted but no reply => cannot prove
    try { await store.put({ ...intent, state: finalState, completionBasis: 'unknown', updatedAt: Date.now() }); } catch { /* keep intent */ }
    try { await handle.dispose?.(); } catch {}

    return {
      taskId, status: finalState, state: finalState,
      workerSessionId, managerSessionId,
      accepted, executed: !!(send && send.executed), persisted: !!(send && send.persisted),
      workerReplied: replied, completionBasis: 'unknown', idempotentReplay: false,
    };
  }

  /**
   * Resolve an interrupted (`dispatching`) task from evidence — NEVER auto-resends.
   * @param {string} taskId
   */
  async resolveRecovery(taskId) {
    const store = this.getTaskStore();
    await store.open();
    const rec = await store.get(taskId);
    if (!rec) return { taskId, resolved: 'not-found' };
    if (rec.state !== 'dispatching') return { taskId, resolved: rec.state, state: rec.state };
    if (!rec.workerSessionId) return { taskId, resolved: 'unknown', note: 'dispatching without worker session; manual decision' };
    let events = null;
    try { events = await this.#readWorkerEvents(rec.workerSessionId); } catch { events = null; }
    if (events) {
      const user = events.some((e) => e.type === 'user/message');
      const reply = events.some((e) => assistantText(e).length > 0);
      if (user && reply) {
        const next = { ...rec, state: 'worker_done', completionBasis: 'unknown', updatedAt: Date.now() };
        try { await store.put(next); } catch { /* keep intent */ }
        return { taskId, resolved: 'worker_done', state: 'worker_done', note: 'evidence: user+reply present' };
      }
      if (!user) return { taskId, resolved: 'unknown', state: 'dispatching', note: 'no message observed; manual decision (no auto re-dispatch)' };
      return { taskId, resolved: 'unknown', state: 'dispatching', note: 'message present but no reply; manual decision' };
    }
    return { taskId, resolved: 'unknown', state: 'dispatching', note: 'unreadable worker events' };
  }
}

function getStoreOrThrow(store) {
  if (!store) { const e = new Error('task store unavailable'); e.code = 'AIC_STORAGE_UNAVAILABLE'; throw e; }
  return store;
}

export { assistantText };
