import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, DEFAULT_CONFIG } from '../src/config.js';

test('defaults are preserved when input is empty', () => {
  const cfg = resolveConfig({}, {});
  assert.equal(cfg.approval.secrets, 'deny');
  assert.equal(cfg.approval.gitPush, 'ask');
  assert.equal(cfg.approval.read, 'auto');
  assert.equal(cfg.logLevel, 'info');
});

test('AIC adapter is always forced read-only', () => {
  const cfg = resolveConfig({ aic: { readOnly: false, baseUrl: 'http://x' } }, {});
  assert.equal(cfg.aic.readOnly, true);
  assert.equal(cfg.aic.baseUrl, 'http://x');
});

test('partial approval override merges over defaults', () => {
  const cfg = resolveConfig({ approval: { read: 'ask' } }, {});
  assert.equal(cfg.approval.read, 'ask');
  assert.equal(cfg.approval.secrets, 'deny'); // untouched default
});

test('env fills empty manager/aic values', () => {
  const cfg = resolveConfig({}, {
    AIC_BRIDGE_MANAGER_SESSION_ID: 'mgr-1',
    AIC_BRIDGE_MANAGER_CWD: '/tmp/ws',
    AIC_BRIDGE_AIC_BASE_URL: 'http://aic',
  });
  assert.equal(cfg.manager.sessionId, 'mgr-1');
  assert.equal(cfg.manager.cwd, '/tmp/ws');
  assert.equal(cfg.aic.baseUrl, 'http://aic');
});

test('DEFAULT_CONFIG is frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
});
