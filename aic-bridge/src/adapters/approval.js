/**
 * ApprovalAdapter (S1) — thin wrapper over `ctx.approval` (DSH 0.2.1-rc.5).
 *
 * Verified contract (types + source, see A1-IMPLEMENTATION-CONTRACT.md §8.4):
 *  - `ctx.approval.request(req): Promise<ApprovalOutcome>` MUST be called inside
 *    an OPEN TURN; an idle ask rejects/throws.
 *  - Missing answerer, throwing answerer, or a rogue return value resolve to
 *    'unavailable' (fail-closed). Only 'allowed-once' is a grant.
 *
 * This adapter adds nothing to DSH semantics; it only centralizes the
 * fail-closed decision so callers can gate on `isAllowed(outcome)`.
 */
import { normalizeOutcome, isAllowed } from './approval-policy.js';

export class ApprovalAdapter {
  /**
   * @param {any} ctx Cordis context (expects `ctx.approval` or `ctx.get('approval')`).
   * @param {Record<string,string>} [policy] approval policy map (for risk gating; see approval-policy.js).
   */
  constructor(ctx, policy = {}) {
    this.ctx = ctx;
    this.policy = policy;
  }

  /** @returns {any} the approval service, if available. */
  get service() {
    return this.ctx?.approval ?? this.ctx?.get?.('approval');
  }

  /**
   * Ask DSH for a decision. Fail-closed: any error or missing service -> 'unavailable'.
   * @param {any} req ApprovalRequest ({ agent, toolName, callId?, reason?, signal? }).
   * @returns {Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>}
   */
  async request(req) {
    const svc = this.service;
    if (!svc || typeof svc.request !== 'function') return 'unavailable';
    let outcome;
    try {
      outcome = await svc.request(req);
    } catch {
      // idle ask / no open turn / audit append failure — never grant on error.
      return 'unavailable';
    }
    return normalizeOutcome(outcome);
  }
}

export { normalizeOutcome, isAllowed };
