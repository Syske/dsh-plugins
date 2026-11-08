/**
 * Approval vocabulary + risk-policy evaluation (S1). Pure functions only.
 *
 * Outcome vocabulary is copied from the verified DSH 0.2.1-rc.5 type
 * (`@deepseek-ai/dsh-user-approval`): 'allowed-once' | 'rejected' |
 * 'cancelled' | 'unavailable'. Only 'allowed-once' is a grant; every other
 * value (and any rogue value) must be treated as "do not proceed" (fail-closed).
 */

/** @type {ReadonlyArray<string>} */
export const OUTCOMES = Object.freeze([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
]);

/** Risk levels used by the security model (see SECURITY-AND-PERMISSIONS.md). */
export const RISK_LEVELS = Object.freeze([
  'read',
  'test',
  'build',
  'workspaceWrite',
  'localCommit',
  'externalWrite',
  'gitPush',
  'npmPublish',
  'githubRelease',
  'secrets',
  'dangerFullAccess',
]);

/**
 * Normalize any answerer return value into the closed vocabulary.
 * Unknown / rogue values become 'unavailable' (fail-closed).
 * @param {unknown} outcome
 * @returns {'allowed-once'|'rejected'|'cancelled'|'unavailable'}
 */
export function normalizeOutcome(outcome) {
  return OUTCOMES.includes(/** @type {string} */ (outcome))
    ? /** @type {any} */ (outcome)
    : 'unavailable';
}

/**
 * Whether an outcome permits the action. Only 'allowed-once' grants.
 * @param {unknown} outcome
 * @returns {boolean}
 */
export function isAllowed(outcome) {
  return normalizeOutcome(outcome) === 'allowed-once';
}

/**
 * Evaluate a risk level against the approval policy.
 * Unknown decisions NEVER auto-allow: they fall back to 'ask'.
 * @param {string} level risk level name.
 * @param {Record<string,string>} [policy] approval policy map.
 * @returns {'allow'|'ask'|'deny'}
 */
export function evaluateRisk(level, policy = {}) {
  const decision = policy?.[level];
  if (decision === 'deny') return 'deny';
  if (decision === 'ask') return 'ask';
  if (decision === 'auto') return 'allow';
  return 'ask';
}
