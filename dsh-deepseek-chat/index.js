/**
 * dsh-deepseek-chat — host half.
 *
 * Mounts the DeepSeek web engine (a real browser at chat.deepseek.com driven
 * through its own page, persistent login profile) and the /api/dsh-deepseek-chat route
 * family. The browser half (./client) renders the chat panel. No dsh source
 * changes; transport uses the host's webServer service.
 */
import { DeepSeekWebEngine } from './engine/engine.js'
import { TranscriptStore, defaultDataDir } from './store.js'
import { makeRoutes } from './routes.js'

/** Stable cordis plugin name. */
export const name = 'dsh-deepseek-chat'

/** Services required before the surfaces can mount. */
export const inject = ['webServer']

/**
 * Plugin config (plain object schema; the loader passes the row's `config`
 * through unchanged).
 */
export function apply(ctx, config) {
  const value = config ?? {}
  const dataDir = (value.dataDir ?? '').trim()
  const engineConfig = {
    dataDir: dataDir !== '' ? dataDir : defaultDataDir(),
    channel: value.browserChannel && value.browserChannel !== 'auto' ? value.browserChannel : undefined,
    executablePath: value.browserExecutablePath && value.browserExecutablePath !== '' ? value.browserExecutablePath : undefined,
    proxy: value.browserProxy ?? 'direct',
    headless: value.browserHeadless ?? true,
    replyTimeoutMs: value.replyTimeoutMs ?? 180_000,
    // Auto-close the browser after this many ms of inactivity (0 = keep open).
    idleTimeoutMs: typeof value.idleTimeoutMs === 'number' ? value.idleTimeoutMs : 5 * 60_000,
  }

  const store = new TranscriptStore({ dataDir: dataDir !== '' ? dataDir : undefined })
  const engine = new DeepSeekWebEngine(store, engineConfig)

  // Release the browser when the plugin unmounts.
  ctx.effect(() => () => { void engine.disposeBrowser() }, 'dsh-deepseek-chat: engine')

  // Register the HTTP route family.
  ctx.effect(() => {
    const routes = makeRoutes({ engine, store })
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-deepseek-chat: routes')
}
