/**
 * aic-bridge plugin entry (DSH 0.2.1-rc.5 / Cordis conventions).
 *
 * S0 (skeleton) + S1 (adapters). This row mounts the AIC x DSH A1 plugin; removing
 * the row/bundle makes the plugin disappear while DSH keeps running untouched.
 *
 * A1 boundaries:
 *  - Worker = independent TOP-LEVEL Agent Session (ADR-006), separate from Manager.
 *  - AIC adapter is READ-ONLY (no write-through).
 *  - Approval is fail-closed (only 'allowed-once' grants).
 *  - Does NOT fork or modify DSH core; registers no file/Git write tools.
 *
 * Out of scope here (kept as explicit placeholders, NOT done):
 *  - S2 worker task-dispatch loop (see manager/manager-session.js + aic/read-adapter.js)
 *  - S3 durable idempotency/linkage implementation (see aic/idempotency-store.js)
 *  - S4 Browser UI / loopback routes
 */
import z from '@deepseek-ai/schemastery';
import { resolveConfig, DEFAULT_CONFIG } from './src/config.js';
import { ApprovalAdapter } from './src/adapters/approval.js';
import { SessionPersistenceAdapter } from './src/adapters/session-persistence.js';
import { WorkerLifecycleAdapter } from './src/adapters/worker-lifecycle.js';
import { ManagerSessionManager } from './src/manager/manager-session.js';
import { AicReadAdapter } from './src/aic/read-adapter.js';
import { TaskStore } from './src/aic/idempotency-store.js';
import { installCommands } from './src/commands.js';

/** Cordis plugin name (row id in cordis.patch.yml is `aic-bridge`). */
export const name = 'aic-bridge';

/** Core DSH services the plugin needs before it can start. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'commands', 'storageDomain'];

/**
 * Plugin configuration schema (schemastery). Defaults mirror src/config.js.
 * NOTE: import-time schema validity is not runtime-verified (R pending); the
 * authoritative defaults live in resolveConfig().
 */
export const Config = z.object({
  manager: z.object({ sessionId: z.string().default(''), cwd: z.string().default('') }).default({}),
  approval: z.any(),
  storage: z.object({ dataDir: z.string().default('') }).default({}),
  aic: z.object({ baseUrl: z.string().default(''), readOnly: z.const(true).default(true) }).default({}),
  logLevel: z.string().default('info'),
});

/**
 * Mount the plugin. Compiled adapters are captured and returned for later S2+ use;
 * S1 registers no dispatch loop and no write tools.
 * @param {any} ctx Cordis context.
 * @param {object} config raw config from the patch row.
 * @returns {{cfg:object, approval:ApprovalAdapter, persistence:SessionPersistenceAdapter, worker:WorkerLifecycleAdapter, manager:ManagerSessionManager, aic:AicReadAdapter, idempotency:IdempotencyStore}}
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config, process.env);

  const approval = new ApprovalAdapter(ctx, cfg.approval);
  const persistence = new SessionPersistenceAdapter(ctx);
  const worker = new WorkerLifecycleAdapter(ctx);
  const manager = new ManagerSessionManager(ctx, cfg);
  const aic = new AicReadAdapter(cfg);
  // S3.1-B durable TaskRecord store over ctx.storageDomain; share lifecycle with the plugin.
  const idempotency = new TaskStore(ctx, cfg);
  manager.setTaskStore(idempotency);

  // S3.0: minimal Manager command entry (/aic-status, /aic). Registers slash
  // commands only when ctx.commands is mounted (dsh-base includes it).
  const commandDisposers = installCommands(ctx, cfg, { manager, worker });

  // Dispose command registrations + cached Manager handle + task store on teardown.
  ctx.effect(() => async () => {
    for (const dispose of commandDisposers) {
      try { dispose(); } catch { /* best-effort */ }
    }
    try { await idempotency.close(); } catch { /* best-effort */ }
  });

  return { cfg, approval, persistence, worker, manager, aic, idempotency };
}

export { DEFAULT_CONFIG, resolveConfig };
