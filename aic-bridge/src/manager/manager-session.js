/**
 * ManagerSessionManager (S1) — the long-lived, recoverable Manager main session.
 *
 * The Manager is itself a TOP-LEVEL Agent Session with a STABLE sessionId
 * (ADR-004 durable identity, ADR-006 top-level worker form). It is managed via
 * the same lifecycle primitives as workers (ctx.agents.create/resume), kept
 * separate from any worker sessions it later dispatches to.
 *
 * S1 scope: create/resume by a stable id + dispose.
 * S3.0: an explicit, fail-closed Manager model route (provider+model) is passed
 * to ctx.agents.create AND ctx.agents.resume so a resumed Manager keeps the SAME
 * model identity (no silent drift). A partial route (one of provider/model) is
 * rejected with a clear error; an entirely absent route is permitted at this
 * primitive layer (backward compatible) and is blocked by the command entry.
 */
import { WorkerLifecycleAdapter } from '../adapters/worker-lifecycle.js';
import { validateManagerRoute } from '../config.js';

export class ManagerSessionManager {
  /**
   * @param {any} ctx Cordis context.
   * @param {object} [config] resolved config (needs config.manager.sessionId/cwd/provider/model).
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.worker = new WorkerLifecycleAdapter(ctx);
  }

  /**
   * Effective Manager model route derived from config (explicit or none/partial).
   * @returns {{ok:boolean, source:string, provider:string, model:string, reason?:string}}
   */
  modelRoute() {
    return validateManagerRoute(this.config?.manager);
  }

  /**
   * Resolve the agentOptions to pass to create/resume:
   *  - explicit opts.agentOptions wins (already route-checked by the caller);
   *  - otherwise the config-derived route when fully configured;
   *  - a partial config route is a hard error (fail-closed).
   * @param {object} [opts]
   * @returns {object|undefined}
   */
  #resolveAgentOptions(opts = {}) {
    if (opts.agentOptions && (opts.agentOptions.provider || opts.agentOptions.model)) {
      if (!opts.agentOptions.provider || !opts.agentOptions.model) {
        throw new Error('manager agentOptions requires BOTH provider and model');
      }
      return { provider: opts.agentOptions.provider, model: opts.agentOptions.model };
    }
    const route = this.modelRoute();
    if (route.source === 'partial') {
      throw new Error(route.reason);
    }
    return route.ok ? { provider: route.provider, model: route.model } : undefined;
  }

  /**
   * Ensure a Manager session exists: create fresh, or resume a persisted one.
   * Both paths forward the SAME resolved model route so identity is stable.
   * @param {{sessionId?:string, cwd?:string, resume?:boolean, agentOptions?:{provider?:string,model?:string}}} [opts]
   * @returns {Promise<{sessionId:string, handle:object, mode:'create'|'resume'}>}
   */
  async ensure(opts = {}) {
    const sessionId = opts.sessionId || this.config?.manager?.sessionId;
    if (!sessionId) {
      throw new Error('manager.sessionId required (stable identity)');
    }
    const agentOptions = this.#resolveAgentOptions(opts);
    if (opts.resume === true) {
      const handle = await this.worker.resumeWorkerSession({
        resumeSessionId: sessionId,
        ...(agentOptions ? { agentOptions } : {}),
      });
      return { sessionId, handle, mode: 'resume' };
    }
    const cwd = opts.cwd ?? this.config?.manager?.cwd;
    const handle = await this.worker.createWorkerSession({
      sessionId,
      cwd,
      ...(agentOptions ? { agentOptions } : {}),
    });
    return { sessionId, handle, mode: 'create' };
  }

  /**
   * Release a Manager handle (stop loop, unregister, remove session, unwind).
   * @param {object} handle
   */
  async dispose(handle) {
    if (handle) await handle.dispose();
  }
}
