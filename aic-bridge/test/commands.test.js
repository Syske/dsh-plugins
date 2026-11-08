/**
 * S3.0 command-entry + Manager model-route tests (no DSH packages needed).
 * Covers: config route validation (none/partial/explicit), fail-closed blocking,
 * explicit route passed to create AND resume (identity stable), honest status
 * (normal reply -> success; empty response -> failed; flush failure -> not persisted),
 * canonical single Manager reuse, and clean disposal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCommands } from '../src/commands.js';
import { validateManagerRoute } from '../src/config.js';
import { ManagerSessionManager } from '../src/manager/manager-session.js';
import { makeMockCtx } from './mock-ctx.js';

function makeCommands() {
  const defs = new Map();
  return {
    defs,
    register(def) { defs.set(def.name, def); return () => defs.delete(def.name); },
  };
}
function withCommands(ctx, registry) { ctx.commands = registry; return ctx; }

/** Build deps with a shared mutable event store; fake worker appends `emit` events on send. */
function makeDeps({ emit = [], result = { executed: true, persisted: true, flushError: null } } = {}) {
  const store = [];
  const calls = { sent: [] };
  const worker = {
    async sendMessage(handle, text) {
      calls.sent.push([handle.agentId, text]);
      for (const e of emit) store.push(e);
      return { sessionId: handle.agentId, ...result };
    },
  };
  const readSession = async () => store;
  return { deps: { worker, readSession }, store, calls };
}
const userMsg = { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'task' }] } } };
const replyMsg = (t = 'MOCK_MGR_OK') => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: t }] } } });

// ── config route validation ──────────────────────────────────────────────────
test('validateManagerRoute: explicit / none / partial', () => {
  assert.deepEqual(validateManagerRoute({ provider: 'mock', model: 'mock-model' }),
    { ok: true, source: 'explicit', provider: 'mock', model: 'mock-model' });
  assert.equal(validateManagerRoute({}).ok, false);
  assert.equal(validateManagerRoute({}).source, 'none');
  const partial = validateManagerRoute({ provider: 'mock' });
  assert.equal(partial.ok, false);
  assert.equal(partial.source, 'partial');
  // values are trimmed; whitespace-only provider is treated as absent -> partial
  assert.deepEqual(validateManagerRoute({ provider: ' mock ', model: ' m ' }),
    { ok: true, source: 'explicit', provider: 'mock', model: 'm' });
  assert.equal(validateManagerRoute({ provider: '  ', model: ' m ' }).source, 'partial');
});

// ── registration / no-runtime ───────────────────────────────────────────────
test('registers aic-status + aic; disposers unregister', () => {
  const { ctx } = makeMockCtx(); const reg = makeCommands(); withCommands(ctx, reg);
  const disposers = installCommands(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'm' } });
  assert.ok(reg.defs.has('aic-status')); assert.ok(reg.defs.has('aic'));
  for (const d of disposers) d();
  assert.equal(reg.defs.has('aic'), false); assert.equal(reg.defs.has('aic-status'), false);
});

test('no ctx.commands -> no-op', () => {
  const { ctx } = makeMockCtx();
  assert.deepEqual(installCommands(ctx, { manager: { sessionId: 'mgr' } }), []);
});

// ── fail-closed on missing / partial config ─────────────────────────────────
test('missing route: /aic and /aic-status block, NO Manager created', async () => {
  const { ctx, calls } = makeMockCtx(); const reg = makeCommands(); withCommands(ctx, reg);
  installCommands(ctx, { manager: { sessionId: 'mgr' } }); // no provider/model
  const s = await reg.defs.get('aic-status').handler({ agent: { id: 'UI' }, rawInput: '' });
  assert.equal(s.kind, 'error'); assert.match(s.text, /not started|provider/i);
  const a = await reg.defs.get('aic').handler({ agent: { id: 'UI' }, rawInput: 'do it' });
  assert.equal(a.kind, 'error'); assert.match(a.text, /blocked/);
  assert.equal(calls.create.length, 0, 'no Manager created without a route');
});

test('partial route: blocked', async () => {
  const { ctx } = makeMockCtx(); const reg = makeCommands(); withCommands(ctx, reg);
  installCommands(ctx, { manager: { sessionId: 'mgr', provider: 'mock' } }); // missing model
  const a = await reg.defs.get('aic').handler({ agent: { id: 'UI' }, rawInput: 'x' });
  assert.equal(a.kind, 'error'); assert.match(a.text, /model/);
});

