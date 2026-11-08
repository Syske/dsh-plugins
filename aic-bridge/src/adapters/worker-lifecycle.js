/**
 * WorkerLifecycleAdapter (S1) — wraps `ctx.agents` (DSH 0.2.1-rc.5).
 *
 * Verified contract (A1-IMPLEMENTATION-CONTRACT.md §8.1/§8.2):
 *  - ctx.agents.create(options): Promise<AgentHandle>
 *      options.sessionId required; omit `parentAgent` => TOP-LEVEL agent;
 *      agent and session share the SAME id (handle.agent.id === sessionId).
 *  - ctx.agents.resume(options): Promise<AgentHandle>
 *      options.resumeSessionId; depends on sessionPersistence; opens a WRITE
 *      handle and reads/repairs the log -> NOT a read-only operation.
 *  - AgentHandle = { agent, dispose(): Promise<void> }.
 *  - agent.cancel(cause, options?) / agent.whenIdle() / agent.status.
 *
 * NOTE: sessionId / resumeSessionId are passed through as strings. At runtime
 * the DSH `SessionId` brand is an identity function over the string, so a plain
 * string is accepted; this adapter deliberately avoids importing DSH packages
 * so it stays syntax-checkable without the dependency graph installed.
 */
import { SessionPersistenceAdapter } from './session-persistence.js';

export class WorkerLifecycleAdapter {
  /**
   * @param {any} ctx Cordis context (expects `ctx.agents`).
   * @param {{createUserMessage?:Function}} [deps] optional message factory; when
   *   omitted the factory is lazily imported from `@deepseek-ai/dsh-llm` at call time.
   */
  constructor(ctx, deps = {}) {
    this.ctx = ctx;
    this.createUserMessage = deps.createUserMessage;
  }

  /** @returns {any} the agent registry, if available. */
  get agents() {
    return this.ctx?.agents ?? this.ctx?.get?.('agents');
  }

  /**
   * Create a TOP-LEVEL worker agent session (Manager stays separate).
   * @param {{sessionId:string, cwd?:string, agentOptions?:object, signal?:AbortSignal}} opts
   * @returns {Promise<object>} WorkerHandle
   */
  async createWorkerSession(opts = {}) {
    const agents = this.agents;
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('agents.create unavailable');
    }
    if (!opts.sessionId) throw new Error('createWorkerSession requires sessionId');
    const req = { sessionId: opts.sessionId };
    if (opts.cwd) req.meta = { cwd: opts.cwd };
    if (opts.agentOptions) req.agentOptions = opts.agentOptions;
    if (opts.signal) req.signal = opts.signal;
    // parentAgent intentionally omitted => top-level agent (ADR-006).
    const handle = await agents.create(req);
    return this.#wrap(handle);
  }

  /**
   * Resume an existing worker agent session by its persisted id.
   * @param {{resumeSessionId:string, agentOptions?:object, signal?:AbortSignal}} opts
   * @returns {Promise<object>} WorkerHandle
   */
  async resumeWorkerSession(opts = {}) {
    const agents = this.agents;
    if (!agents || typeof agents.resume !== 'function') {
      throw new Error('agents.resume unavailable');
    }
    if (!opts.resumeSessionId) throw new Error('resumeWorkerSession requires resumeSessionId');
    const req = { resumeSessionId: opts.resumeSessionId };
    if (opts.agentOptions) req.agentOptions = opts.agentOptions;
    if (opts.signal) req.signal = opts.signal;
    const handle = await agents.resume(req);
    return this.#wrap(handle);
  }

  /**
   * Resolve the DSH message factory (`createUserMessage`) lazily, so this module
   * stays syntax-checkable without the DSH dependency graph installed.
   * @returns {Promise<Function>}
   */
  async #createUserMessageFactory() {
    if (typeof this.createUserMessage === 'function') return this.createUserMessage;
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      if (typeof mod.createUserMessage === 'function') {
        this.createUserMessage = mod.createUserMessage;
        return this.createUserMessage;
      }
    } catch (error) {
      throw new Error('createUserMessage unavailable: pass it via WorkerLifecycleAdapter(ctx,{createUserMessage}) (' + (error?.code ?? error?.message) + ')');
    }
    throw new Error('createUserMessage unavailable: pass it via WorkerLifecycleAdapter(ctx,{createUserMessage})');
  }

  /**
   * Send one text message to the real DSH Agent Loop and wait for the turn to
   * settle, then enforce an explicit Persistence.flush() durability barrier.
   *
   * Wraps DSH `createUserMessage()` + `agent.followup()` + `agent.whenIdle()`.
   * Returns a STRUCTURED result that distinguishes execution completion from
   * persistence completion (whenIdle is NOT a durability barrier).
   *
   * @param {object} handle WorkerHandle from createWorkerSession/resumeWorkerSession.
   * @param {string} text Non-empty message text.
   * @param {{flush?:boolean}} [opts] flush=false skips the persistence barrier.
   * @returns {Promise<{sessionId:string, executed:boolean, persisted:boolean, flushError:any}>}
   */
  async sendMessage(handle, text, opts = {}) {
    if (!handle || typeof handle.followup !== 'function' || typeof handle.whenIdle !== 'function') {
      throw new Error('sendMessage requires a WorkerHandle (createWorkerSession/resumeWorkerSession)');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('sendMessage requires a non-empty string');
    }
    const make = await this.#createUserMessageFactory();
    const message = make({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    handle.followup(message);
    await handle.whenIdle();
    const result = { sessionId: handle.agentId, executed: true, persisted: false, flushError: null };
    if (opts.flush === false) return result;
    const persistence = new SessionPersistenceAdapter(this.ctx);
    try {
      await persistence.flush();
      result.persisted = true;
    } catch (error) {
      result.flushError = error && (error.code ?? error.message) ? (error.code ?? error.message) : String(error);
    }
    return result;
  }

  /**
   * Normalize an AgentHandle into the stable A1 WorkerHandle surface.
   * @param {{agent:any, dispose:()=>Promise<void>}} handle
   */
  #wrap(handle) {
    const agent = handle.agent;
    return {
      get agentId() {
        return agent.id;
      },
      get agent() {
        return agent;
      },
      send: (message, target = 'next-turn', wakeup = true) => agent.send(message, target, wakeup),
      followup: (message) => agent.followup(message),
      steer: (message) => agent.steer(message),
      whenIdle: () => agent.whenIdle(),
      cancel: (cause = { kind: 'user' }, options) => agent.cancel(cause, options),
      dispose: () => handle.dispose(),
    };
  }
}
