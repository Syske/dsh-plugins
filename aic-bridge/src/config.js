/**
 * aic-bridge configuration (S0/S1).
 *
 * Pure JavaScript module with NO external imports so that `resolveConfig`,
 * `validateManagerRoute` and the defaults are unit-testable without the DSH
 * dependency graph present. The schemastery `ConfigSchema` lives in `index.js`
 * (plugin entry) and wraps these defaults for DSH/Cordis.
 *
 * Security-first defaults: the AIC adapter is ALWAYS read-only; approval
 * policy fails safe (unknown -> ask, secrets -> deny, external writes -> ask).
 *
 * Manager model route (S3.0): an explicit, verifiable `manager.provider` +
 * `manager.model` pair. It is FAIL-CLOSED — absent or partial configuration is
 * rejected by `validateManagerRoute` and blocked before a Manager is created or
 * a task is sent. No API keys are read here; the provider/model pair is a route
 * NAME only.
 */

/** Frozen default configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  manager: Object.freeze({ sessionId: '', cwd: '', provider: '', model: '' }),
  approval: Object.freeze({
    read: 'auto',
    test: 'auto',
    build: 'auto',
    workspaceWrite: 'auto',
    localCommit: 'auto',
    externalWrite: 'ask',
    gitPush: 'ask',
    npmPublish: 'ask',
    githubRelease: 'ask',
    secrets: 'deny',
    dangerFullAccess: 'ask',
  }),
  storage: Object.freeze({ dataDir: '' }),
  aic: Object.freeze({ baseUrl: '', readOnly: true }),
  logLevel: 'info',
});

/**
 * Validate the Manager model route. FAIL-CLOSED:
 *  - both provider & model non-empty  -> { ok:true, source:'explicit', provider, model }
 *  - both empty                       -> { ok:false, source:'none' }   (unconfigured)
 *  - exactly one empty                -> { ok:false, source:'partial' } (invalid config)
 *
 * @param {object} [manager] the resolved manager config group.
 * @returns {{ok:boolean, source:'explicit'|'none'|'partial', provider:string, model:string, reason?:string}}
 */
export function validateManagerRoute(manager = {}) {
  const provider = typeof manager.provider === 'string' ? manager.provider.trim() : '';
  const model = typeof manager.model === 'string' ? manager.model.trim() : '';
  if (provider && model) {
    return { ok: true, source: 'explicit', provider, model };
  }
  if (!provider && !model) {
    return { ok: false, source: 'none', provider: '', model: '', reason: 'manager model route not configured (set manager.provider and manager.model)' };
  }
  return {
    ok: false,
    source: 'partial',
    provider,
    model,
    reason: `incomplete manager model route: provider=${provider || '∅'}, model=${model || '∅'} (both required)`,
  };
}

/**
 * Merge user input over defaults for the known groups.
 * Environment fallbacks (`AIC_BRIDGE_*`) only fill empty values.
 * Enforces the A1 invariant `aic.readOnly === true`.
 *
 * @param {object} [input] partial config (as passed by Cordis / patch row).
 * @param {Record<string,string|undefined>} [env] process environment.
 * @returns {object} resolved config (fresh, mutable copy).
 */
export function resolveConfig(input = {}, env = {}) {
  const src = input ?? {};
  const cfg = {
    manager: { ...DEFAULT_CONFIG.manager, ...(src.manager ?? {}) },
    approval: { ...DEFAULT_CONFIG.approval, ...(src.approval ?? {}) },
    storage: { ...DEFAULT_CONFIG.storage, ...(src.storage ?? {}) },
    aic: { ...DEFAULT_CONFIG.aic, ...(src.aic ?? {}) },
    logLevel: src.logLevel ?? DEFAULT_CONFIG.logLevel,
  };

  if (!cfg.manager.cwd && env.AIC_BRIDGE_MANAGER_CWD) {
    cfg.manager.cwd = env.AIC_BRIDGE_MANAGER_CWD;
  }
  if (!cfg.manager.sessionId && env.AIC_BRIDGE_MANAGER_SESSION_ID) {
    cfg.manager.sessionId = env.AIC_BRIDGE_MANAGER_SESSION_ID;
  }
  if (!cfg.manager.provider && env.AIC_BRIDGE_MANAGER_PROVIDER) {
    cfg.manager.provider = env.AIC_BRIDGE_MANAGER_PROVIDER;
  }
  if (!cfg.manager.model && env.AIC_BRIDGE_MANAGER_MODEL) {
    cfg.manager.model = env.AIC_BRIDGE_MANAGER_MODEL;
  }
  if (!cfg.aic.baseUrl && env.AIC_BRIDGE_AIC_BASE_URL) {
    cfg.aic.baseUrl = env.AIC_BRIDGE_AIC_BASE_URL;
  }

  // A1 invariant: the AIC adapter is read-only and must not be disabled.
  cfg.aic.readOnly = true;

  return cfg;
}
