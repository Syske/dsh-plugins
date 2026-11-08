import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMockCtx } from './mock-ctx.js';
import { WorkerLifecycleAdapter } from '../src/adapters/worker-lifecycle.js';
import { SessionPersistenceAdapter } from '../src/adapters/session-persistence.js';
import { ApprovalAdapter } from '../src/adapters/approval.js';
import { ManagerSessionManager } from '../src/manager/manager-session.js';
import { isAllowed } from '../src/adapters/approval-policy.js';

// ── Service resolution / "injection" ─────────────────────────────────────────
test('adapters resolve injected services from ctx', () => {
  const { ctx } = makeMockCtx();
  assert.equal(new WorkerLifecycleAdapter(ctx).agents, ctx.agents);
  assert.equal(new SessionPersistenceAdapter(ctx).service, ctx.sessionPersistence);
  assert.equal(new ApprovalAdapter(ctx).service, ctx.approval);
});

// ── Manager create/resume/dispose ────────────────────────────────────────────
test('manager.ensure creates a top-level Manager session with stable identity', async () => {
  const { ctx, calls } = makeMockCtx();
  const mgr = new ManagerSessionManager(ctx, { manager: { cwd: '/tmp/ws' } });
  const r = await mgr.ensure({ sessionId: 'mgr-1' });
  assert.equal(r.mode, 'create');
  assert.equal(r.sessionId, 'mgr-1');
  assert.equal(r.handle.agentId, 'mgr-1');
  assert.deepEqual(calls.create[0], { sessionId: 'mgr-1', meta: { cwd: '/tmp/ws' } });
  assert.ok(!('parentAgent' in calls.create[0]), 'manager must be top-level (no parentAgent)');
});

test('manager.ensure resumes by resumeSessionId', async () => {
  const { ctx, calls } = makeMockCtx();
  const mgr = new ManagerSessionManager(ctx, {});
  const r = await mgr.ensure({ sessionId: 'mgr-2', resume: true });
  assert.equal(r.mode, 'resume');
  assert.deepEqual(calls.resume[0], { resumeSessionId: 'mgr-2' });
});

test('manager.ensure requires a stable sessionId', async () => {
  const { ctx } = makeMockCtx();
  const mgr = new ManagerSessionManager(ctx, {});
  await assert.rejects(() => mgr.ensure({}), /sessionId required/);
});

test('manager.dispose releases the handle', async () => {
  const { ctx, calls } = makeMockCtx();
  const mgr = new ManagerSessionManager(ctx, {});
  const r = await mgr.ensure({ sessionId: 'mgr-3' });
  await mgr.dispose(r.handle);
  assert.deepEqual(calls.dispose, ['mgr-3']);
});

// ── Worker top-level lifecycle ───────────────────────────────────────────────
test('worker create is top-level (no parentAgent) and exposes agentId === sessionId', async () => {
  const { ctx, calls } = makeMockCtx();
  const w = new WorkerLifecycleAdapter(ctx);
  const h = await w.createWorkerSession({ sessionId: 'w-1' });
  assert.equal(h.agentId, 'w-1');
  assert.deepEqual(calls.create[0], { sessionId: 'w-1' });
  assert.ok(!('parentAgent' in calls.create[0]));
});

test('worker resume passes resumeSessionId', async () => {
  const { ctx, calls } = makeMockCtx();
  const w = new WorkerLifecycleAdapter(ctx);
  const h = await w.resumeWorkerSession({ resumeSessionId: 'w-2' });
  assert.equal(h.agentId, 'w-2');
  assert.deepEqual(calls.resume[0], { resumeSessionId: 'w-2' });
});

test('worker handle: whenIdle / cancel / dispose delegate correctly', async () => {
  const { ctx, calls } = makeMockCtx();
  const w = new WorkerLifecycleAdapter(ctx);
  const h = await w.createWorkerSession({ sessionId: 'w-3' });
  await h.whenIdle();
  h.cancel({ kind: 'user' }, { keepInbox: true });
  await h.dispose();
  assert.equal(calls.whenIdle, 1);
  assert.deepEqual(calls.cancel[0], [{ kind: 'user' }, { keepInbox: true }]);
  assert.deepEqual(calls.dispose, ['w-3']);
});

test('worker create/resume throw when agents service unavailable', async () => {
  const w = new WorkerLifecycleAdapter({});
  await assert.rejects(() => w.createWorkerSession({ sessionId: 'x' }), /agents.create unavailable/);
  await assert.rejects(() => w.resumeWorkerSession({ resumeSessionId: 'x' }), /agents.resume unavailable/);
});

// ── Persistence (read-only) ──────────────────────────────────────────────────
test('persistence openRead opens with access="read" and never creates', async () => {
  const { ctx, calls } = makeMockCtx();
  const p = new SessionPersistenceAdapter(ctx);
  const h = await p.openRead('s-1');
  assert.equal(h.access, 'read');
  assert.deepEqual(calls.open[0], ['s-1', 'read', undefined]);
  assert.equal(calls.persistenceCreate, 0, 'read-only adapter must not call create');
});

test('persistence readEvents + closeHandle delegate', async () => {
  const { ctx, calls } = makeMockCtx();
  const p = new SessionPersistenceAdapter(ctx);
  const h = await p.openRead('s-2');
  const r = await p.readEvents(h, 0, 10);
  assert.equal(r.eventState, 'detached');
  assert.deepEqual(calls.read[0], [0, 10, undefined]);
  await p.closeHandle(h);
  assert.deepEqual(calls.close, ['s-2']);
});

test('persistence openRead throws when service unavailable', async () => {
  const p = new SessionPersistenceAdapter({});
  await assert.rejects(() => p.openRead('s'), /sessionPersistence.open unavailable/);
});

// ── Approval (fail-closed) ───────────────────────────────────────────────────
test('approval allowed-once grants', async () => {
  const { ctx } = makeMockCtx({ approvalOutcome: 'allowed-once' });
  const a = new ApprovalAdapter(ctx);
  const o = await a.request({ toolName: 'x' });
  assert.equal(o, 'allowed-once');
  assert.equal(isAllowed(o), true);
});

test('approval rejected/cancelled do not grant', async () => {
  for (const v of ['rejected', 'cancelled']) {
    const { ctx } = makeMockCtx({ approvalOutcome: v });
    const o = await new ApprovalAdapter(ctx).request({ toolName: 'x' });
    assert.equal(o, v);
    assert.equal(isAllowed(o), false);
  }
});

test('approval rogue value normalizes to unavailable (fail-closed)', async () => {
  const { ctx } = makeMockCtx({ approvalOutcome: 'yolo' });
  const o = await new ApprovalAdapter(ctx).request({ toolName: 'x' });
  assert.equal(o, 'unavailable');
  assert.equal(isAllowed(o), false);
});

test('approval throw (e.g. no open turn) -> unavailable', async () => {
  const { ctx } = makeMockCtx({ approvalThrow: true });
  const o = await new ApprovalAdapter(ctx).request({ toolName: 'x' });
  assert.equal(o, 'unavailable');
});

test('approval missing service -> unavailable', async () => {
  const { ctx } = makeMockCtx({ approvalMissing: true });
  const o = await new ApprovalAdapter(ctx).request({ toolName: 'x' });
  assert.equal(o, 'unavailable');
});
