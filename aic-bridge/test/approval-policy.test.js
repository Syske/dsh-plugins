import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOMES,
  normalizeOutcome,
  isAllowed,
  evaluateRisk,
} from '../src/adapters/approval-policy.js';

test('OUTCOMES has the verified four-value vocabulary', () => {
  assert.deepEqual([...OUTCOMES].sort(), ['allowed-once', 'cancelled', 'rejected', 'unavailable']);
});

test('normalizeOutcome passes valid values and fails closed on rogue values', () => {
  for (const v of OUTCOMES) assert.equal(normalizeOutcome(v), v);
  assert.equal(normalizeOutcome('allow'), 'unavailable');
  assert.equal(normalizeOutcome(undefined), 'unavailable');
  assert.equal(normalizeOutcome(null), 'unavailable');
  assert.equal(normalizeOutcome('ALLOWED-ONCE'), 'unavailable');
});

test('only allowed-once grants', () => {
  assert.equal(isAllowed('allowed-once'), true);
  assert.equal(isAllowed('rejected'), false);
  assert.equal(isAllowed('cancelled'), false);
  assert.equal(isAllowed('unavailable'), false);
  assert.equal(isAllowed('nonsense'), false);
});

test('evaluateRisk: deny/ask/auto mapping; unknown decision falls back to ask', () => {
  assert.equal(evaluateRisk('secrets', { secrets: 'deny' }), 'deny');
  assert.equal(evaluateRisk('gitPush', { gitPush: 'ask' }), 'ask');
  assert.equal(evaluateRisk('read', { read: 'auto' }), 'allow');
  assert.equal(evaluateRisk('unknownLevel', {}), 'ask');
});
