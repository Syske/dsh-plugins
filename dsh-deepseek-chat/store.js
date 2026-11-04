/**
 * Local transcript store for dsh-deepseek-chat. Chats persist as one JSON file
 * under the plugin data dir (~/.dsh/dsh-deepseek-chat/transcripts.json by
 * default) so web conversations survive restarts. Atomic writes (tmp + rename)
 * keep a crash from corrupting history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Resolve the dsh home base directory (the one that *contains* profiles/).
 * `DSH_HOME` already points at `~/.dsh`, so use it directly; otherwise derive
 * `$HOME/.dsh`. (Naively appending `.dsh` to `DSH_HOME` would double it.)
 */
export function dshHomeBase() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const home = process.env.HOME ?? '.'
  return join(home, '.dsh')
}

/** Default plugin data directory. */
export function defaultDataDir() {
  const base = dshHomeBase()
  const primary = join(base, 'dsh-deepseek-chat')
  // Backward compatibility: an earlier build stored data under `ds-chat`; keep
  // using it when it already exists so an existing login profile is preserved.
  const legacy = join(base, 'ds-chat')
  if (!existsSync(primary) && existsSync(legacy)) return legacy
  return primary
}

/**
 * JSON-file transcript store. All mutations are synchronous and persisted
 * immediately; the engine and routes share a single instance.
 */
export class TranscriptStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir ?? defaultDataDir()
    this.file = join(this.dataDir, 'transcripts.json')
    const loaded = this.read()
    this.chats = loaded.chats
    this.activeChatId = loaded.activeChatId
    if (this.activeChatId !== undefined && !this.chats.some((chat) => chat.id === this.activeChatId)) {
      this.activeChatId = this.chats.at(-1)?.id
    }
  }

  read() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const chats = Array.isArray(parsed.chats) ? parsed.chats : []
      return {
        version: 1,
        activeChatId: typeof parsed.activeChatId === 'string' ? parsed.activeChatId : undefined,
        chats: chats.filter((chat) => typeof chat?.id === 'string' && Array.isArray(chat.messages)),
      }
    } catch {
      return { version: 1, chats: [] }
    }
  }

  persist() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const payload = { version: 1, activeChatId: this.activeChatId, chats: this.chats }
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** Create a fresh chat and make it active. */
  createChat(model) {
    const now = Date.now()
    const chat = {
      id: `chat-${now.toString(36)}-${randomUUID().slice(0, 6)}`,
      title: '新的对话',
      createdAt: now,
      updatedAt: now,
      model,
      messages: [],
      streaming: false,
    }
    this.chats.push(chat)
    this.activeChatId = chat.id
    this.persist()
    return chat
  }

  /** Get the active chat, or create one. */
  ensureActiveChat(model) {
    const existing = this.activeChatId !== undefined
      ? this.chats.find((chat) => chat.id === this.activeChatId)
      : undefined
    if (existing !== undefined && existing.model === model) return existing
    const fresh = this.createChat(model)
    return fresh
  }

  /** Get a chat by id. */
  getChat(id) {
    return this.chats.find((chat) => chat.id === id)
  }

  /** The current active chat, or undefined. */
  activeChat() {
    return this.activeChatId === undefined ? undefined : this.getChat(this.activeChatId)
  }

  appendMessage(chatId, message) {
    const chat = this.getChat(chatId)
    if (chat === undefined) return undefined
    chat.messages.push(message)
    chat.updatedAt = Date.now()
    chat.streaming = message.role === 'assistant'
    if (message.role === 'user') chat.streaming = false
    this.persist()
    return chat
  }

  /** Insert or update a message (used while streaming assistant replies). */
  upsertMessage(chatId, message) {
    const chat = this.getChat(chatId)
    if (chat === undefined) return undefined
    const idx = chat.messages.findIndex((m) => m.id === message.id)
    if (idx === -1) chat.messages.push(message)
    else chat.messages[idx] = { ...chat.messages[idx], ...message }
    chat.updatedAt = Date.now()
    this.persist()
    return chat
  }

  renameChat(chatId, title) {
    const chat = this.getChat(chatId)
    if (chat === undefined) return undefined
    chat.title = title
    chat.updatedAt = Date.now()
    this.persist()
    return chat
  }

  /** Local transcript titles (for matching against the web sidebar). */
  titles() {
    return this.chats.map((chat) => chat.title)
  }

  /** Web session ids already imported locally (for "is this web chat synced?"). */
  webIds() {
    return this.chats.map((chat) => chat.webId).filter((v) => typeof v === 'string' && v !== '')
  }

  /**
   * Import (or refresh) a recovered web conversation as a local transcript.
   * Matches by web session id first (precise), then by exact title. An existing
   * chat is refreshed in place (messages replaced) so re-syncing repairs stale /
   * truncated history; otherwise a new chat is created.
   * @returns {{ chat: object, created: boolean, updated: boolean }}
   */
  importTranscript({ title, model, messages, webId }) {
    const cleanTitle = String(title ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || '新的对话'
    let existing
    if (typeof webId === 'string' && webId !== '') {
      existing = this.chats.find((chat) => chat.webId === webId)
    }
    if (existing === undefined) {
      existing = this.chats.find((chat) => chat.title === cleanTitle)
    }
    if (existing !== undefined) {
      existing.messages = messages
      existing.model = model
      existing.updatedAt = Date.now()
      existing.streaming = false
      if (typeof webId === 'string' && webId !== '') existing.webId = webId
      this.activeChatId = existing.id
      this.persist()
      return { chat: existing, created: false, updated: true }
    }
    const now = Date.now()
    const chat = {
      id: `chat-${now.toString(36)}-${randomUUID().slice(0, 6)}`,
      title: cleanTitle,
      createdAt: now,
      updatedAt: now,
      model,
      messages,
      streaming: false,
      ...(typeof webId === 'string' && webId !== '' ? { webId } : {}),
    }
    this.chats.unshift(chat)
    this.activeChatId = chat.id
    this.persist()
    return { chat, created: true, updated: false }
  }

  deleteChat(chatId) {
    const idx = this.chats.findIndex((chat) => chat.id === chatId)
    if (idx === -1) return false
    this.chats.splice(idx, 1)
    if (this.activeChatId === chatId) {
      this.activeChatId = this.chats.at(-1)?.id
    }
    this.persist()
    return true
  }

  setStreaming(chatId, streaming) {
    const chat = this.getChat(chatId)
    if (chat === undefined) return
    chat.streaming = streaming
    this.persist()
  }

  list() {
    return this.chats
  }
}