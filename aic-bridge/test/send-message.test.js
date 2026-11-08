import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerLifecycleAdapter } from '../src/adapters/worker-lifecycle.js';
import { SessionPersistenceAdapter } from '../src/adapters/session-persistence.js';

// Build a mock ctx + WorkerHandle with call-order tracking.
function makeEnv({ flushImpl } = {}) {
  const order = [];
  const calls = { followup: [], whenIdle: 0, flush: 0, createUserMessage: [] };
  const handle = {
    agentId: 'sess-1',
    followup(m) { order.push('followup'); calls.followup.push(m); },
    whenIdle() { order.push('whenIdle'); calls.whenIdle += 1; return Promise.resolve(); },
  };
  const sessionPersistence = {
    async flush() {
      order.push('flush'); calls.flush += 1;
      if (flushImpl) return flushImpl();
    },
  };
  const ctx = { sessionPersistence, get: (n) => (n === 'sessionPersistence' ? sessionPersistence : undefined) };
  const createUserMessage = (input) => {
    calls.createUserMessage.push(input);
    return { id: 'msg-1', role: 'user', content: input.content, source: input.source };
  };
  return { ctx, handle, order, calls, createUserMessage };
}

test('SessionPersistenceAdapter.flush delegates to service; throws if absent', async () => {
  const { ctx, calls } = makeEnv();
  const p = new SessionPersistenceAdapter(ctx);
  await p.flush();
  assert.equal(calls.flush, 1);
  await assert.rejects(() => new SessionPersistenceAdapter({}).flush(), /sessionPersistence.flush unavailable/);
});

test('sendMessage: executes via followup, waits whenIdle, flushes, returns structured success', async () => {
  const { ctx, handle, calls, createUserMessage } = makeEnv();
  const w = new WorkerLifecycleAdapter(ctx, { createUserMessage });
  const res = await w.sendMessage(handle, 'ping (no tools)');
  assert.deepEqual(res, { sessionId: 'sess-1', executed: true, persisted: true, flushError: null });
  // message built through createUserMessage with text block + user source
  assert.equal(calls.createUserMessage.length, 1);
  assert.deepEqual(calls.createUserMessage[0].content, [{ type: 'text', text: 'ping (no tools)' }]);
  assert.deepEqual(calls.createUserMessage[0].source, { kind: 'user' });
  // followup got the message object
  assert.equal(calls.followup.length, 1);
  assert.equal(calls.followup[0].role, 'user');
  assert.equal(calls.whenIdle, 1);
  assert.equal(calls.flush, 1);
});

test('sendMessage: flush happens AFTER whenIdle (durability barrier ordering)', async () => {
  const { ctx, handle, order, createUserMessage } = makeEnv();
  const w = new WorkerLifecycleAdapter(ctx, { createUserMessage });
  await w.sendMessage(handle, 'hi');
  assert.deepEqual(order, ['followup', 'whenIdle', 'flush']);
});

test('sendMessage: flush failure -> executed true, persisted false, flushError set (no throw)', async () => {
  const { ctx, handle, createUserMessage } = makeEnv({ flushImpl: () => { throw Object.assign(new Error('disk full'), { code: 'EFLUSH' }); } });
  const w = new WorkerLifecycleAdapter(ctx, { createUserMessage });
  const res = await w.sendMessage(handle, 'hi');
  assert.equal(res.executed, true);
  assert.equal(res.persisted, false);
  assert.equal(res.flushError, 'EFLUSH');
});

test('sendMessage: flush:false skips the persistence barrier', async () => {
  const { ctx, handle, calls, createUserMessage } = makeEnv();
  const w = new WorkerLifecycleAdapter(ctx, { createUserMessage });
  const res = await w.sendMessage(handle, 'hi', { flush: false });
  assert.deepEqual(res, { sessionId: 'sess-1', executed: true, persisted: false, flushError: null });
  assert.equal(calls.flush, 0);
  assert.equal(calls.whenIdle, 1);
});

test('sendMessage input validation', async () => {
  const { ctx, handle, createUserMessage } = makeEnv();
  const w = new WorkerLifecycleAdapter(ctx, { createUserMessage });
  await assert.rejects(() => w.sendMessage(handle, ''), /non-empty string/);
  await assert.rejects(() => w.sendMessage(handle, '   '), /non-empty string/);
  await assert.rejects(() => w.sendMessage(handle, 123), /non-empty string/);
  await assert.rejects(() => w.sendMessage(null, 'x'), /requires a WorkerHandle/);
  await assert.rejects(() => w.sendMessage({}, 'x'), /requires a WorkerHandle/);
});

test('sendMessage: missing createUserMessage factory -> clear error', async () => {
  const { ctx, handle } = makeEnv();
  const w = new WorkerLifecycleAdapter(ctx); // no factory injected; @deepseek-ai/dsh-llm not resolvable here
  await assert.rejects(() => w.sendMessage(handle, 'hi'), /createUserMessage unavailable/);
});
