/**
 * In-memory mock Cordis ctx for bounded lifecycle tests (no DSH packages needed).
 * Records calls so adapters/manager wiring can be asserted precisely.
 */

function makeAgent(id, calls) {
  return {
    id,
    status: 'idle',
    send(...a) { (calls.send ||= []).push(a); },
    followup(m) { (calls.followup ||= []).push(m); },
    steer(m) { (calls.steer ||= []).push(m); },
    async whenIdle() { calls.whenIdle += 1; },
    cancel(cause, opts) { calls.cancel.push([cause, opts]); },
  };
}

/**
 * @param {{approvalOutcome?:string, approvalThrow?:boolean, approvalMissing?:boolean}} [options]
 */
export function makeMockCtx(options = {}) {
  const calls = {
    create: [], resume: [], cancel: [], whenIdle: 0, dispose: [],
    open: [], read: [], close: [], append: [], flush: [], approvalRequest: [],
    persistenceCreate: 0,
  };

  const agents = {
    async create(req) {
      calls.create.push(req);
      return { agent: makeAgent(req.sessionId, calls), dispose: async () => { calls.dispose.push(req.sessionId); } };
    },
    async resume(req) {
      calls.resume.push(req);
      return { agent: makeAgent(req.resumeSessionId, calls), dispose: async () => { calls.dispose.push(req.resumeSessionId); } };
    },
    list() { return []; },
    get() { return undefined; },
  };

  const sessionPersistence = {
    async open(id, access, opts) {
      calls.open.push([id, access, opts]);
      return {
        id,
        access,
        async read(offset, length, o) {
          calls.read.push([offset, length, o]);
          return { eventState: 'detached', events: [{ seq: 0, type: 'turn/start' }] };
        },
        async append(events, o) { calls.append.push([events, o]); },
        async flush(o) { calls.flush.push(o); },
        async close() { calls.close.push(id); },
      };
    },
    async create() { calls.persistenceCreate += 1; throw new Error('create must not be called by read-only adapter'); },
    async list() { return []; },
  };

  const approval = {
    async request(req) {
      calls.approvalRequest.push(req);
      if (options.approvalThrow) throw new Error('approval.request() outside an open turn');
      return options.approvalOutcome ?? 'allowed-once';
    },
  };

  const state = { calls, effects: [], options };

  const services = { agents, sessionPersistence, approval };
  if (options.approvalMissing) services.approval = undefined;

  const ctx = {
    agents: services.agents,
    sessionPersistence: services.sessionPersistence,
    approval: services.approval,
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return services[name]; },
    effect(fn) { state.effects.push(fn); return () => {}; },
    inject(_deps, cb) { return cb(ctx); },
    on() { return () => {}; },
  };

  return { ctx, state, calls, services };
}
