/**
 * Host half of dsh-ui-zoom. All behaviour lives in the Client module: the zoom
 * factor is applied to the app shell and persisted in the browser, so the Host
 * half only needs to expose the bundle row.
 *
 * The unused `ctx` parameter is declared deliberately: the DSH plugin contract
 * is `apply(ctx)`, and keeping the signature explicit makes the entry point
 * obvious to readers and to repository scanners.
 */
export function apply(ctx) {
  void ctx
}
