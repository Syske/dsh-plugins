/**
 * DeepSeek web engine for dsh-deepseek-chat.
 *
 * Drives a real browser (system Chrome/Edge/Chromium via playwright-core, or a
 * playwright-managed Chromium) against chat.deepseek.com with a dedicated
 * persistent profile, so the user logs in once with their own DeepSeek account
 * and the session persists. Chatting happens THROUGH the real web page —
 * messages are typed into the real composer — so the plugin needs no API key,
 * no billing, and stays immune to DeepSeek's private-API PoW challenge.
 *
 * Replies are read by teeing the page's own SSE stream: an injected init script
 * wraps XMLHttpRequest/fetch and captures the `/api/v0/chat/completion`
 * response as it streams (the page has already solved PoW + auth, so we get the
 * model's raw markdown for free). DOM scraping of `.ds-markdown` is kept only
 * as a fallback for when the capture cannot install.
 *
 * Adapted from dsh-web-chat (Apache-2.0), trimmed to basic chat.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { serializeToMarkdown } from './html-md.js'

const DEFAULT_TIMEOUT_MS = 180_000

/**
 * Discover a downloaded (playwright-managed) Chromium/Chrome binary across
 * common browser cache roots. Search order:
 *   1. `PLAYWRIGHT_BROWSERS_PATH` (explicit override)
 *   2. a `.playwright-browsers` directory in any ancestor of this package
 *      (supports a workspace-local, read-only-`~`-safe install)
 *   3. the standard per-user Playwright cache (`~/.cache/ms-playwright`)
 * Returns the chrome executable path, or undefined.
 */
export function discoverChromium() {
  const roots = []
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH)
  // Walk up from this file's directory looking for a workspace-local cache.
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      roots.push(join(dir, '.playwright-browsers'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* ignore */ }
  roots.push(join(process.env.HOME ?? '.', '.cache', 'ms-playwright'))
  const relByPlatform = [
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-linux/headless_shell', null],
  ]
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    let entries
    try { entries = readdirSync(root) } catch { continue }
    for (const entry of entries) {
      if (!/^chromium-\d+$/.test(entry) && !/^chromium_headless_shell-\d+$/.test(entry)) continue
      const base = join(root, entry)
      const candidates = []
      for (const [dir, bin] of relByPlatform) {
        if (bin === null) continue
        candidates.push(join(base, dir, bin))
        candidates.push(join(base, dir, 'headless_shell'))
      }
      // Fallback: scan one level for a chrome binary.
      try {
        for (const sub of readdirSync(base)) {
          candidates.push(join(base, sub, 'chrome'))
          candidates.push(join(base, sub, 'headless_shell'))
        }
      } catch { /* ignore */ }
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}


/**
 * Injected before any page script: tee the chat/completion stream into
 * `window.__wcStream`. Must stay self-contained (playwright serializes it).
 */
function streamCaptureInit() {
  const w = window
  if (w.__wcCaptureInstalled === true) return
  w.__wcCaptureInstalled = true
  w.__wcStream = { text: '', done: false, started: false, status: 0, error: '' }
  const X = w.XMLHttpRequest
  const origOpen = X.prototype.open
  const origSend = X.prototype.send
  X.prototype.open = function (method, url, ...rest) {
    this.__wcIsChat = typeof url === 'string' && url.includes('/chat/completion')
    return origOpen.call(this, method, url, ...rest)
  }
  X.prototype.send = function (...args) {
    if (this.__wcIsChat === true) {
      let lastLen = 0
      this.addEventListener('progress', () => {
        const stream = w.__wcStream
        if (stream === undefined) return
        const text = this.responseText ?? ''
        if (text.length > lastLen) {
          stream.text += text.slice(lastLen)
          lastLen = text.length
        }
        stream.started = true
      })
      this.addEventListener('loadend', () => {
        const stream = w.__wcStream
        if (stream === undefined) return
        stream.done = true
        stream.status = this.status
        if (this.status >= 400) stream.error = `HTTP ${this.status}`
      })
    }
    return origSend.apply(this, args)
  }

  const origFetch = w.fetch.bind(w)
  w.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    const isChat = typeof url === 'string' && url.includes('/chat/completion')
    return origFetch(input, init).then((response) => {
      if (!isChat || response === null || response === undefined) return response
      const body = response.body
      if (body === null || body === undefined || typeof body.tee !== 'function') return response
      try {
        const [pageStream, captureStream] = body.tee()
        const decoder = new w.TextDecoder()
        const reader = captureStream.getReader()
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              const stream = w.__wcStream
              if (stream !== undefined) {
                stream.text += decoder.decode(value, { stream: true })
                stream.started = true
              }
            }
            const stream = w.__wcStream
            if (stream !== undefined) {
              stream.text += decoder.decode()
              stream.done = true
              stream.status = response.status
              if (response.status >= 400) stream.error = `HTTP ${response.status}`
            }
          } catch {
            // capture failure must never break the page's own consumption
          }
        })()
        return new w.Response(pageStream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } catch {
        return response
      }
    })
  }
}

/** True when a fragment type is the R1 reasoning (THINK / THINKING). */
function isThinkingType(type) {
  return typeof type === 'string' && type.toUpperCase().includes('THINK')
}

/**
 * Parse the accumulated `/api/v0/chat/completion` SSE body into reply text.
 * See the reference project for the full protocol description.
 */
