/**
 * aic-bridge S3.0 — minimal Manager command entry (slash commands via ctx.commands).
 *
 * Registers:
 *   /aic-status  — report the canonical Manager session identity + model route + reply/task counts.
 *   /aic <text>  — send <text> to the canonical Manager session and report an HONEST status:
 *                  accepted / queued→executed / persisted / replied / failed / unknown.
 *
 * Guarantees (per A1 constraints):
 *  - FAIL-CLOSED model route: with no (or a partial) manager.provider+model, /aic and
 *    /aic-status refuse to create a Manager or send a task and return a clear config error.
 *    (An explicit route is always passed to ctx.agents.create/resume, so a Manager can
 *    actually produce a model response — never a silent empty turn.)
 *  - Canonical Manager has ONE stable identity; the live handle is cached so repeated
 *    commands never create a duplicate Manager; the UI Session agent is NEVER used.
 *  - Status is derived from the PERSISTED events of THIS turn (an assistant/message with
 *    non-empty text after the dispatch offset). A turn that completes + flushes but has no
 *    non-empty reply is reported as failure/unknown, never a fabricated success.
 *  - No approval/autonomy policy is bypassed. No AIC evaluation (out of scope, S3.1).
 */
import { ManagerSessionManager } from './manager/manager-session.js';
import { SessionPersistenceAdapter } from './adapters/session-persistence.js';
import { validateManagerRoute } from './config.js';

/** Concatenated non-empty text of an assistant/message event, or ''. */
function assistantText(event) {
  if (!event || event.type !== 'assistant/message') return '';
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('').trim();
}

/** Summarize a full event list (status view). */
function summarize(events) {
  const list = Array.isArray(events) ? events : [];
  const replies = list.filter((e) => assistantText(e).length > 0);
  const lastReply = replies.length ? assistantText(replies[replies.length - 1]).slice(-160) : undefined;
  return {
    eventCount: list.length,
    tasks: list.filter((e) => e.type === 'user/message').length,
    replies: replies.length,
    lastReply,
  };
}

/**
 * @param {any} ctx Cordis context (expects ctx.commands; optional ctx.effect for cleanup).
 * @param {object} config resolved config (needs config.manager.sessionId/cwd/provider/model).
 * @param {{manager?:object, worker?:object, persistence?:object, readSession?:(sid:string)=>Promise<Array>}} [deps]
 * @returns {Array<() => void>} disposers (each unregisters a command / releases resources).
 */