// ── explicit route passed to create AND resume (identity stable) ────────────
test('explicit route flows to create: agentOptions {provider,model}', async () => {
  const { ctx, calls } = makeMockCtx();
  const mgr = new ManagerSessionManager(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'mock-model' } });
  const r = await mgr.ensure({});
  assert.equal(r.mode, 'create');
  assert.deepEqual(calls.create[0].agentOptions, { provider: 'mock', model: 'mock-model' });
});

test('explicit route flows to RESUME unchanged (no silent model drift)', async () => {
  const { ctx, calls } = makeMockCtx();
  const mgr = new ManagerSessionManager(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'mock-model' } });
  const r = await mgr.ensure({ resume: true });
  assert.equal(r.mode, 'resume');
  assert.deepEqual(calls.resume[0].agentOptions, { provider: 'mock', model: 'mock-model' });
});

test('partial route makes ManagerSessionManager.ensure throw (fail-closed)', async () => {
  const { ctx } = makeMockCtx();
  const mgr = new ManagerSessionManager(ctx, { manager: { sessionId: 'mgr', model: 'm' } });
  await assert.rejects(() => mgr.ensure({}), /provider/);
});

// ── honest status ───────────────────────────────────────────────────────────
test('normal response -> success with replied + reply text', async () => {
  const { ctx } = makeMockCtx(); const reg = makeCommands(); withCommands(ctx, reg);
  const { deps } = makeDeps({ emit: [userMsg, replyMsg('MOCK_MGR_OK')] });
  installCommands(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'mock-model' } }, deps);
  const r = await reg.defs.get('aic').handler({ agent: { id: 'UI' }, rawInput: '  do x  ' });
  assert.equal(r.kind, 'success');
  assert.match(r.text, /replied/);
  assert.match(r.text, /MOCK_MGR_OK/);
});

test('empty model response -> failed (NOT fabricated success)', async () => {
  const { ctx } = makeMockCtx(); const reg = makeCommands(); withCommands(ctx, reg);
  const { deps } = makeDeps({ emit: [userMsg, { type: 'turn/end' }] }); // turn completed, no assistant/message
  installCommands(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'mock-model' } }, deps);
  const r = await reg.defs.get('aic').handler({ agent: { id: 'UI' }, rawInput: 'do x' });
  assert.equal(r.kind, 'error');
  assert.match(r.text, /no model response/);
});

test('flush failure -> replied-but-NOT-persisted error', async () => {
  const { ctx } = makeMockCtx(); const reg = makeCommands(); withCommands(ctx, reg);
  const { deps } = makeDeps({ emit: [userMsg, replyMsg()], result: { executed: true, persisted: false, flushError: 'disk' } });
  installCommands(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'mock-model' } }, deps);
  const r = await reg.defs.get('aic').handler({ agent: { id: 'UI' }, rawInput: 'x' });
  assert.equal(r.kind, 'error');
  assert.match(r.text, /NOT persisted/);
  assert.match(r.text, /flushError=disk/);
});

test('empty input -> usage error, no dispatch', async () => {
  const { ctx } = makeMockCtx(); const reg = makeCommands(); withCommands(ctx, reg);
  const { deps, calls } = makeDeps({ emit: [replyMsg()] });
  installCommands(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'mock-model' } }, deps);
  const r = await reg.defs.get('aic').handler({ agent: { id: 'UI' }, rawInput: '   ' });
  assert.equal(r.kind, 'error'); assert.match(r.text, /usage/);
  assert.equal(calls.sent.length, 0);
});

test('repeated commands reuse ONE Manager (no duplicate create)', async () => {
  const { ctx, calls } = makeMockCtx(); const reg = makeCommands(); withCommands(ctx, reg);
  const { deps } = makeDeps({ emit: [replyMsg()] });
  installCommands(ctx, { manager: { sessionId: 'mgr', provider: 'mock', model: 'mock-model' } }, deps);
  await reg.defs.get('aic').handler({ agent: { id: 'UI' }, rawInput: 'one' });
  await reg.defs.get('aic').handler({ agent: { id: 'UI' }, rawInput: 'two' });
  await reg.defs.get('aic-status').handler({ agent: { id: 'UI' }, rawInput: '' });
  assert.equal(calls.create.length, 1);
  assert.ok(!calls.create.some((c) => c.sessionId === 'UI'));
});