export function parseStreamReply(raw) {
  let body = ''
  let thinking = ''
  let finished = false
  let currentType = 'RESPONSE'
  /** True only while the *last observed fragment* was explicitly a THINK one. */
  let lastFragmentIsThinking = false
  /** True once the stream has declared an answer fragment (RESPONSE / TEXT). */
  let sawAnswerType = false

  const searchResults = []
  const openById = new Map()
  let urlToIndex

  const buildUrlIndex = () => {
    if (urlToIndex === undefined) {
      urlToIndex = new Map()
      searchResults.forEach((url, i) => {
        if (url !== '' && !urlToIndex.has(url)) urlToIndex.set(url, i)
      })
    }
    return urlToIndex
  }

  const resolveCitations = (text, refs) => {
    if (!Array.isArray(refs) || refs.length === 0) return text
    let i = 0
    return text.replace(/\[reference:\d+\]/g, () => {
      const ref = refs[i]
      i++
      if (typeof ref !== 'object' || ref === null) return ''
      if (ref['type'] !== 'TOOL_OPEN') return ''
      const id = ref['id']
      const url = typeof id === 'number' ? openById.get(id) : undefined
      if (url === undefined) return ''
      const idx = buildUrlIndex().get(url)
      return idx === undefined ? '' : `[citation:${idx + 1}]`
    })
  }

  const appendContent = (text) => {
    // `response/fragments/-1/content` appends to the last fragment, so a delta
    // continues that fragment: reasoning stays in the reasoning buffer and
    // answers in the body. The page does not always announce the switch — it
    // also streams answer text straight onto a reasoning fragment before the
    // first RESPONSE fragment arrives, which is what made replies start
    // mid-sentence. Distinguish the two cases by content: reasoning fragments
    // only ever precede the answer, so once any answer text exists every later
    // delta is answer text.
    if (lastFragmentIsThinking && body === '' && !sawAnswerType) thinking += text
    else body += text
  }

  const appendFragments = (fragments) => {
    const opened = []
    for (const frag of fragments) {
      if (typeof frag !== 'object' || frag === null) continue
      const type = frag['type']
      if (typeof type === 'string') {
        currentType = type
        lastFragmentIsThinking = isThinkingType(type)
        if (!lastFragmentIsThinking) sawAnswerType = true
      }
      const content = frag['content']
      if (typeof content === 'string' && content !== '') {
        if (isThinkingType(type)) thinking += content
        else if (type === 'RESPONSE' || type === 'TEXT') body += content
      }
      if (type === 'TOOL_OPEN') {
        const result = frag['result']
        const title = result?.['title']
        if (typeof title === 'string' && title !== '') opened.push(title)
        const id = frag['id']
        const url = result?.['url']
        if (typeof id === 'number' && typeof url === 'string' && url !== '') {
          openById.set(id, url)
        }
      }
    }
    if (opened.length > 0) {
      thinking += `\n\n浏览 ${opened.length} 个页面\n${opened.map((t) => `- ${t}`).join('\n')}\n\n`
    }
  }

  const applyBatchOps = (ops) => {
    let contentText = ''
    let hasContent = false
    let refs = null
    const fragmentsList = []
    for (const item of ops) {
      if (typeof item !== 'object' || item === null) continue
      const ip = item['p']
      const iop = item['o']
      const iv = item['v']
      if (ip === 'content' && iop === 'APPEND' && typeof iv === 'string') {
        contentText += iv
        hasContent = true
      } else if (ip === 'references' && Array.isArray(iv)) {
        refs = iv
      } else if (ip === 'fragments' && iop === 'APPEND' && Array.isArray(iv)) {
        fragmentsList.push(iv)
      }
    }
    for (const fr of fragmentsList) appendFragments(fr)
    if (hasContent) {
      if (isThinkingType(currentType)) thinking += contentText
      else body += resolveCitations(contentText, refs)
    }
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '') continue
    let obj
    try {
      obj = JSON.parse(payload)
    } catch {
      continue
    }
    if (typeof obj !== 'object' || obj === null) continue
    const v = obj['v']

    if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'response' in v) {
      const resp = v['response']
      const fragments = resp?.['fragments']
      if (Array.isArray(fragments)) {
        let newBody = ''
        let newThinking = ''
        for (const frag of fragments) {
          if (typeof frag !== 'object' || frag === null) continue
          const type = frag['type']
          if (typeof type === 'string') {
            currentType = type
            lastFragmentIsThinking = isThinkingType(type)
            if (!lastFragmentIsThinking) sawAnswerType = true
          }
          const content = frag['content']
          if (typeof content !== 'string' || content === '') continue
          if (isThinkingType(type)) newThinking += content
          else if (type === 'RESPONSE' || type === 'TEXT') newBody += content
        }
        // A snapshot is authoritative for the fragments it actually carries, but
        // it must never *shrink* what we already assembled: partial snapshots
        // arrive mid-stream and used to wipe the answer body (or the reasoning)
        // accumulated from the incremental ops. Keep the longer text.
        if (newBody.length >= body.length) body = newBody
        if (newThinking.length >= thinking.length) thinking = newThinking
      }
      continue
    }

    const p = obj['p']
    const op = obj['o']

    if (p === 'response/fragments' && op === 'APPEND' && Array.isArray(v)) {
      appendFragments(v)
      continue
    }

    if (typeof p === 'string') {
      if (typeof v === 'string' && p === 'response/fragments/-1/content' && op !== 'SET') {
        appendContent(v)
      } else if (op === 'SET' && p === 'response/fragments/-1/results' && Array.isArray(v)) {
        for (const r of v) {
          if (typeof r === 'object' && r !== null) {
            const url = r['url']
            if (typeof url === 'string' && url !== '') searchResults.push(url)
          }
        }
        thinking += `\n\n搜索到 ${v.length} 个网页\n\n`
      } else if (op === 'SET' && p === 'response/status' && v === 'FINISHED') {
        finished = true
      } else if (op === 'BATCH' && Array.isArray(v)) {
        applyBatchOps(v)
      }
      continue
    }

    if (Array.isArray(v)) {
      applyBatchOps(v)
      continue
    }

    if (typeof v === 'string') appendContent(v)
  }

  const thinkMd = thinking.trim() === ''
    ? ''
    : `<details><summary>思考过程</summary>\n\n${thinking.trim()}\n\n</details>`
  const markdown = [thinkMd, body.trim()].filter((s) => s !== '').join('\n\n')
  return { markdown, thinking, finished }
}

/** Order-preserving promise queue — the browser page handles one chat op at a time. */
class SerialQueue {
  constructor() { this.tail = Promise.resolve() }
  run(task) {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => undefined)
    return next
  }
}

