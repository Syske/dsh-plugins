# dsh-deepseek-chat

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that brings
[chat.deepseek.com](https://chat.deepseek.com) into the Web GUI as a native chat panel.

It adds a **"DeepSeek Web Chat"** entry to the sidebar. Opening it shows a chat panel in
the center column that drives the real `chat.deepseek.com` web app through a **real
browser** (`playwright-core`), reusing your existing DeepSeek **web login session** —
**no API key, no token billing** — ideal for everyday Q&A.

> **Why a real browser instead of an iframe?** `chat.deepseek.com` responds with
> `content-security-policy: frame-ancestors 'none'`, which forbids being embedded in any
> iframe. So this plugin launches a local Chromium via `playwright-core` and drives the
> page directly, reusing your web login.

## Features

- **Web chat over your DeepSeek web session** — no API key, no billing. Streaming replies,
  with "Deep Think" (R1 reasoning) and "Web Search" toggles.
- **Pull conversation history** — import any of your existing chat.deepseek.com
  conversations into the panel, **complete and untruncated** (read via DeepSeek's own
  history API, not DOM scraping). Re-import to **refresh / repair** a stale conversation.
- **Native UI integration** — registers into the built-in `sidebar.panellist` and `main`
  slots; follows the host theme (light/dark) and locale (zh/en) via theme tokens and the
  locale service.
- **Idle auto-close** — the heavy Chromium is closed after inactivity (default 5 min) to free memory; it wakes automatically on the next message. Configure with `idleTimeoutMs`.
- **Loopback-only** HTTP surface — the `/api/dsh-deepseek-chat/*` routes are bound to
  loopback for safety.

## Architecture

- **Host half** (`index.js` + `engine/`, `store.js`, `routes.js`) — runs in the Node host.
  - `engine/engine.js` — drives chat.deepseek.com with playwright; injects a script that
    tees the page's own SSE stream (`/api/v0/chat/completion`) to capture full replies
    (including R1 thinking), with a DOM-scrape fallback. History import calls
    `/api/v0/chat/history_messages` in-page with the page's `userToken`.
  - `store.js` — local transcript store (`~/.dsh/dsh-deepseek-chat/transcripts.json`).
  - `routes.js` — `/api/dsh-deepseek-chat/*` HTTP routes (state / open-login /
    close-browser / new-chat / send / stop / deep-think / search / rename / delete /
    web-chats / recover).
- **Client half** (`client.js`) — runs in the Web GUI. Registers a `sidebar.panellist`
  icon and a `main` panel (key `dsh-deepseek-chat`), polls `/api/dsh-deepseek-chat/state`,
  and renders the chat UI with host theme tokens (`--dsw-alias-*`).

## Getting started

1. Click the **"DeepSeek Web Chat"** icon in the sidebar to open the panel.
2. Click **"Open login window"** — a **visible browser window** appears; sign in to
   chat.deepseek.com there (phone / password / QR are all supported).
3. The window auto-closes after login; chatting then runs headless. Ask away.

## Pulling conversation history

After login, the **"Pull history"** button lists all of your existing chat.deepseek.com
conversations. Click any one to import it:

- **Complete & untruncated** — import reads DeepSeek's own history API
  `GET /api/v0/chat/history_messages?chat_session_id=<id>` in-page (Bearer = the page's
  `userToken`, and **without cache params** to get the full transcript). Long conversations
  are not cut off (DOM-scrape was truncating them; it remains only as a fallback).
- **Dedup / refresh** — matched by web session id (`webId`) first, title second. The list
  shows **all** web conversations: unimported → "Import", imported → "Imported · Refresh".
  Clicking an imported one **overwrites it in place with the latest full content** (no
  duplicate) — use this to repair a previously truncated/incomplete conversation.

## Configuration (optional, per-row `config` in your profile's `cordis.patch.yml`)

| Key | Default | Description |
| --- | --- | --- |
| `browserChannel` | `auto` | Browser channel: `chrome` / `msedge` / `chromium` / `auto` |
| `browserExecutablePath` | `''` | Explicit browser executable path |
| `browserProxy` | `direct` | `direct` / `system` / `http://host:port` |
| `browserHeadless` | `true` | Headless while chatting (login window is always visible) |
| `replyTimeoutMs` | `180000` | Max wait for a reply (ms) |
| `dataDir` | `~/.dsh/dsh-deepseek-chat` | Data dir (browser profile + transcripts) |
| `idleTimeoutMs` | `300000` | Auto-close the browser after this many ms idle to free memory (`0` = keep open) |

## Requirements

- Node.js >= 22
- A Chromium-family browser. `playwright-core` can use your system Chrome/Edge/Chromium,
  or a playwright-managed Chromium. Discovery order: `browserExecutablePath` →
  `browserChannel` → a downloaded Chromium under `PLAYWRIGHT_BROWSERS_PATH` / the usual
  caches → system Chrome/Edge paths.
- A graphical session for the one-time login window.

## Install / uninstall

```bash
# Install this directory as a bundle into the web profile:
dsh plugin --profile web add /path/to/dsh-deepseek-chat
# or, in a session, use plugin_manager install_bundle with this directory as target
```

Uninstall: `plugin_manager remove_bundle` with target `dsh-deepseek-chat`.

## Known limitations

- The web app is subject to DeepSeek's own risk controls; page changes or failed actions
  return errors rather than crashing.
- Login credentials live in a local private profile directory — do not leak it.
- Host-half JS changes require restarting the Harness; client-half (`client.js`) changes
  hot-reload via HMR.

## License

[Apache-2.0](./LICENSE). Engine approach inspired by and partly adapted from
[dsh-web-chat](https://github.com/xmuwenxiang/dsh-web-chat) (Apache-2.0), rewritten and
trimmed for the basic chat + history-import capability.