export function installCommands(ctx, config = {}, deps = {}) {
  const commands = ctx?.commands;
  const disposers = [];
  if (!commands || typeof commands.register !== 'function') {
    return disposers; // no command runtime mounted (e.g. minimal tree without dsh-commands)
  }
  const manager = deps.manager ?? new ManagerSessionManager(ctx, config);
  const worker = deps.worker ?? manager.worker;
  const persistence = deps.persistence ?? new SessionPersistenceAdapter(ctx);
  const route = validateManagerRoute(config?.manager);

  /** Read all persisted events for a session (flush barrier first). */
  const readSession = deps.readSession ?? (async (sid) => {
    await persistence.flush();
    const h = await persistence.openRead(sid);
    try {
      const r = await persistence.readEvents(h, 0, undefined);
      return r?.events ?? [];
    } finally {
      await persistence.closeHandle(h);
    }
  });

  // Single canonical Manager handle, shared across command invocations.
  /** @type {any} */ let managerHandle = null;
  /** @type {string|null} */ let managerId = config?.manager?.sessionId ?? null;

  async function ensureManager() {
    if (!route.ok) {
      const err = new Error(`manager model route not configured: ${route.reason}`);
      err.code = 'AIC_MANAGER_ROUTE_UNCONFIGURED';
      throw err;
    }
    if (managerHandle) return { handle: managerHandle, sessionId: managerId, mode: 'reused' };
    const agentOptions = { provider: route.provider, model: route.model };
    try {
      const r = await manager.ensure(managerId ? { sessionId: managerId, agentOptions } : { agentOptions });
      managerHandle = r.handle; managerId = r.sessionId;
      return { handle: r.handle, sessionId: r.sessionId, mode: r.mode };
    } catch (e) {
      if (/AlreadyExists|already exists|AlreadyOwned/i.test(String(e?.message ?? e))) {
        const r = await manager.ensure({ ...(managerId ? { sessionId: managerId } : {}), agentOptions, resume: true });
        managerHandle = r.handle; managerId = r.sessionId;
        return { handle: r.handle, sessionId: r.sessionId, mode: 'resume' };
      }
      throw e;
    }
  }

  disposers.push(commands.register({
    name: 'aic-status',
    description: 'Show canonical AIC Manager status (model route, identity, reply/task counts).',
    async handler() {
      if (!route.ok) {
        return { kind: 'error', text: `AIC Manager not started: ${route.reason}. Configure manager.provider and manager.model.` };
      }
      try {
        const r = await ensureManager();
        let stats = { eventCount: 0, tasks: 0, replies: 0, lastReply: undefined };
        try { stats = summarize(await readSession(r.sessionId)); } catch { /* best-effort view */ }
        const status = stats.replies > 0 ? 'ready' : 'cold (no replies yet)';
        return {
          kind: 'success',
          text: `AIC Manager: ${r.mode} status=${status} session=${r.sessionId} agent=${r.handle.agentId} ` +
            `route=${route.provider}/${route.model} events=${stats.eventCount} tasks=${stats.tasks} replies=${stats.replies}` +
            (stats.lastReply ? ` lastReply=${stats.lastReply}` : ''),
        };
      } catch (e) {
        return { kind: 'error', text: `aic-status failed: ${e?.message ?? e}` };
      }
    },
  }));

  disposers.push(commands.register({
    name: 'aic',
    description: 'Send <task text> to the canonical AIC Manager session. Reports accepted/executed/persisted/replied/failed/unknown.',
    handler: async (invocation) => {
      const text = String(invocation?.rawInput ?? '').trim();
      if (!text) return { kind: 'error', text: 'usage: /aic <task text>' };
      if (!route.ok) {
        return { kind: 'error', text: `blocked: ${route.reason}. Configure manager.provider and manager.model before sending.` };
      }
      try {
        const r = await ensureManager();
        // Snapshot persisted length BEFORE dispatch so we can isolate THIS turn's events.
        let before = [];
        try { before = await readSession(r.sessionId); } catch { before = []; }
        const offset = before.length;

        const res = await worker.sendMessage(r.handle, text);

        let after = null;
        try { after = await readSession(r.sessionId); } catch { after = null; }
        const fresh = Array.isArray(after) ? after.slice(offset) : null;
        const accepted = !!fresh && fresh.some((e) => e.type === 'user/message');
        const reply = !!fresh && fresh.some((e) => assistantText(e).length > 0);
        const lastReply = fresh ? (fresh.map(assistantText).filter(Boolean).slice(-1)[0] || '') : '';

        const parts = [];
        if (accepted) parts.push('accepted');
        if (res.executed) parts.push('queued→executed');
        if (res.persisted) parts.push('persisted');
        if (reply) parts.push('replied');
        if (!reply) parts.push('no model response');

        // HONEST verdict: success requires a non-empty persisted assistant reply.
        if (after === null) {
          return { kind: 'error', text: `AIC Manager ${r.sessionId}: status=unknown (cannot read persisted events) [${parts.join(', ')}]` };
        }
        if (!reply) {
          return {
            kind: 'error',
            text: `AIC Manager ${r.sessionId}: failed — no model response [${parts.join(', ')}] ` +
              `(session=${res.sessionId}, flushError=${res.flushError ?? 'none'}); check manager.provider/model adapter registration`,
          };
        }
        if (!res.persisted) {
          return {
            kind: 'error',
            text: `AIC Manager ${r.sessionId}: replied but NOT persisted [${parts.join(', ')}] (flushError=${res.flushError ?? 'none'}) reply="${lastReply}"`,
          };
        }
        return {
          kind: 'success',
          text: `AIC Manager ${r.sessionId}: ${parts.join('→')} (session=${res.sessionId}, flushError=none) reply="${lastReply}"`,
        };
      } catch (e) {
        return { kind: 'error', text: `aic dispatch failed: ${e?.message ?? e}` };
      }
    },
  }));

  // Release the cached Manager handle on plugin teardown.
  disposers.push(() => { if (managerHandle) { try { managerHandle.dispose?.(); } catch { /* best-effort */ } managerHandle = null; } });

  return disposers;
}