function stripSearchTrace(text) {
  return text
    .replace(/DEEP_SEARCH/g, '')
    .replace(/FINISHED+/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class DeepSeekWebEngine {
  constructor(store, config) {
    this.store = store
    this.config = config
    this.profileDir = join(config.dataDir, 'browser-profile')
    this.context = undefined
    this.page = undefined
    this.queue = new SerialQueue()
    this.state = 'stopped'
    this.engineError = undefined
    this.busy = false
    this.lastError = undefined
    this.lastErrorCode = undefined
    this.launchedOnce = false
    this.loginMode = false
    // Persisted "last known signed-in" hint so the panel shows the right state
    // after the browser idle-closes or the plugin reloads (in-memory alone would
    // fall back to "unknown"). Written to a tiny flag file in the data dir.
    this.loginStateFile = join(config.dataDir, 'login-state.json')
    this.loggedInOnce = this.readLoginState()
    this.deepThink = false
    this.search = false
    // Idle auto-close: while the browser is up but unused for `idleTimeoutMs`,
    // close it to release the (heavy) Chromium footprint. 0 disables it.
    this.idleTimeoutMs = Number.isFinite(config.idleTimeoutMs) ? config.idleTimeoutMs : 5 * 60_000
    this.idleTimer = undefined
    this.lastActivityAt = 0
  }

  /** Read the persisted "last known signed-in" flag (best effort). */
  readLoginState() {
    try {
      const raw = readFileSync(this.loginStateFile, 'utf8')
      return JSON.parse(raw)?.loggedIn === true
    } catch {
      return false
    }
  }

  /** Persist the "last known signed-in" flag when it changes. */
  setLoggedIn(value) {
    const next = value === true
    if (this.loggedInOnce === next) return
    this.loggedInOnce = next
    try {
      mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 })
      writeFileSync(this.loginStateFile, JSON.stringify({ loggedIn: next }), { mode: 0o600 })
    } catch { /* best effort */ }
  }

  /**
   * Mark the engine as recently used and (re)arm the idle-close timer. Every
   * user-initiated operation and every streamed reply calls this, so the idle
   * countdown only fires after genuine inactivity.
   */
  touch() {
    this.lastActivityAt = Date.now()
    if (this.idleTimer !== undefined) { clearTimeout(this.idleTimer); this.idleTimer = undefined }
    if (this.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => { void this.closeIdle() }, this.idleTimeoutMs)
      if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
    }
  }

  /** Cancel the idle timer (during teardown). */
  stopIdleTimer() {
    if (this.idleTimer !== undefined) { clearTimeout(this.idleTimer); this.idleTimer = undefined }
  }

  /**
   * Idle-close callback: close the browser if it is still idle. Re-arms instead
   * of closing while a reply is generating or a login window is open.
   */
  async closeIdle() {
    this.idleTimer = undefined
    if (this.busy || this.loginMode) { this.touch(); return }
    if (Date.now() - this.lastActivityAt < this.idleTimeoutMs) { this.touch(); return }
    await this.disposeBrowser()
  }

  getState() { return this.state }
  getBusy() { return this.busy }
  getLastError() { return this.lastError }
  getLastErrorCode() { return this.lastErrorCode }

  setLastError(message, code) {
    this.lastError = message
    this.lastErrorCode = code
  }

  setState(next, error) {
    this.state = next
    this.engineError = error
  }

  /** Resolve a browser launch descriptor list (executable + args). */
  launchOptionsCandidates() {
    const args = []
    const proxy = this.config.proxy ?? 'direct'
    if (proxy === 'direct') args.push('--no-proxy-server')
    else if (proxy.startsWith('http')) args.push(`--proxy-server=${proxy}`)
    const all = [
      { channel: 'chrome', args },
      { channel: 'msedge', args },
      { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args },
      { executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', args },
      { executablePath: '/usr/bin/google-chrome', args },
      { executablePath: '/usr/bin/google-chrome-stable', args },
      { executablePath: '/usr/bin/microsoft-edge', args },
      { executablePath: '/usr/bin/chromium', args },
      { executablePath: '/usr/bin/chromium-browser', args },
      { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args },
      { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args },
    ]
    if (this.config.executablePath !== undefined && this.config.executablePath !== '') {
      return [{ executablePath: this.config.executablePath, args }]
    }
    if (this.config.channel !== undefined && this.config.channel !== '' && this.config.channel !== 'auto') {
      return [{ channel: this.config.channel, args }]
    }
    // A discovered downloaded Chromium is the most reliable choice here.
    const discovered = discoverChromium()
    if (discovered !== undefined) return [{ executablePath: discovered, args }]
    // Filter to existing explicit paths; keep channel probes (playwright resolves them).
    const existing = all.filter((candidate) => {
      if (candidate.channel !== undefined) return true
      return candidate.executablePath !== undefined && existsSync(candidate.executablePath)
    })
    // Always allow the playwright-managed Chromium as a last resort: an empty
    // launch (no executablePath/channel) uses the bundled browser if installed.
    existing.push({ args })
    return existing
  }

  isPageAlive() {
    if (this.page === undefined || this.context === undefined) return false
    try {
      return !this.page.isClosed()
    } catch {
      return false
    }
  }

  async ensureBrowser() {
    if (this.isPageAlive()) return this.page
    if (this.state === 'launching') {
      for (let attempt = 0; attempt < 100 && !this.isPageAlive(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (this.isPageAlive()) return this.page
      throw new Error('浏览器启动超时')
    }
    if (this.page !== undefined || this.context !== undefined) await this.disposeBrowser()
    this.setState('launching')
    try {
      mkdirSync(this.profileDir, { recursive: true, mode: 0o700 })
      // Chrome writes crash/config state under $HOME/.config; this host's
      // ~/.config is read-only, so point Chrome at a writable config root under
      // the plugin data dir and disable crash reporting.
      const chromeHome = join(this.config.dataDir, 'chrome-home')
      const chromeConfig = join(chromeHome, '.config')
      mkdirSync(chromeConfig, { recursive: true, mode: 0o700 })
      process.env.HOME = process.env.HOME ?? chromeHome
      const launchEnv = {
        ...process.env,
        HOME: chromeHome,
        XDG_CONFIG_HOME: chromeConfig,
        XDG_CACHE_HOME: join(chromeHome, '.cache'),
      }
      mkdirSync(launchEnv.XDG_CACHE_HOME, { recursive: true, mode: 0o700 })

      const attemptOrder = this.launchOptionsCandidates()
      let lastError
      for (const attempt of attemptOrder) {
        try {
          this.context = await chromium.launchPersistentContext(this.profileDir, {
            ...attempt,
            env: launchEnv,
            headless: this.loginMode ? false : (this.config.headless ?? true),
            viewport: null,
            args: [...(attempt.args ?? []), '--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad'],
          })
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          await this.disposeBrowser()
        }
      }
      if (lastError !== undefined) {
        this.setState('error', `无法启动浏览器（请检查 Chrome/Edge/Chromium 是否已安装，或在插件设置中指定可执行文件路径）: ${String(lastError)}`)
        throw new Error(this.engineError)
      }
      const pages = this.context.pages()
      this.page = pages[0] ?? (await this.context.newPage())
      this.page.setDefaultTimeout(15_000)
      await this.page.addInitScript(streamCaptureInit)
      await this.openDeepSeekPage()
      this.setState('ready')
      this.launchedOnce = true
      this.touch()
      return this.page
    } catch (error) {
      if (this.state !== 'error') this.setState('error', String(error))
      throw error
    }
  }

  async openDeepSeekPage() {
    if (this.page === undefined) throw new Error('浏览器尚未启动')
    const baseUrl = this.config.baseUrl ?? 'https://chat.deepseek.com'
    try {
      await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await this.page.waitForTimeout(2_500)
    } catch (error) {
      this.setState('error', `无法打开 ${baseUrl}：${String(error)}`)
      throw new Error(this.engineError)
    }
  }

  async isLoggedIn() {
    if (!this.isPageAlive()) return null
    try {
      const url = this.page.url()
      if (url.includes('/sign_in') || url.includes('/auth')) return false
      const hasComposer = await this.page.locator('textarea').count().then((count) => count > 0).catch(() => false)
      return hasComposer
    } catch {
      return null
    }
  }

  async openLoginWindow() {
    try {
      if (this.page !== undefined || this.context !== undefined) await this.disposeBrowser()
      this.loginMode = true
      await this.ensureBrowser()
      await this.page?.bringToFront()
      void this.watchLoginAndClose()
      return { ok: true }
    } catch (error) {
      this.loginMode = false
      return { ok: false, error: String(error) }
    }
  }

  async watchLoginAndClose() {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (!this.loginMode) return
      if (!this.isPageAlive()) {
        this.loginMode = false
        return
      }
      if (await this.isLoggedIn() === true) {
        this.loginMode = false
        this.setLoggedIn(true)
        await this.disposeBrowser().catch(() => undefined)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  pageUrl() {
    if (!this.isPageAlive()) return undefined
    try {
      return this.page?.url()
    } catch {
      return undefined
    }
  }

  async readToggles() {
    if (!this.isPageAlive()) return { deepThink: this.deepThink, search: this.search }
    try {
      const pageState = await this.page.evaluate(() => {
        const read = (candidates) => {
          for (const el of Array.from(document.querySelectorAll('[aria-pressed]'))) {
            const label = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`
            if (!candidates.some((candidate) => label.includes(candidate))) continue
            const pressed = el.getAttribute('aria-pressed')
            if (pressed === 'true') return true
            if (pressed === 'false') return false
            const cls = typeof el.className === 'string' ? el.className : ''
            if (/ds-toggle-button--selected|--selected|active|checked/i.test(cls)) return true
          }
          return undefined
        }
        return {
          deepThink: read(['深度思考', 'DeepThink', 'Deep Think', 'R1']),
          search: read(['智能搜索', '联网搜索', '搜索', 'Search']),
        }
      })
      return {
        deepThink: pageState.deepThink ?? this.deepThink,
        search: pageState.search ?? this.search,
      }
    } catch {
      return { deepThink: this.deepThink, search: this.search }
    }
  }

  async scrapeConversation() {
    if (this.page === undefined) return []
    const raw = await this.page.evaluate(() => {
      const extract = (element) => {
        const clone = element.cloneNode(true)
        for (const junk of clone.querySelectorAll('.ds-markdown-code-copy-button, button, svg, [class*="copy"]')) {
          junk.remove()
        }
        return { markdown: clone.innerHTML, text: clone.innerText }
      }
      const out = []
      const items = document.querySelectorAll('[data-virtual-list-item-key]')
      for (const item of Array.from(items)) {
        const assistant = item.querySelector('.ds-assistant-message-main-content')
        if (assistant !== null) {
          const parts = []
          const think = item.querySelector('.ds-think-content')
          if (think !== null) parts.push({ kind: 'think', ...extract(think) })
          const body = assistant.classList.contains('ds-markdown')
            ? assistant
            : assistant.querySelector('.ds-markdown')
          if (body !== null) parts.push({ kind: 'body', ...extract(body) })
          if (parts.length > 0) out.push({ role: 'assistant', parts })
        } else {
          const clone = item.cloneNode(true)
          for (const junk of clone.querySelectorAll('button, svg, [class*="copy"]')) junk.remove()
          const text = (clone.innerText ?? '').trim()
          if (text !== '') out.push({ role: 'user', parts: [{ kind: 'body', markdown: '', text }] })
        }
      }
      return out
    })
    return raw
  }

  /** Convert scraped DOM messages into transcript messages (markdown content). */
  scrapedToMessages(scraped) {
    return scraped.map((message) => {
      if (message.role === 'user') {
        const text = message.parts.map((part) => part.text).join('\n\n').trim()
        return { id: randomUUID(), role: 'user', content: text === '' ? '（无内容）' : text, ts: Date.now() }
      }
      const think = message.parts.filter((part) => part.kind === 'think').map((part) => part.text).join('\n\n').trim()
      const bodyHtml = message.parts.find((part) => part.kind === 'body')?.markdown ?? ''
      const bodyMd = bodyHtml === '' ? '' : stripSearchTrace(serializeToMarkdown(parseMarkup(bodyHtml)))
      const thinkMd = think === '' ? '' : `<details><summary>思考过程</summary>\n\n${think}\n\n</details>`
      return { id: randomUUID(), role: 'assistant', content: [thinkMd, bodyMd].filter(Boolean).join('\n\n'), ts: Date.now() }
    })
  }

  /**
   * Convert a parsed `/api/v0/chat/history_messages` payload into transcript
   * messages. Unlike DOM scraping, this source is COMPLETE (no virtual-list /
   * lazy-render truncation) and already carries raw markdown in RESPONSE
   * fragments. fragment types: USER.REQUEST / USER.FILE, ASSISTANT.THINK /
   * RESPONSE / SEARCH / TOOL_SEARCH / TOOL_OPEN / TIP.
   */
  historyJsonToMessages(payload) {
    const msgs = payload?.data?.biz_data?.chat_messages
    if (!Array.isArray(msgs)) return []
    const out = []
    for (const m of msgs) {
      const fragments = m.fragments ?? []
      const ts = m.inserted_at ? Math.round(m.inserted_at * 1000) : Date.now()
      if (m.role === 'USER') {
        const req = fragments.find((f) => f.type === 'REQUEST')
        const fileNames = fragments
          .filter((f) => f.type === 'FILE')
          .flatMap((f) => (f.files ?? []).map((file) => file.file_name).filter(Boolean))
        let text = (req?.content ?? '').trim()
        if (fileNames.length > 0) {
          text = [text, fileNames.map((n) => `📎 ${n}`).join('\n')].filter(Boolean).join('\n\n')
        }
        if (text === '') continue
        out.push({ id: randomUUID(), role: 'user', content: text, ts })
        continue
      }
      if (m.role !== 'ASSISTANT') continue
      const thinkParts = fragments.filter((f) => f.type === 'THINK' && (f.content ?? '').trim() !== '').map((f) => f.content.trim())
      const bodyParts = fragments.filter((f) => f.type === 'RESPONSE' && (f.content ?? '').trim() !== '').map((f) => f.content.trim())
      // Strip the web's citation markers ([citation:N] / [reference:N]) for clean text.
      const clean = (s) => s.replace(/\[(?:citation|reference):\d+\]/g, '')
      const searchCount = fragments.filter((f) => f.type === 'SEARCH' || f.type === 'TOOL_SEARCH').length
      const openedCount = fragments.filter((f) => f.type === 'TOOL_OPEN').length
      const thinkMd = thinkParts.length === 0 ? '' : `<details><summary>思考过程</summary>\n\n${clean(thinkParts.join('\n\n'))}\n\n</details>`
      const searchMd = (searchCount > 0 || openedCount > 0)
        ? `> 🔎 联网搜索${openedCount > 0 ? ` · 浏览 ${openedCount} 个页面` : ''}`
        : ''
      const body = clean(bodyParts.join('\n\n'))
      const content = [thinkMd, searchMd, body].filter((s) => s !== '').join('\n\n')
      if (content.trim() === '') continue
      out.push({ id: randomUUID(), role: 'assistant', content, ts })
    }
    return out
  }

  /**
   * Scrape the DeepSeek sidebar conversation list (best effort). Each web
   * conversation is an <a href="/a/chat/s/<id>">Title</a> anchor, so we collect
   * those anchors (href + visible title). Returns [{ title, href }].
   */
  async listWebConversations() {
    this.touch()
    if (!this.isPageAlive()) {
      try { await this.ensureBrowser() } catch { return [] }
    }
    if (await this.isLoggedIn() !== true) return []
    // Primary: the sidebar session-list API (authoritative id + title).
    const viaApi = await this.page.evaluate(async () => {
      let token = null
      try { const raw = localStorage.getItem('userToken'); if (raw) { try { token = JSON.parse(raw).value } catch { token = raw } } } catch { /* ignore */ }
      const headers = token ? { authorization: 'Bearer ' + token } : {}
      try {
        const r = await fetch('https://chat.deepseek.com/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', { credentials: 'include', headers })
        const j = await r.json()
        const sessions = j?.data?.biz_data?.chat_sessions ?? []
        return sessions.map((s) => ({ title: s.title || '未命名会话', href: '/a/chat/s/' + s.id }))
      } catch { return [] }
    }).catch(() => [])
    if (Array.isArray(viaApi) && viaApi.length > 0) return viaApi
    // Fallback: scrape sidebar anchors.
    const items = await this.page.evaluate(() => {
      const found = []
      const seen = new Set()
      for (const el of Array.from(document.querySelectorAll('a[href*="/a/chat/"]'))) {
        const href = el.getAttribute('href') ?? ''
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
        if (href === '' || text === '') continue
        if (text.length > 120) continue
        if (seen.has(href)) continue
        seen.add(href)
        found.push({ title: text, href })
      }
      return found.slice(0, 200)
    }).catch(() => [])
    return items
  }

  /** Click a sidebar conversation by its href (preferred) or by title match. */
  async clickConversationByTitle(title, href) {
    if (this.page === undefined) return false
    if (href) {
      const byHref = this.page.locator(`a[href="${href}"]`).first()
      if (await byHref.count().catch(() => 0) > 0) {
        await byHref.click({ timeout: 5_000 }).catch(() => undefined)
        return true
      }
    }
    const byTitle = this.page.locator('a[href*="/a/chat/"]').filter({ hasText: title }).first()
    if (await byTitle.count().catch(() => 0) > 0) {
      await byTitle.click({ timeout: 5_000 }).catch(() => undefined)
      return true
    }
    // Fallback: legacy container selectors.
    const selectors = ['[class*="conversation"]', '[class*="chat-item"]', '[class*="session-item"]']
    for (const selector of selectors) {
      const locator = this.page.locator(selector).filter({ hasText: title }).first()
      if (await locator.count().catch(() => 0) > 0) {
        await locator.click({ timeout: 5_000 }).catch(() => undefined)
        return true
      }
    }
    return false
  }

  /**
   * Recover a web conversation into the local transcript store: open it in the
   * sidebar, scrape its history, and import it (idempotent by title).
   */
  async recoverWebConversation(title, href) {
    this.touch()
    if (this.page === undefined) {
      try { await this.ensureBrowser() } catch (error) { return { ok: false, error: String(error) } }
    }
    if (await this.isLoggedIn() !== true) {
      return { ok: false, error: '尚未登录 DeepSeek 网页端，请先打开登录窗口登录' }
    }
    try {
      const base = this.config.baseUrl ?? 'https://chat.deepseek.com'
      // Derive the chat session id from the href (/a/chat/s/<id>) or from a
      // direct title lookup via the sidebar API.
      let sessionId
      let resolvedTitle = title
      if (href) {
        const m = /\/a\/chat\/s\/([0-9a-fA-F-]+)/.exec(href)
        if (m) sessionId = m[1]
      }

      // Preferred: call the history API from inside the page (inherits login
      // cookies + token via localStorage) WITHOUT cache params, which returns
      // the COMPLETE transcript. This is the only reliable source for long
      // conversations (the page's own call after load returns a delta).
      const fullFetch = await this.page.evaluate(async ({ sid, title }) => {
        const apiBase = 'https://chat.deepseek.com'
        let token = null
        try {
          const raw = localStorage.getItem('userToken')
          if (raw) { try { token = JSON.parse(raw).value } catch { token = raw } }
        } catch { /* ignore */ }
        let sessionId = sid
        // If no session id, resolve by title from the session list API.
        if (!sessionId) {
          try {
            const r = await fetch(apiBase + '/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', { credentials: 'include', headers: token ? { authorization: 'Bearer ' + token } : {} })
            const j = await r.json()
            const sessions = j?.data?.biz_data?.chat_sessions ?? []
            const hit = sessions.find((s) => s.title === title)
            if (hit) sessionId = hit.id
          } catch { /* ignore */ }
        }
        if (!sessionId) return { ok: false, error: 'NOT_FOUND' }
        const headers = token ? { authorization: 'Bearer ' + token } : {}
        const r = await fetch(apiBase + '/api/v0/chat/history_messages?chat_session_id=' + sessionId, { credentials: 'include', headers })
        const j = await r.json()
        if (j.code !== 0) return { ok: false, error: 'API_CODE_' + j.code, sessionId }
        const bd = j?.data?.biz_data
        return { ok: true, sessionId, title: bd?.chat_session?.title, messages: bd?.chat_messages ?? [] }
      }, { sid: sessionId, title: resolvedTitle }).catch((e) => ({ ok: false, error: String(e) }))

      if (fullFetch?.ok === true && Array.isArray(fullFetch.messages)) {
        const messages = this.historyJsonToMessages({ data: { biz_data: { chat_messages: fullFetch.messages } } })
        if (messages.length > 0) {
          const finalTitle = resolvedTitle || fullFetch.title || '未命名会话'
          const model = this.deepThink ? 'deepseek-reasoner' : 'deepseek-chat'
          const result = this.store.importTranscript({ title: finalTitle, model, messages, webId: fullFetch.sessionId })
          return { ok: true, chatId: result.chat.id, title: result.chat.title, created: result.created, updated: result.updated, count: messages.length, webId: fullFetch.sessionId }
        }
        if (fullFetch.messages.length === 0) {
          return { ok: false, error: '该会话为空或网页端未返回消息' }
        }
      }

      // Fallback: open via DOM and scrape the rendered messages (may be partial
      // for long conversations because of virtualization).
      let opened = false
      if (href) {
        const target = href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`
        await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined)
        await this.page.waitForTimeout(3_500)
        opened = true
      } else {
        opened = await this.clickConversationByTitle(title)
        if (opened) await this.page.waitForTimeout(2_500)
      }
      if (!opened) return { ok: false, error: `未在网页端找到会话「${title}」` }
      for (let i = 0; i < 8; i++) {
        const n = await this.page.evaluate(() => document.querySelectorAll('[data-virtual-list-item-key]').length).catch(() => 0)
        if (n > 0) break
        await this.page.waitForTimeout(700)
      }
      const scraped = await this.scrapeConversation()
      if (scraped.length === 0) return { ok: false, error: '读取网页会话历史失败（页面可能已改版或该会话为空）' }
      const messages = this.scrapedToMessages(scraped)
      const model = this.deepThink ? 'deepseek-reasoner' : 'deepseek-chat'
      const result = this.store.importTranscript({ title, model, messages, webId: sessionId })
      return { ok: true, chatId: result.chat.id, title: result.chat.title, created: result.created, updated: result.updated, count: messages.length, webId: sessionId }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  async isGenerating() {
    if (this.page === undefined) return false
    try {
      const stopSelectors = [
        'button[aria-label*="停止"]',
        '[aria-label*="stop generating" i]',
        'button:has-text("停止生成")',
        'button:has-text("Stop generating")',
      ]
      for (const selector of stopSelectors) {
        if (await this.page.locator(selector).count().catch(() => 0) > 0) return true
      }
      return false
    } catch {
      return false
    }
  }

  async stop() {
    await this.queue.run(async () => {
      if (this.page === undefined) return
      const stopSelectors = [
        'button[aria-label*="停止"]',
        '[aria-label*="stop generating" i]',
        'button:has-text("停止生成")',
        'button:has-text("Stop generating")',
      ]
      for (const selector of stopSelectors) {
        const locator = this.page.locator(selector).first()
        if (await locator.count().catch(() => 0) > 0) {
          await locator.click({ timeout: 5_000 }).catch(() => undefined)
          return
        }
      }
    })
  }

  async composerLocator() {
    const selectors = [
      '#chat-input',
      'textarea[placeholder*="给 DeepSeek"]',
      'textarea[placeholder*="发送消息"]',
      'textarea[placeholder*="Send a message"]',
      'textarea',
    ]
    for (const selector of selectors) {
      const locator = this.page.locator(selector).first()
      if (await locator.count().catch(() => 0) > 0) return locator
    }
    return this.page.locator('textarea').first()
  }

  send(text, wait = false) {
    this.touch()
    return this.queue.run(() => this.sendImpl(text, wait))
  }

  async sendImpl(text, wait) {
    this.setLastError(undefined)
    if (this.page === undefined) {
      try {
        await this.ensureBrowser()
      } catch (error) {
        const message = String(error)
        this.setLastError(message, 'NETWORK')
        return { ok: false, error: message, code: 'NETWORK' }
      }
    }
    const loggedIn = await this.isLoggedIn()
    if (loggedIn !== true) {
      const message = '尚未登录 DeepSeek 网页端。请在插件面板点击「打开登录窗口」，在弹出的浏览器中完成登录后重试。'
      this.setLastError(message, 'NEED_LOGIN')
      return { ok: false, error: message, code: 'NEED_LOGIN' }
    }
    try {
      const chat = this.store.ensureActiveChat(this.deepThink ? 'deepseek-reasoner' : 'deepseek-chat')
      const userMessage = { id: randomUUID(), role: 'user', content: text, ts: Date.now() }
      this.store.appendMessage(chat.id, userMessage)
      if (chat.title === '新的对话') {
        this.store.renameChat(chat.id, text.replace(/\s+/g, ' ').slice(0, 40))
      }

      const page = this.page
      if (page === undefined) return { ok: false, error: '浏览器未启动' }
      const composer = await this.composerLocator()
      await composer.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined)
      await composer.click({ timeout: 5_000 }).catch(() => undefined)
      await composer.fill(text, { timeout: 10_000 }).catch(async () => {
        await composer.type(text, { delay: 5 })
      })
      await page.evaluate(() => {
        const w = window
        w.__wcStream = { text: '', done: false, started: false, status: 0, error: '' }
      }).catch(() => undefined)
      await page.keyboard.press('Enter')

      const assistantId = randomUUID()
      if (!wait) {
        void this.streamReply(chat.id, assistantId)
        return { ok: true, chatId: chat.id }
      }
      const result = await this.streamReply(chat.id, assistantId)
      return result
    } catch (error) {
      const message = `发送失败：${String(error)}`
      this.setLastError(message)
      return { ok: false, error: message }
    }
  }

  async streamReply(chatId, assistantId) {
    if (this.page === undefined) return { ok: false, error: '浏览器未启动' }
    this.busy = true
    const started = Date.now()
    const timeout = this.config.replyTimeoutMs ?? DEFAULT_TIMEOUT_MS
    let replyMarkdown = ''
    let replyError
    let replyCode
    let domStable = 0
    let lastDom = ''

    const readCapture = async () => {
      if (this.page === undefined) return null
      return this.page.evaluate(() => {
        const w = window
        return w.__wcStream ?? null
      }).catch(() => null)
    }

    const domSnapshot = async () => {
      const scraped = await this.scrapeConversation()
      const assistant = [...scraped].reverse().find((message) => message.role === 'assistant')
      if (assistant === undefined) return { markdown: '' }
      const think = stripSearchTrace(assistant.parts.filter((part) => part.kind === 'think').map((part) => part.text).join('\n\n')).trim()
      const bodyHtml = assistant.parts.find((part) => part.kind === 'body')?.markdown ?? ''
      const bodyMd = bodyHtml === '' ? '' : stripSearchTrace(serializeToMarkdown(parseMarkup(bodyHtml)))
      const thinkMd = think === '' ? '' : `<details><summary>思考过程</summary>\n\n${think}\n\n</details>`
      return { markdown: [thinkMd, bodyMd].filter(Boolean).join('\n\n') }
    }

    try {
      await this.page.waitForTimeout(700)
      let captureSeen = false
      let captureCompleted = false
      while (Date.now() - started < timeout) {
        const capture = await readCapture()
        if (capture !== null && capture.started) {
          captureSeen = true
          const parsed = parseStreamReply(capture.text)
          if (parsed.markdown !== '' && parsed.markdown.length >= replyMarkdown.length) {
            replyMarkdown = parsed.markdown
            this.store.upsertMessage(chatId, {
              id: assistantId, role: 'assistant', content: replyMarkdown, ts: Date.now(),
              streaming: !(capture.done || parsed.finished),
            })
          }
          if (capture.done || parsed.finished) {
            captureCompleted = true
            break
          }
          if (capture.error !== '') {
            replyError = capture.error
            replyCode = 'NETWORK'
            break
          }
        } else {
          const dom = await domSnapshot()
          if (dom.markdown !== '') {
            if (dom.markdown !== lastDom) {
              lastDom = dom.markdown
              domStable = 0
              // The page renders long answers in a virtualised list, so a DOM
              // scrape can return only the part still mounted — that is how a
              // reply ended up starting mid-sentence. A shorter snapshot never
              // replaces text we already hold.
              if (dom.markdown.length >= replyMarkdown.length) replyMarkdown = dom.markdown
            } else {
              domStable += 1
            }
            this.store.upsertMessage(chatId, {
              id: assistantId, role: 'assistant', content: replyMarkdown, ts: Date.now(), streaming: true,
            })
          }
          if (replyMarkdown !== '' && domStable >= 3) break
        }
        await this.page.waitForTimeout(350)
      }
      if (replyMarkdown === '' && replyCode === undefined) {
        if (captureSeen && captureCompleted) {
          replyError = '页面协议疑似改版：已捕获到回复流但无法解析出内容，请升级 dsh-deepseek-chat 插件'
          replyCode = 'PAGE_CHANGED'
        } else {
          replyError = '等待回复超时（未捕获到网页回复流；可能未登录或页面结构已变化）'
          replyCode = 'TIMEOUT'
        }
      } else if (replyCode === undefined && Date.now() - started >= timeout) {
        replyError = '生成超时，已返回部分内容'
        replyCode = 'TIMEOUT'
      }
      this.store.upsertMessage(chatId, {
        id: assistantId, role: 'assistant', content: replyMarkdown, ts: Date.now(),
        streaming: false, error: replyError,
      })
      this.store.setStreaming(chatId, false)
      if (replyError !== undefined) this.setLastError(replyError, replyCode)
      return { ok: replyError === undefined, chatId, reply: replyMarkdown, error: replyError, code: replyCode }
    } catch (error) {
      const message = `生成过程中断：${String(error)}`
      this.setLastError(message)
      this.store.upsertMessage(chatId, {
        id: assistantId, role: 'assistant', content: replyMarkdown, ts: Date.now(),
        streaming: false, error: message,
      })
      this.store.setStreaming(chatId, false)
      return { ok: false, chatId, reply: replyMarkdown, error: message }
    } finally {
      this.busy = false
      this.touch()
    }
  }

  async newChat() {
    if (this.busy) return { ok: false, error: '正在生成回复，请先停止或等待完成' }
    this.touch()
    return this.queue.run(async () => {
      try {
        await this.ensureBrowser()
        const chat = this.store.createChat(this.deepThink ? 'deepseek-reasoner' : 'deepseek-chat')
        if (this.page !== undefined) {
          const clickSelectors = ['button:has-text("新对话")', 'button:has-text("New chat")', '[class*="newChat"]']
          let clicked = false
          for (const selector of clickSelectors) {
            const locator = this.page.locator(selector).first()
            if (await locator.count().catch(() => 0) > 0) {
              await locator.click({ timeout: 5_000 }).catch(() => undefined)
              clicked = true
              break
            }
          }
          if (!clicked) await this.openDeepSeekPage()
          await this.page.waitForTimeout(1_500)
        }
        return { ok: true, chatId: chat.id }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })
  }

  async clickToggle(labels) {
    if (!this.isPageAlive()) return false
    const selectors = []
    for (const label of labels) {
      selectors.push(
        `div.ds-toggle-button:has-text("${label}")`,
        `[aria-pressed]:has-text("${label}")`,
        `button:has-text("${label}")`,
        `[aria-label*="${label}"]`,
      )
    }
    for (const selector of selectors) {
      const locator = this.page.locator(selector).first()
      if (await locator.count().catch(() => 0) > 0) {
        await locator.click({ timeout: 5_000 }).catch(() => undefined)
        return true
      }
    }
    return false
  }

  async setDeepThink(enabled) {
    if (this.busy) return { ok: false, error: '正在生成回复，请先等待完成' }
    this.touch()
    return this.queue.run(async () => {
      try {
        await this.ensureBrowser()
        const current = await this.readToggles()
        if (current.deepThink !== enabled) {
          await this.clickToggle(['深度思考', 'DeepThink', 'Deep Think'])
        }
        this.deepThink = enabled
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })
  }

  async setSearch(enabled) {
    if (this.busy) return { ok: false, error: '正在生成回复，请先等待完成' }
    this.touch()
    return this.queue.run(async () => {
      try {
        await this.ensureBrowser()
        const current = await this.readToggles()
        if (current.search !== enabled) {
          await this.clickToggle(['智能搜索', '联网搜索', 'Search'])
        }
        this.search = enabled
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })
  }

  async disposeBrowser() {
    this.stopIdleTimer()
    try {
      await this.context?.close()
    } catch {
      // already closed
    }
    this.context = undefined
    this.page = undefined
    this.loginMode = false
    if (this.state !== 'error') this.setState('stopped')
  }

  /**
   * Snapshot for the panel's poll. IMPORTANT: this is a pure read — it never
   * launches or relaunches the browser. The browser is started lazily by an
   * explicit user action (open panel / send / login / toggle / pull history),
   * so the idle-close timer can actually keep it closed. When the browser is
   * not up, page-derived fields fall back to cached values instead of touching
   * a dead page.
   */
  async status() {
    const alive = this.isPageAlive()
    let loggedIn
    if (alive) {
      loggedIn = await this.isLoggedIn()
      if (loggedIn === true) this.setLoggedIn(true)
      else if (loggedIn === false) this.setLoggedIn(false)
      else if (loggedIn === null && this.loggedInOnce) loggedIn = true
      // Reading toggles queries the page; only do it while the browser is up.
      const toggles = await this.readToggles()
      this.deepThink = toggles.deepThink
      this.search = toggles.search
    } else {
      // Browser closed/idle: report cached login state, no page access.
      loggedIn = this.loggedInOnce ? true : null
    }
    return {
      engine: this.state,
      engineError: this.engineError,
      loggedIn,
      pageUrl: alive ? this.pageUrl() : undefined,
      deepThink: this.deepThink,
      search: this.search,
      busy: this.busy,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
    }
  }
}

/**
 * Minimal HTML fragment parser used to round-trip scraped `.ds-markdown`
 * innerHTML through htmlToMarkdown.
 */
export function parseMarkup(html) {
  return new MarkupParser(html).parse()
}

/** Tiny HTML tokenizer → light DOM graph (sufficient for DeepSeek's markdown HTML). */
class MarkupParser {
  constructor(html) {
    this.tokens = html.split(/(<[^>]+>)/).filter((token) => token !== '')
    this.index = 0
  }

  parse() {
    return this.parseChildren(undefined)
  }

  parseChildren(parent) {
    const node = { nodeType: 1, children: [], attributes: {}, parent }
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index]
      if (!token.startsWith('<')) {
        node.children.push({ nodeType: 3, textContent: token, children: [], attributes: {}, parent: node })
        this.index++
        continue
      }
      const close = /^<\/([a-zA-Z0-9]+)>$/.exec(token)
      if (close !== null) {
        this.index++
        if (close[1].toLowerCase() === (node.tagName ?? '').toLowerCase()) return node
        continue
      }
      const open = /^<([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*(\/?)>$/.exec(token)
      if (open === null) {
        this.index++
        continue
      }
      const [, rawTag, attrsRaw] = open
      const tag = rawTag.toLowerCase()
      const attributes = {}
      if (attrsRaw !== undefined) {
        const attrRe = /([a-zA-Z0-9-]+)(?:=("[^"]*"|'[^']*'|[^\s>]*))?/g
        let match
        while ((match = attrRe.exec(attrsRaw)) !== null) {
          const value = match[2] === undefined ? undefined : match[2].replace(/^["']|["']$/g, '')
          attributes[match[1]] = value
        }
      }
      this.index++
      const element = { tagName: tag, nodeType: 1, children: [], attributes, parent }
      if (!open[3].endsWith('/')) {
        const child = this.parseChildren(element)
        for (const grandchild of child.children) element.children.push(grandchild)
      }
      node.children.push(element)
    }
    return node
  }
}

/** Convert a scraped markdown-HTML string to markdown (used by send). */
export function scrapedHtmlToMarkdown(html) {
  return serializeToMarkdown(parseMarkup(html))
}