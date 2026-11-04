/**
 * The /api/dsh-deepseek-chat route family: engine state, browser login control, and the
 * basic chat operations (new chat / send / stop / toggles). Every route carries
 * a loopback-only trust fence — these endpoints drive a browser, so LAN-exposed
 * deployments must not serve them. Adapted from dsh-web-chat (Apache-2.0).
 */

const MAX_JSON_BODY_BYTES = 64 * 1024

function isLoopbackRequest(req) {
  const host = req.headers.host ?? ''
  const address = req.socket.remoteAddress ?? ''
  const loopbackHost = host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')
  const loopbackAddr = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === undefined
  return loopbackHost && loopbackAddr
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function stringField(body, name) {
  const value = body?.[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Build every /api/dsh-deepseek-chat route. */
export function makeRoutes({ engine, store }) {
  const guard = (req, res) => {
    if (isLoopbackRequest(req)) return true
    writeJson(res, 403, { ok: false, error: 'loopback only' })
    return false
  }

  const stateView = async () => {
    const status = await engine.status()
    return {
      ok: true,
      engine: status.engine,
      engineError: status.engineError,
      loggedIn: status.loggedIn,
      pageUrl: status.pageUrl,
      deepThink: status.deepThink,
      search: status.search,
      busy: status.busy,
      lastError: status.lastError,
      lastErrorCode: status.lastErrorCode,
      activeChatId: store.activeChat()?.id,
      chats: store.list(),
    }
  }

  return [
    { kind: 'exact', path: '/api/dsh-deepseek-chat/state', handler: async (req, res) => {
      if (!guard(req, res)) return
      writeJson(res, 200, await stateView())
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/open-login', handler: async (req, res) => {
      if (!guard(req, res)) return
      const result = await engine.openLoginWindow()
      writeJson(res, result.ok ? 200 : 500, { ok: result.ok, error: result.error })
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/close-browser', handler: async (req, res) => {
      if (!guard(req, res)) return
      await engine.disposeBrowser()
      writeJson(res, 200, { ok: true })
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/new-chat', handler: async (req, res) => {
      if (!guard(req, res)) return
      const result = await engine.newChat()
      writeJson(res, result.ok ? 200 : 500, result)
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/send', handler: async (req, res) => {
      if (!guard(req, res)) return
      const body = await readJsonBody(req)
      const text = stringField(body, 'text')
      if (text === undefined) { writeJson(res, 400, { ok: false, error: '缺少 text 字段' }); return }
      const result = await engine.send(text, false)
      writeJson(res, result.ok ? 200 : 500, result)
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/stop', handler: async (req, res) => {
      if (!guard(req, res)) return
      await engine.stop()
      writeJson(res, 200, { ok: true })
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/deep-think', handler: async (req, res) => {
      if (!guard(req, res)) return
      const body = await readJsonBody(req)
      const enabled = typeof body?.['enabled'] === 'boolean' ? body['enabled'] : undefined
      if (enabled === undefined) { writeJson(res, 400, { ok: false, error: '缺少 enabled 字段' }); return }
      const result = await engine.setDeepThink(enabled)
      writeJson(res, result.ok ? 200 : 500, result)
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/search', handler: async (req, res) => {
      if (!guard(req, res)) return
      const body = await readJsonBody(req)
      const enabled = typeof body?.['enabled'] === 'boolean' ? body['enabled'] : undefined
      if (enabled === undefined) { writeJson(res, 400, { ok: false, error: '缺少 enabled 字段' }); return }
      const result = await engine.setSearch(enabled)
      writeJson(res, result.ok ? 200 : 500, result)
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/rename', handler: async (req, res) => {
      if (!guard(req, res)) return
      const body = await readJsonBody(req)
      const chatId = stringField(body, 'chatId')
      const title = stringField(body, 'title')
      if (chatId === undefined || title === undefined) { writeJson(res, 400, { ok: false, error: '缺少 chatId 或 title 字段' }); return }
      const renamed = store.renameChat(chatId, title)
      if (renamed === undefined) writeJson(res, 404, { ok: false, error: '找不到该对话记录' })
      else writeJson(res, 200, { ok: true })
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/delete', handler: async (req, res) => {
      if (!guard(req, res)) return
      const body = await readJsonBody(req)
      const chatId = stringField(body, 'chatId')
      if (chatId === undefined) { writeJson(res, 400, { ok: false, error: '缺少 chatId 字段' }); return }
      const deleted = store.deleteChat(chatId)
      if (!deleted) writeJson(res, 404, { ok: false, error: '找不到该对话记录' })
      else writeJson(res, 200, { ok: true })
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/web-chats', handler: async (req, res) => {
      if (!guard(req, res)) return
      const web = await engine.listWebConversations()
      // Annotate each web session with whether it is already imported locally,
      // matched by web session id (precise) or local title (fallback). Imported
      // entries remain in the list so the user can re-import to repair stale
      // history; the client renders them with a "refresh" affordance.
      const localTitles = new Set(store.titles())
      const localWebIds = new Set(store.webIds())
      const annotated = web.map((item) => {
        const m = /\/a\/chat\/s\/([0-9a-fA-F-]+)/.exec(item.href ?? '')
        const webId = m ? m[1] : undefined
        const imported = (webId !== undefined && localWebIds.has(webId)) || localTitles.has(item.title)
        return { ...item, webId, imported }
      })
      const missing = annotated.filter((item) => !item.imported).map((item) => item.title)
      writeJson(res, 200, { ok: true, web: annotated, missing })
    } },
    { kind: 'exact', path: '/api/dsh-deepseek-chat/recover', handler: async (req, res) => {
      if (!guard(req, res)) return
      const body = await readJsonBody(req)
      const title = stringField(body, 'title')
      const href = stringField(body, 'href')
      if (title === undefined && href === undefined) { writeJson(res, 400, { ok: false, error: '缺少 title 字段' }); return }
      const result = await engine.recoverWebConversation(title, href)
      writeJson(res, result.ok ? 200 : 500, result)
    } },
  ]
}