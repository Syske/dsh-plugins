/**
 * AicReadAdapter (S1 interface only) — A1 is READ-ONLY.
 *
 * A1 consumes AIC govern/evidence/evaluation capability READ-ONLY and must not
 * write through to AIC internal state (ADR-002; SECURITY-AND-PERMISSIONS §3).
 *
 * The concrete AIC HTTP/API surface is NOT yet verified (pending-validation).
 * This module intentionally contains NO network code. It fixes the read-only
 * boundary and leaves the real calls as a TODO for a later, verified phase.
 */
export class AicReadAdapter {
  /**
   * @param {object} config resolved config (config.aic.baseUrl/readOnly).
   */
  constructor(config = {}) {
    if (config?.aic?.readOnly === false) {
      throw new Error('AIC adapter must be read-only in A1 (write-through is forbidden)');
    }
    this.config = config;
  }

  /** @returns {true} always read-only in A1. */
  get readOnly() {
    return true;
  }

  /**
   * TODO(S2, pending-validation): fetch an Evaluation for a run/task via AIC
   * READ API. No writes. Concrete endpoint/schema not yet verified.
   * @param {string} _ref run/task reference
   * @returns {Promise<never>}
   */
  async getEvaluation(_ref) {
    throw new Error('not implemented: AIC read API pending-validation (no network in A1)');
  }
}
