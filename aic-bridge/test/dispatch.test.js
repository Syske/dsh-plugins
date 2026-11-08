/**
 * S3.1-B dispatch tests — durable TaskRecord store + Manager dispatchTask/
 * resolveRecovery over a fake Storage Domain facility (no DSH packages needed).
 * Covers: schema validation (write-before), payload hash/id derivation,
 * write-before-zod via TaskStore.put, happy path, empty reply -> unknown,
 * payload conflict, idempotent replay, dispatching-in-flight -> unknown,
 * persisted=false -> failed, resolveRecovery evidence/no-evidence, literal
 * DomainSpec parse() (open-time validation), and the commands durable path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManagerSessionManager } from '../src/manager/manager-session.js';
import { TaskStore, validateTaskRecord, payloadHash, deriveWorkerSessionId, TASK_STATES } from '../src/aic/idempotency-store.js';
import { installCommands } from '../src/commands.js';

const NOW = 1700000000000;
function rec(o = {}) {
  return { taskId: 'T1', payloadHash: payloadHash('hello'), state: 'created', managerSessionId: 'mgr',
    attempt: 0, completionBasis: 'unknown', createdAt: NOW, updatedAt: NOW, ...o };
}
function store0(seed = []) {
  const map = new Map(seed.map((r) => [r.taskId, r]));
  return {
    map,
    async open() {}, async close() {},
    async get(id) { return map.get(id); },
    async put(r) { validateTaskRecord(r); map.set(r.taskId, r); return r; },
    async update(id, fn) { const n = fn(map.get(id)); validateTaskRecord(n); map.set(id, n); return n; },
  };
}
function emitText(t) { return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: t }] } } }; }

// A Manager with fake worker + fake persistence sharing an event log.
function mgr(store, opts = {}) {
  const m = new ManagerSessionManager({ storageDomain: {} }, { manager: { sessionId: 'mgr', provider: 'mock', model: 'm', cwd: '/tmp/ws' } });
  m.setTaskStore(store);
  const ev = { events: opts.events ? [...opts.events] : [] };
  m.persistence = {
    async flush() {}, async closeHandle() {},
    async openRead() { return { async read() { return { events: ev.events.slice() }; } }; },
    async readEvents(h) { return h.read(); },
  };
  const calls = { create: [], resume: [], send: [] };
  m.worker = {
    async createWorkerSession(req) { calls.create.push(req); if (opts.createThrow) throw opts.createThrow; return { agentId: req.sessionId, async dispose() {} }; },
    async resumeWorkerSession(req) { calls.resume.push(req); return { agentId: req.resumeSessionId, async dispose() {} }; },
    async sendMessage(handle, text) {
      calls.send.push([handle.agentId, text]);
      if (opts.mode === 'reply') ev.events.push({ type: 'user/message', data: {} }, emitText('OK'));
      else if (opts.mode === 'userOnly') ev.events.push({ type: 'user/message', data: {} });
      return opts.result || { executed: true, persisted: true, flushError: null };
    },
  };
  return { m, ev, calls };
}

// ── pure helpers ─────────────────────────────────────────────────────────────
test('validateTaskRecord accepts valid, rejects invalid (state/attempt/completionBasis)', () => {
  assert.doesNotThrow(() => validateTaskRecord(rec()));
  assert.throws(() => validateTaskRecord(rec({ state: 'BOGUS' })), /state invalid/);
  assert.throws(() => validateTaskRecord(rec({ attempt: -1 })), /attempt/);
  assert.throws(() => validateTaskRecord(rec({ completionBasis: 'done' })), /completionBasis/);
  assert.throws(() => validateTaskRecord(rec({ taskId: '' })), /taskId/);
  assert.equal(TASK_STATES.includes('completed'), true);
});
test('payloadHash deterministic & distinct; deriveWorkerSessionId stable', () => {
  assert.equal(payloadHash('a'), payloadHash('a'));
  assert.notEqual(payloadHash('a'), payloadHash('b'));
  assert.match(payloadHash('x'), /^ph_[0-9a-f]{8}$/);
  assert.equal(deriveWorkerSessionId('T1'), deriveWorkerSessionId('T1'));
  assert.notEqual(deriveWorkerSessionId('T1'), deriveWorkerSessionId('T2'));
  assert.match(deriveWorkerSessionId('T1'), /^wkr-aic-[0-9a-f]{16}$/);
});

// ── TaskStore over a fake facility: write-before validation + open-time parse ──
function fakeFacility() {
  const specSeen = {};
  const fakeDomain = { table: () => ({ get: () => undefined, async put() {}, async update() {} }) };
  return {
    specSeen,
    async open(spec) {
      specSeen.spec = spec;
      // Exercise the literal spec's duck-typed schema (open-time validation path)
      specSeen.validParse = !!spec.tables.task.valueSchema.parse;
      return fakeDomain;
    },
  };
}
test('TaskStore: literal DomainSpec has parse(); put validates BEFORE persisting', async () => {
  const fac = fakeFacility();
  const ts = new TaskStore({ storageDomain: fac }, {});
  await ts.open();
  assert.equal(fac.specSeen.validParse, true);
  // open-time parse of a good record succeeds; bad record throws
  assert.doesNotThrow(() => fac.specSeen.spec.tables.task.valueSchema.parse(rec()));
  assert.throws(() => fac.specSeen.spec.tables.task.valueSchema.parse(rec({ state: 'X' })), /state invalid/);
  // write-before validation: invalid put throws before any backend call
  await assert.rejects(() => ts.put(rec({ attempt: -5 })), /attempt/);
});
test('TaskStore without storageDomain -> clear AIC_STORAGE_UNAVAILABLE', async () => {
  const ts = new TaskStore({}, {});
  await assert.rejects(() => ts.open(), (e) => e.code === 'AIC_STORAGE_UNAVAILABLE');
});

// ── dispatchTask ─────────────────────────────────────────────────────────────
test('dispatchTask happy path -> worker_done (intent persisted before worker create)', async () => {
  const s = store0();
  const { m, calls } = mgr(s, { mode: 'reply' });
  const r = await m.dispatchTask({ taskId: 'T1', text: 'hello' });
  assert.equal(r.status, 'worker_done');
  assert.equal(r.accepted, true); assert.equal(r.workerReplied, true);
  assert.equal(r.completionBasis, 'unknown'); // never 'aic-evaluated'
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].sessionId, deriveWorkerSessionId('T1'));
  const stored = await s.get('T1');
  assert.equal(stored.state, 'worker_done');
  assert.equal(stored.workerSessionId, deriveWorkerSessionId('T1'));
  assert.equal(stored.managerSessionId, 'mgr');
  assert.equal(stored.runId, undefined); // no fabricated runId
});
test('dispatchTask executed+persisted but NO reply -> unknown (fail-closed)', async () => {
  const s = store0();
  const { m } = mgr(s, { mode: 'userOnly' });
  const r = await m.dispatchTask({ taskId: 'T2', text: 'hello' });
  assert.equal(r.status, 'unknown');
  assert.equal(r.workerReplied, false);
  assert.equal((await s.get('T2')).state, 'unknown');
});
test('dispatchTask persisted=false -> failed', async () => {
  const s = store0();
  const { m } = mgr(s, { mode: 'reply', result: { executed: true, persisted: false, flushError: 'disk' } });
  const r = await m.dispatchTask({ taskId: 'T3', text: 'hello' });
  assert.equal(r.status, 'failed');
  assert.equal((await s.get('T3')).state, 'failed');
});
test('dispatchTask payload conflict -> conflict, no dispatch', async () => {
  const s = store0([rec({ taskId: 'T4', payloadHash: payloadHash('other'), state: 'created' })]);
  const { m, calls } = mgr(s, { mode: 'reply' });
  const r = await m.dispatchTask({ taskId: 'T4', text: 'hello' });
  assert.equal(r.status, 'conflict');
  assert.equal(calls.send.length, 0);
});
test('dispatchTask idempotent replay when already worker_done -> no dispatch', async () => {
  const s = store0([rec({ taskId: 'T5', state: 'worker_done', workerSessionId: 'wkr-x' })]);
  const { m, calls } = mgr(s, { mode: 'reply' });
  const r = await m.dispatchTask({ taskId: 'T5', text: 'hello' });
  assert.equal(r.status, 'idempotent');
  assert.equal(r.idempotentReplay, true);
  assert.equal(calls.send.length, 0);
});
test('dispatchTask dispatching-in-flight -> unknown, no re-dispatch', async () => {
  const s = store0([rec({ taskId: 'T6', state: 'dispatching', workerSessionId: 'wkr-y' })]);
  const { m, calls } = mgr(s, { mode: 'reply' });
  const r = await m.dispatchTask({ taskId: 'T6', text: 'hello' });
  assert.equal(r.status, 'unknown');
  assert.equal(calls.send.length, 0);
});
test('dispatchTask worker create throw -> failed (intent was persisted first)', async () => {
  const s = store0();
  const { m } = mgr(s, { createThrow: new Error('boom') });
  const r = await m.dispatchTask({ taskId: 'T7', text: 'hello' });
  assert.equal(r.status, 'failed');
  const stored = await s.get('T7');
  assert.equal(stored.state, 'failed');
  assert.ok(stored.lastError && stored.lastError.message.includes('boom'));
});

// ── resolveRecovery ──────────────────────────────────────────────────────────
test('resolveRecovery dispatching + user&reply evidence -> worker_done', async () => {
  const s = store0([rec({ taskId: 'T8', state: 'dispatching', workerSessionId: 'wkr-z' })]);
  const { m } = mgr(s, { events: [{ type: 'user/message', data: {} }, emitText('OK')] });
  const r = await m.resolveRecovery('T8');
  assert.equal(r.resolved, 'worker_done');
  assert.equal((await s.get('T8')).state, 'worker_done');
});
test('resolveRecovery dispatching + no evidence -> unknown (no resend)', async () => {
  const s = store0([rec({ taskId: 'T9', state: 'dispatching', workerSessionId: 'wkr-z' })]);
  const { m } = mgr(s, { events: [] });
  const r = await m.resolveRecovery('T9');
  assert.equal(r.resolved, 'unknown');
  assert.equal((await s.get('T9')).state, 'dispatching');
});
test('resolveRecovery non-dispatching -> passthrough; not-found', async () => {
  const s = store0([rec({ taskId: 'TA', state: 'worker_done' })]);
  const { m } = mgr(s, {});
  assert.equal((await m.resolveRecovery('TA')).resolved, 'worker_done');
  assert.equal((await m.resolveRecovery('nope')).resolved, 'not-found');
});

// ── commands durable path (opt-in only when a TaskStore is injected) ─────────
function cmds() { const d = new Map(); return { d, register(x) { d.set(x.name, x); return () => d.delete(x.name); } }; }
test('/aic durable path: success on worker_done; legacy when no store', async () => {
  const reg = cmds();
  const s = store0();
  const { m } = mgr(s, { mode: 'reply' });
  const ctx = { commands: reg, get: () => undefined };
  installCommands(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'm' } }, { manager: m, worker: m.worker });
  const r = await reg.d.get('aic').handler({ agent: { id: 'UI' }, rawInput: 'hello' });
  assert.equal(r.kind, 'success');
  assert.match(r.text, /durable/);
  assert.match(r.text, /state=worker_done/);
});
