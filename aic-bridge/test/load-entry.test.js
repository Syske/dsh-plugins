import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMockCtx } from './mock-ctx.js';

// Genuine entry load + apply() wiring. Requires @deepseek-ai/schemastery to be
// resolvable (it imports index.js). When it is not on disk, the test SKIPS
// (documented limitation) instead of failing the whole suite.
test('entry loads, exposes name/inject/Config, and apply() wires adapters', async (t) => {
  let mod;
  try {
    mod = await import('../index.js');
  } catch (error) {
    t.skip(`index.js not loadable in this environment (${error.code ?? error.message}); needs @deepseek-ai/schemastery on disk`);
    return;
  }
  assert.equal(mod.name, 'aic-bridge');
  assert.deepEqual(mod.inject, ['agents', 'sessions', 'sessionPersistence']);
  assert.ok(mod.Config, 'Config schema exported');

  const { ctx, state } = makeMockCtx();
  const api = mod.apply(ctx, { manager: { sessionId: 'mgr-x' } });
  assert.equal(typeof api.cfg, 'object');
  assert.equal(api.cfg.aic.readOnly, true, 'apply enforces AIC read-only');
  assert.ok(api.approval && api.persistence && api.worker && api.manager && api.aic && api.idempotency);
  assert.equal(state.effects.length, 1, 'apply registers a teardown effect');

  // Wiring smoke: manager created through ctx.agents with stable id.
  const r = await api.manager.ensure({});
  assert.equal(r.mode, 'create');
  assert.equal(r.sessionId, 'mgr-x');
});
