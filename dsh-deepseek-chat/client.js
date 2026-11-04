/**
 * dsh-deepseek-chat — browser half. Runs inside the dsh web GUI.
 *
 * Registers the locale dictionaries and mounts two slot occupants through the
 * native slot system:
 *  - `sidebar.panellist` (id = PANEL_ID): the sidebar icon/entry.
 *  - `main` (key = PANEL_ID): the central chat panel.
 *
 * The panel polls /api/dsh-deepseek-chat/state (served by the host half) and drives the
 * real chat.deepseek.com browser through that HTTP surface. Failure policy: a
 * mount/render problem is logged, never thrown — a plugin must not take the GUI
 * down.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'dsh-deepseek-chat'
    const NS = 'dsh-deepseek-chat'
    const API = {
      state: '/api/dsh-deepseek-chat/state',
      openLogin: '/api/dsh-deepseek-chat/open-login',
      closeBrowser: '/api/dsh-deepseek-chat/close-browser',
      newChat: '/api/dsh-deepseek-chat/new-chat',
      send: '/api/dsh-deepseek-chat/send',
      stop: '/api/dsh-deepseek-chat/stop',
      deepThink: '/api/dsh-deepseek-chat/deep-think',
      search: '/api/dsh-deepseek-chat/search',
      webChats: '/api/dsh-deepseek-chat/web-chats',
      recover: '/api/dsh-deepseek-chat/recover',
    }

    const zh = {
      'meta.title': 'DeepSeek 网页聊天',
      'meta.description': '打开 DeepSeek 网页聊天面板，复用网页登录会话。',
      'panel.title': 'DeepSeek 网页聊天',
      'panel.openLogin': '打开登录窗口', 'panel.closeBrowser': '关闭浏览器',
      'panel.newChat': '新对话', 'panel.send': '发送', 'panel.stop': '停止',
      'panel.placeholder': '输入消息，Enter 发送', 'panel.notLoggedIn': '请先打开登录窗口完成 DeepSeek 网页登录',
      'panel.busy': '正在生成回复…', 'panel.hint': 'Enter 发送 · Shift+Enter 换行',
      'panel.statusLoggedIn': '已登录', 'panel.statusNotLoggedIn': '未登录', 'panel.statusLaunching': '浏览器启动中…',
      'panel.statusError': '引擎错误', 'panel.statusUnknown': '状态未知', 'panel.statusIdle': '已登录 · 空闲（下次提问自动唤醒）',
      'panel.deepThink': '深度思考', 'panel.search': '智能搜索', 'panel.roleYou': '你', 'panel.thinking': '思考过程',
      'panel.emptyTitle': '开始新的 DeepSeek 对话', 'panel.emptyBody': '在下方输入你的问题，回复通过你的 DeepSeek 网页会话生成。',
      'panel.streaming': '生成中', 'panel.noChats': '暂无对话',
      'panel.pullHistory': '拉取历史', 'panel.recoverHint': '从网页端拉取已有会话到本地',
      'panel.recoverEmpty': '网页端暂无未拉取的会话', 'panel.recovering': '拉取中…',
      'panel.recoverDone': '已拉取「{title}」（{count} 条消息）', 'panel.recoverFailed': '拉取失败：{error}',
      'panel.recoverRefreshed': '已刷新「{title}」（{count} 条消息）',
      'panel.recoverNewBadge': '导入', 'panel.recoverRefreshBadge': '已导入 · 刷新',
    }
    const en = {
      'meta.title': 'DeepSeek Web Chat',
      'meta.description': 'Open a DeepSeek web chat panel reusing your web login.',
      'panel.title': 'DeepSeek Web Chat',
      'panel.openLogin': 'Open login window', 'panel.closeBrowser': 'Close browser',
      'panel.newChat': 'New chat', 'panel.send': 'Send', 'panel.stop': 'Stop',
      'panel.placeholder': 'Type a message, Enter to send', 'panel.notLoggedIn': 'Open the login window and sign in to DeepSeek first',
      'panel.busy': 'Generating…', 'panel.hint': 'Enter to send · Shift+Enter for newline',
      'panel.statusLoggedIn': 'Signed in', 'panel.statusNotLoggedIn': 'Not signed in', 'panel.statusLaunching': 'Starting browser…',
      'panel.statusError': 'Engine error', 'panel.statusUnknown': 'Unknown', 'panel.statusIdle': 'Signed in · idle (auto-wakes on next message)',
      'panel.deepThink': 'Deep Think', 'panel.search': 'Web Search', 'panel.roleYou': 'You', 'panel.thinking': 'Thinking',
      'panel.emptyTitle': 'Start a new DeepSeek conversation', 'panel.emptyBody': 'Type your question below; replies are generated through your DeepSeek web session.',
      'panel.streaming': 'Thinking', 'panel.noChats': 'No conversations',
      'panel.pullHistory': 'Pull history', 'panel.recoverHint': 'Import existing web conversations into local',
      'panel.recoverEmpty': 'No new conversations on the web side', 'panel.recovering': 'Importing…',
      'panel.recoverDone': 'Imported "{title}" ({count} messages)', 'panel.recoverFailed': 'Import failed: {error}',
      'panel.recoverRefreshed': 'Refreshed "{title}" ({count} messages)',
      'panel.recoverNewBadge': 'Import', 'panel.recoverRefreshBadge': 'Imported · Refresh',
    }

    /** Interpolate {placeholder}s in a localized template. */
    function fmt(template, values) {
      return String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => (key in values ? String(values[key]) : '{' + key + '}'))
    }

    async function request(path, body) {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok && payload.ok !== true) {
        return { ...payload, ok: false, error: payload.error ?? `HTTP ${response.status}` }
      }
      return payload
    }

    // --- tiny markdown renderer -------------------------------------------------
    // Handles fenced code, headings, lists, blockquotes, <details> (R1 thinking)
    // blocks, inline code, bold/italic, links. Plain text otherwise.
    function fallbackCopy(text, done) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        done()
      } catch { /* ignore */ }
    }

    // --- lightweight syntax highlighting ---------------------------------------
    // A single-pass tokenizer over each line: comments, strings, numbers,
    // keywords and punctuation, with type/function names recognised from the
    // context instead of a per-language grammar. Token kinds map to the
    // `ddc-tok-*` classes in STYLE, which flip with the host light/dark theme.
    const HL_KEYWORDS = {
      js: 'const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|import|export|from|as|async|await|yield|try|catch|finally|throw|typeof|instanceof|in|of|this|super|null|undefined|true|false|void|delete|static|get|set',
      ts: 'const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|implements|interface|type|enum|namespace|declare|public|private|protected|readonly|import|export|from|as|async|await|yield|try|catch|finally|throw|typeof|keyof|infer|is|in|of|this|super|null|undefined|true|false|void|delete|static|get|set|satisfies',
      py: 'def|return|if|elif|else|for|while|break|continue|pass|import|from|as|class|try|except|finally|raise|with|lambda|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self',
      go: 'package|import|func|return|if|else|for|range|switch|case|default|break|continue|go|defer|chan|select|type|struct|interface|map|var|const|nil|true|false|make|new|len|cap|append|panic|recover',
      rust: 'fn|let|mut|const|static|return|if|else|match|for|while|loop|break|continue|struct|enum|impl|trait|use|mod|pub|crate|self|Self|super|as|where|move|ref|async|await|dyn|unsafe|true|false|Some|None|Ok|Err',
      java: 'public|private|protected|class|interface|enum|extends|implements|static|final|void|int|long|double|float|boolean|char|byte|short|return|if|else|for|while|do|switch|case|default|break|continue|new|this|super|try|catch|finally|throw|throws|null|true|false|import|package|abstract|synchronized|volatile|transient|instanceof',
      bash: 'if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|readonly|source|echo|cd|ls|cat|grep|sed|awk|curl|git|npm|pnpm|node|python|pip|docker|sudo|chmod|mkdir|rm|cp|mv|touch|set|unset|exit|true|false',
    }
    const HL_ALIAS = { javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', typescript: 'ts', tsx: 'ts', python: 'py', python3: 'py', golang: 'go', rs: 'rust', shell: 'bash', sh: 'bash', zsh: 'bash', console: 'bash', json: 'js', yml: 'yaml' }
    const HL_COMMON = 'if|else|for|while|return|function|class|def|func|import|export|from|new|const|let|var|in|of|not|and|or'

    // Languages whose line comment is '#'; everything else uses '//' so a
    // '#' inside JS/CSS (a hex colour, a private field) is not swallowed.
    const HL_HASH_COMMENT = { py: 1, bash: 1, yaml: 1, ruby: 1, perl: 1, r: 1 }

    function hlTokens(code, lang) {
      const key = HL_ALIAS[lang] || lang
      const kw = new Set(((HL_KEYWORDS[key] || HL_COMMON).split('|')))
      const commentPat = HL_HASH_COMMENT[key] ? '#[^\\n]*' : '\\/\\/[^\\n]*'
      // Bracket construction, not a literal: keeps quotes and backslashes readable.
      const SQ = String.fromCharCode(39)
      const Q = String.fromCharCode(34)
      const BT = String.fromCharCode(96)
      const re = new RegExp('(' + commentPat + '|\\/\\*[\\s\\S]*?\\*\\/)' +
        '|(' + SQ + '[^' + SQ + '\\\\]*(?:\\\\.[^' + SQ + '\\\\]*)*' + SQ +
        '|' + Q + '[^' + Q + '\\\\]*(?:\\\\.[^' + Q + '\\\\]*)*' + Q +
        '|' + BT + '[^' + BT + '\\\\]*(?:\\\\.[^' + BT + '\\\\]*)*' + BT + ')' +
        '|\\b(0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b' +
        '|([A-Za-z_$0-9][\\w$]*)' +
        '|(\\s+)' +
        '|([^\\s\\w$])' +
        '|([\\s\\S])', 'g')
      const out = []
      let m
      while ((m = re.exec(code)) !== null) {
        const [tok, comment, str, num, ident, space, punct, any] = m
        if (comment !== undefined) out.push({ t: 'com', v: tok })
        else if (str !== undefined) out.push({ t: 'str', v: tok })
        else if (num !== undefined) out.push({ t: 'num', v: tok })
        else if (ident !== undefined) {
          const after = code.slice(re.lastIndex).match(/^\s*\(/)
          out.push({ t: kw.has(ident) ? 'kw' : /^[A-Z]/.test(ident) ? 'type' : after ? 'fn' : 'txt', v: ident })
        } else if (space !== undefined || any !== undefined) out.push({ t: 'txt', v: tok })
        else out.push({ t: 'pun', v: tok })
      }
      return out
    }

    function highlight(code, lang) {
      let i = 0
      return hlTokens(code, String(lang || '').trim().toLowerCase()).map((tk) => {
        if (tk.t === 'txt') return tk.v
        return h('span', { key: 't' + (i++), className: 'ddc-tok-' + tk.t }, tk.v)
      })
    }

    // Code block with a language label and a one-click copy button.
    function CodeBlock(props) {
      const [copied, setCopied] = React.useState(false)
      const code = String(props.code ?? '')
      const lang = String(props.lang ?? '').trim()
      const onCopy = () => {
        const done = () => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done))
        } else {
          fallbackCopy(code, done)
        }
      }
      return h('div', { className: 'ddc-codeblock' },
        h('div', { className: 'ddc-codehead' },
          h('span', { className: 'ddc-codelang' }, lang || 'text'),
          h('button', {
            className: 'ddc-copy',
            type: 'button',
            'data-copied': copied ? 'true' : undefined,
            title: 'Copy',
            onClick: onCopy,
          }, copied ? '✓' : '⧉')),
        h('pre', { className: 'ddc-codepre' }, h('code', { className: 'ddc-code-' + ((HL_ALIAS[lang.toLowerCase()] || lang.toLowerCase()).replace(/[^a-z0-9-]/g, '') || 'text') }, highlight(code, lang))))
    }

    function renderInline(text, keyBase) {
      const nodes = []
      let i = 0
      let key = 0
      const push = (node) => { nodes.push(node) }
      const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
      let last = 0
      let m
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) push(text.slice(last, m.index))
        const tok = m[0]
        if (tok.startsWith('`')) push(h('code', { key: keyBase + 'c' + (key++) }, tok.slice(1, -1)))
        else if (tok.startsWith('**')) push(h('strong', { key: keyBase + 'b' + (key++) }, tok.slice(2, -2)))
        else if (tok.startsWith('*')) push(h('em', { key: keyBase + 'i' + (key++) }, tok.slice(1, -1)))
        else {
          const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
          if (lm) push(h('a', { key: keyBase + 'a' + (key++), href: lm[2], target: '_blank', rel: 'noreferrer' }, lm[1]))
          else push(tok)
        }
        last = m.index + tok.length
      }
      if (last < text.length) push(text.slice(last))
      return nodes
    }

    /** Split a pipe-table row into trimmed cells, honouring "\|" escapes. */
    function splitCells(row) {
      let s = String(row).trim()
      if (s.startsWith('|')) s = s.slice(1)
      if (s.endsWith('|')) s = s.slice(0, -1)
      const cells = []
      let cur = ''
      for (let p = 0; p < s.length; p++) {
        const ch = s[p]
        if (ch === '\\' && s[p + 1] === '|') { cur += '|'; p++; continue }
        if (ch === '|') { cells.push(cur); cur = ''; continue }
        cur += ch
      }
      cells.push(cur)
      return cells.map((c) => c.trim())
    }

    /** True for a GFM table delimiter row, e.g. `| --- | :--: |`. */
    function isDelimRow(line) {
      if (typeof line !== 'string' || !line.includes('-')) return false
      const cells = splitCells(line)
      return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c))
    }

    function isTableStart(lines, i) {
      if (i + 1 >= lines.length || !String(lines[i]).includes('|') || !isDelimRow(lines[i + 1])) return false
      // GFM requires the header and delimiter rows to have the same column count.
      return splitCells(lines[i]).length === splitCells(lines[i + 1]).length
    }

    function renderMarkdown(source, opts) {
      opts = opts || {}
      const lines = String(source ?? '').split('\n')
      const blocks = []
      let key = 0
      const nk = () => 'k' + (key++)

      const isBlockStart = (i) => {
        const l = lines[i]
        return /^```/.test(l) || /^<details>/.test(l) || /^#{1,6}\s/.test(l) ||
          /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^\s*[-*]\s+/.test(l) ||
          /^\s*\d+[.)]\s+/.test(l) || /^\s*>\s?/.test(l) || isTableStart(lines, i)
      }

      // Recursive list parser: nesting depth, ordered/unordered, type changes.
      const parseList = (start, baseIndent) => {
        const ordered = /^\s*\d/.test(lines[start])
        const items = []
        let k = start
        while (k < lines.length) {
          const l = lines[k]
          const m = /^(\s*)[-*]\s+(.*)$/.exec(l) || /^(\s*)\d+[.)]\s+(.*)$/.exec(l)
          if (m === null) {
            // A blank line is kept only when another list line follows.
            if (l.trim() === '' && k + 1 < lines.length &&
              (/^\s*[-*]\s+/.test(lines[k + 1]) || /^\s*\d+[.)]\s+/.test(lines[k + 1]))) { k++; continue }
            break
          }
          const indent = m[1].replace(/\t/g, '    ').length
          const isOrdered = /^\s*\d/.test(l)
          if (indent < baseIndent) break
          if (indent === baseIndent && isOrdered !== ordered) break
          if (indent > baseIndent) {
            if (items.length === 0) break
            const sub = parseList(k, indent)
            if (sub === null) break
            items[items.length - 1].children.push(sub.node)
            k = sub.next
            continue
          }
          items.push({ text: m[2], children: [] })
          k++
        }
        const node = h(ordered ? 'ol' : 'ul', { key: nk() },
          items.map((it) => h('li', { key: nk() }, renderInline(it.text, 'il' + (key++)).concat(it.children))))
        return { node, next: k }
      }

      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        // fenced code
        const fence = /^```(.*)$/.exec(line)
        if (fence) {
          const lang = fence[1].trim()
          const codeLines = []
          i++
          while (i < lines.length && !/^```\s*$/.test(lines[i])) { codeLines.push(lines[i]); i++ }
          i++ // closing fence
          blocks.push(h(CodeBlock, { key: nk(), code: codeLines.join('\n'), lang }))
          continue
        }
        // <details> ... </details> block (R1 reasoning trace). Collapsed by
        // default; the first line of the inner content is usually the
        // "思考过程" heading which we lift into the summary label instead.
        if (/^<details>/.test(line)) {
          const inner = []
          i++
          while (i < lines.length && !/<\/details>/.test(lines[i])) { inner.push(lines[i]); i++ }
          i++
          // Drop a leading "思考过程" / "Thinking" title line (also when separated
          // from the body by blank lines) — it becomes the summary label instead.
          let s = 0
          while (s < inner.length && inner[s].trim() === '') s++
          const titleRe = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:思考过程|思考|Thinking(?: process)?)\s*(?:\*\*)?\s*$/i
          if (s < inner.length && titleRe.test(inner[s])) inner.splice(0, s + 1)
          blocks.push(h('details', { key: nk(), className: 'ddc-think' },
            h('summary', { className: 'ddc-think-summary' },
              h('span', { className: 'ddc-think-ico' }, '✧'),
              h('span', null, opts.thinkLabel || '思考过程')),
            h('div', { className: 'ddc-think-body' }, renderMarkdown(inner.join('\n'), opts))))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          const level = heading[1].length
          blocks.push(h('h' + Math.min(level + 2, 6), { key: nk() }, renderInline(heading[2], 'h' + (key++))))
          i++
          continue
        }
        // thematic break
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: nk() }))
          i++
          continue
        }
        // table (needs a header row followed by a delimiter row)
        if (isTableStart(lines, i)) {
          const headers = splitCells(lines[i])
          const aligns = splitCells(lines[i + 1]).map((c) => {
            const left = c.startsWith(':')
            const right = c.endsWith(':')
            return left && right ? 'center' : right ? 'right' : left ? 'left' : ''
          })
          i += 2
          const rows = []
          while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
            rows.push(splitCells(lines[i]))
            i++
          }
          const cell = (tag, text, col) => h(tag, { key: nk(), style: aligns[col] ? { textAlign: aligns[col] } : undefined },
            renderInline(text ?? '', 'tc' + (key++)))
          blocks.push(h('div', { key: nk(), className: 'ddc-tablewrap' },
            h('table', { className: 'ddc-table' },
              h('thead', null, h('tr', null, headers.map((c, col) => cell('th', c, col)))),
              h('tbody', null, rows.map((r) => h('tr', { key: nk() },
                headers.map((_, col) => cell('td', r[col] ?? '', col))))))))
          continue
        }
        // unordered or ordered list (recursive, supports nesting)
        if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
          const res = parseList(i, (line.match(/^\s*/) ?? [''])[0].replace(/\t/g, '    ').length)
          blocks.push(res.node)
          i = res.next
          continue
        }
        // blockquote
        if (/^\s*>\s?/.test(line)) {
          const inner = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { inner.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
          blocks.push(h('blockquote', { key: nk() }, renderMarkdown(inner.join('\n'))))
          continue
        }
        // blank
        if (line.trim() === '') { i++; continue }
        // paragraph: gather until blank or a structural line
        const para = []
        while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(i)) { para.push(lines[i]); i++ }
        blocks.push(h('p', { key: nk() }, renderInline(para.join(' '), 'p' + (key++))))
      }
      return blocks
    }

    // --- panel component -------------------------------------------------------
    function Panel(props) {
      const tt = props.tt
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [viewChatId, setViewChatId] = React.useState(undefined)
      const [toast, setToast] = React.useState(null)
      const [recoverOpen, setRecoverOpen] = React.useState(false)
      const [webMissing, setWebMissing] = React.useState([])
      const [recovering, setRecovering] = React.useState(false)
      const [loadingWeb, setLoadingWeb] = React.useState(false)
      const listRef = React.useRef(null)
      const stateRef = React.useRef(null)
      stateRef.current = state
      const toastTimer = React.useRef(undefined)
      const pinnedRef = React.useRef(true)

      const showToast = React.useCallback((text, error = false) => {
        setToast({ text, error })
        window.clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(() => setToast(null), 5000)
      }, [])

      // poll /state — adaptive. Faster while streaming; slow when the engine is
      // stopped (idle-closed) and paused entirely when the tab is hidden, so the
      // panel does not wake the host needlessly.
      React.useEffect(() => {
        let cancelled = false
        let timer
        const schedule = () => {
          const s = stateRef.current
          const streaming = s?.chats?.some((c) => c.streaming) ?? false
          const stopped = s?.engine === 'stopped' || s?.engine === undefined
          let delay = 1500
          if (streaming) delay = 600
          else if (stopped) delay = 8000
          if (typeof document !== 'undefined' && document.hidden) delay = 15000
          timer = window.setTimeout(poll, delay)
        }
        const poll = async () => {
          if (cancelled) return
          // Skip work while the tab is hidden to avoid pointless host round-trips.
          if (typeof document !== 'undefined' && document.hidden) { schedule(); return }
          try {
            const snapshot = await request(API.state)
            if (cancelled) return
            setState(snapshot)
            setViewChatId((prev) => {
              const active = snapshot.activeChatId
              if (prev !== undefined && snapshot.chats.some((c) => c.id === prev)) return prev
              return active
            })
          } catch { /* keep previous */ }
          schedule()
        }
        const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden && !cancelled) { window.clearTimeout(timer); void poll() } }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        void poll()
        return () => { cancelled = true; window.clearTimeout(timer); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible) }
      }, [])

      // auto-scroll when pinned
      React.useEffect(() => {
        const list = listRef.current
        if (list === null) return
        if (pinnedRef.current) list.scrollTop = list.scrollHeight
      }, [state, viewChatId])

      const onScroll = React.useCallback(() => {
        const list = listRef.current
        if (list === null) return
        pinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 96
      }, [])

      const chats = state?.chats ?? []
      const viewChat = chats.find((c) => c.id === viewChatId) ?? chats[0]
      const busy = state?.busy ?? false
      const loggedIn = state?.loggedIn ?? null
      const streaming = viewChat?.streaming ?? false
      const engineState = state?.engine ?? 'stopped'
      const engineError = state?.engineError

      const openLogin = React.useCallback(async () => {
        try {
          const r = await request(API.openLogin)
          if (!r.ok) showToast(r.error ?? 'open login failed', true)
        } catch (e) { showToast(String(e), true) }
      }, [showToast])

      const closeBrowser = React.useCallback(async () => { await request(API.closeBrowser).catch(() => undefined) }, [])

      const newChat = React.useCallback(async () => {
        try {
          const r = await request(API.newChat)
          if (r.ok && r.chatId) setViewChatId(r.chatId)
          else if (!r.ok) showToast(r.error ?? 'new chat failed', true)
        } catch (e) { showToast(String(e), true) }
      }, [showToast])

      const toggleRecover = React.useCallback(async () => {
        if (recoverOpen) { setRecoverOpen(false); return }
        setLoadingWeb(true)
        try {
          const r = await request(API.webChats)
          if (r.ok === true) {
            // Show ALL web conversations so an already-imported (possibly stale
            // or truncated) chat can be re-imported to repair it. `imported`
            // marks entries already synced locally.
            setWebMissing(r.web ?? [])
          } else {
            setWebMissing([])
            if (r.error) showToast(r.error, true)
          }
          setRecoverOpen(true)
        } catch (e) { showToast(String(e), true) }
        finally { setLoadingWeb(false) }
      }, [recoverOpen, showToast])

      const recoverFromWeb = React.useCallback(async (item) => {
        if (recovering) return
        setRecovering(true)
        try {
          const r = await request(API.recover, { title: item.title, href: item.href })
          if (!r.ok) { showToast(fmt(tt('panel.recoverFailed'), { error: r.error ?? '' }), true); return }
          // Mark this entry as imported (keep it in the list for future refresh).
          setWebMissing((list) => list.map((x) => (x.href === item.href ? { ...x, imported: true } : x)))
          if (r.chatId) setViewChatId(r.chatId)
          const key = r.updated ? 'panel.recoverRefreshed' : 'panel.recoverDone'
          showToast(fmt(tt(key), { title: r.title ?? item.title, count: String(r.count ?? 0) }))
        } catch (e) { showToast(fmt(tt('panel.recoverFailed'), { error: String(e) }), true) }
        finally { setRecovering(false) }
      }, [recovering, showToast, tt])

      const send = React.useCallback(async () => {
        const text = draft.trim()
        if (text === '' || busy) return
        setDraft('')
        pinnedRef.current = true
        try {
          const r = await request(API.send, { text })
          if (!r.ok) showToast(r.error ?? 'send failed', true)
          else if (r.chatId) setViewChatId(r.chatId)
        } catch (e) { showToast(String(e), true) }
      }, [draft, busy, showToast])

      const stop = React.useCallback(async () => { await request(API.stop).catch(() => undefined) }, [])

      const toggleDeepThink = React.useCallback(async () => {
        const next = !(state?.deepThink ?? false)
        try { const r = await request(API.deepThink, { enabled: next }); if (!r.ok) showToast(r.error ?? 'toggle failed', true) }
        catch (e) { showToast(String(e), true) }
      }, [state, showToast])

      const toggleSearch = React.useCallback(async () => {
        const next = !(state?.search ?? false)
        try { const r = await request(API.search, { enabled: next }); if (!r.ok) showToast(r.error ?? 'toggle failed', true) }
        catch (e) { showToast(String(e), true) }
      }, [state, showToast])

      const statusDot = busy ? 'busy' : engineState === 'error' ? 'bad' : loggedIn === true ? (engineState === 'stopped' ? 'idle' : 'ok') : 'warn'
      const statusText = busy ? tt('panel.busy')
        : engineState === 'error' ? `${tt('panel.statusError')}${engineError ? `: ${engineError}` : ''}`
          : engineState === 'launching' ? tt('panel.statusLaunching')
            : engineState === 'stopped' && loggedIn === true ? tt('panel.statusIdle')
              : loggedIn === true ? tt('panel.statusLoggedIn')
                : loggedIn === false ? tt('panel.statusNotLoggedIn')
                  : tt('panel.statusUnknown')

      const togglesDisabled = busy || loggedIn !== true

      return h('div', { className: 'ddc-panel' },
        h('header', { className: 'ddc-header' },
          h('h2', { className: 'ddc-title' }, tt('panel.title')),
          h('div', { className: 'ddc-spacer' }),
          h('span', { className: 'ddc-status', 'data-state': statusDot },
            h('span', { className: 'ddc-dot', 'data-state': statusDot }),
            h('span', null, statusText)),
          loggedIn !== true ? h('button', { className: 'ddc-btn ddc-btn-primary', onClick: () => void openLogin() }, tt('panel.openLogin')) : null,
          engineState !== 'stopped' ? h('button', { className: 'ddc-btn ddc-btn-ghost', onClick: () => void closeBrowser() }, tt('panel.closeBrowser')) : null,
        ),
        h('div', { className: 'ddc-body' },
          h('aside', { className: 'ddc-sidebar' },
            h('button', { className: 'ddc-btn ddc-btn-primary ddc-new', onClick: () => void newChat() }, tt('panel.newChat')),
            h('button', {
              className: 'ddc-btn ddc-btn-ghost ddc-new',
              disabled: loggedIn !== true || loadingWeb,
              title: tt('panel.recoverHint'),
              onClick: () => void toggleRecover(),
            }, loadingWeb ? tt('panel.recovering') : tt('panel.pullHistory')),
            recoverOpen
              ? h('div', { className: 'ddc-recover' },
                  webMissing.length === 0
                    ? h('div', { className: 'ddc-empty-side' }, tt('panel.recoverEmpty'))
                    : webMissing.map((item) => h('button', {
                        key: item.href ?? item.title,
                        className: 'ddc-recoveritem',
                        'data-imported': item.imported ? 'true' : undefined,
                        disabled: recovering,
                        title: item.title,
                        onClick: () => void recoverFromWeb(item),
                      },
                        h('span', { className: 'ddc-chattitle' }, item.title),
                        h('span', { className: 'ddc-recoverbadge' }, item.imported ? tt('panel.recoverRefreshBadge') : tt('panel.recoverNewBadge')))))
              : null,
            h('div', { className: 'ddc-chatlist' },
              chats.length === 0
                ? h('div', { className: 'ddc-empty-side' }, tt('panel.noChats'))
                : chats.map((chat) => h('button', {
                    key: chat.id,
                    className: 'ddc-chatrow',
                    'data-active': chat.id === viewChatId ? 'true' : undefined,
                    onClick: () => setViewChatId(chat.id),
                    title: chat.title,
                  }, h('span', { className: 'ddc-chattitle' }, chat.title)))),
          ),
          h('div', { className: 'ddc-main' },
            h('div', { className: 'ddc-messages', ref: listRef, onScroll },
              viewChat === undefined || viewChat.messages.length === 0
                ? h('div', { className: 'ddc-empty' },
                    h('h3', { className: 'ddc-empty-title' }, tt('panel.emptyTitle')),
                    h('p', { className: 'ddc-empty-body' }, tt('panel.emptyBody')),
                    loggedIn !== true ? h('button', { className: 'ddc-btn ddc-btn-primary', onClick: () => void openLogin() }, tt('panel.openLogin')) : null)
                : viewChat.messages.map((msg) => h('div', { key: msg.id, className: 'ddc-msgrow', 'data-role': msg.role, 'data-streaming': msg.streaming === true ? 'true' : undefined },
                    msg.role === 'user'
                      ? h('div', { className: 'ddc-msgbody' },
                          h('div', { className: 'ddc-msgmeta' },
                            h('span', { className: 'ddc-speaker' }, tt('panel.roleYou'))),
                          h('div', { className: 'ddc-bubble' }, h('div', { className: 'ddc-usertext' }, msg.content)))
                      : h('div', { className: 'ddc-msgbody' },
                          h('div', { className: 'ddc-avatar', title: 'DeepSeek' }, h(SidebarIcon, { size: 15 })),
                          h('div', { className: 'ddc-msgcontent' },
                            h('div', { className: 'ddc-msgmeta' },
                              h('span', { className: 'ddc-speaker' }, 'DeepSeek'),
                              msg.streaming === true ? h('span', { className: 'ddc-badge' }, tt('panel.streaming') + '…') : null),
                            h('div', { className: 'ddc-answer' }, renderMarkdown(msg.content, { thinkLabel: tt('panel.thinking') })),
                            msg.error ? h('div', { className: 'ddc-msgerror' }, msg.error) : null)))),
            ),
            h('div', { className: 'ddc-composer' },
              h('div', { className: 'ddc-toolbar' },
                h('button', { className: 'ddc-toggle', 'data-active': (state?.deepThink ?? false) ? 'true' : undefined, disabled: togglesDisabled, onClick: () => void toggleDeepThink() }, tt('panel.deepThink')),
                h('button', { className: 'ddc-toggle', 'data-active': (state?.search ?? false) ? 'true' : undefined, disabled: togglesDisabled, onClick: () => void toggleSearch() }, tt('panel.search')),
              ),
              h('textarea', {
                className: 'ddc-input',
                value: draft,
                placeholder: busy ? tt('panel.busy') : loggedIn !== true ? tt('panel.notLoggedIn') : tt('panel.placeholder'),
                disabled: busy || loggedIn !== true,
                onChange: (e) => setDraft(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } },
              }),
              h('div', { className: 'ddc-footer' },
                h('span', { className: 'ddc-hint' }, tt('panel.hint')),
                h('div', { className: 'ddc-spacer' }),
                streaming
                  ? h('button', { className: 'ddc-btn ddc-btn-danger', onClick: () => void stop() }, tt('panel.stop'))
                  : h('button', { className: 'ddc-btn ddc-btn-primary', disabled: busy || loggedIn !== true || draft.trim() === '', onClick: () => void send() }, tt('panel.send')),
              ),
            ),
          ),
        ),
        toast !== null ? h('div', { className: 'ddc-toast', 'data-error': toast.error ? 'true' : undefined }, toast.text) : null,
      )
    }

    // Official DeepSeek whale icon (single path, viewBox 0 0 50 50). The nav
    // row supplies the square edge via props.size; currentColor lets the host
    // theme tint it like other nav icons.
    const WHALE_PATH = 'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z'
    function SidebarIcon(props) {
      const size = props.size ?? 16
      return h('svg', { viewBox: '0 0 50 50', width: size, height: size, 'aria-hidden': true, className: 'ddc-icon', fill: 'currentColor' },
        h('path', { d: WHALE_PATH }))
    }

    // Panel-local styles, rendered as a React element so unmounting removes them.
    const STYLE = `
      .ddc-host { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; height: 100%; width: 100%; }
      .ddc-panel { display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0;
        position: relative;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font-family: inherit; }
      .ddc-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
        border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
      .ddc-title { font-size: 15px; font-weight: 600; margin: 0; }
      .ddc-spacer { flex: 1; }
      .ddc-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
        color: var(--dsw-alias-label-secondary); }
      .ddc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
      .ddc-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary); }
      .ddc-dot[data-state="warn"] { background: var(--dsw-alias-state-warn-primary); }
      .ddc-dot[data-state="bad"] { background: var(--dsw-alias-state-error-primary); }
      .ddc-dot[data-state="busy"] { background: var(--dsw-alias-link); }
      .ddc-dot[data-state="idle"] { background: var(--dsw-alias-state-idle-primary); }
      .ddc-btn { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary); }
      .ddc-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .ddc-btn:disabled { opacity: 0.5; cursor: default; }
      .ddc-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
      .ddc-btn-primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--dsw-alias-button-primary-hover); }
      .ddc-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
      .ddc-btn-danger { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: #fff; }
      .ddc-body { display: flex; flex: 1; min-height: 0; }
      .ddc-sidebar { width: 208px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1);
        display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-specific-sidebar-fill); }
      .ddc-new { width: 100%; }
      .ddc-chatlist { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
      .ddc-recover { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 4px; background: var(--dsw-alias-bg-layer-1); }
      .ddc-recoveritem { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; text-align: left; border: none; background: transparent;
        cursor: pointer; font: inherit; font-size: 12.5px; line-height: 1.5; min-height: 26px;
        color: var(--dsw-alias-label-primary); padding: 4px 8px; border-radius: 6px; overflow: hidden; white-space: nowrap; }
      .ddc-recoveritem:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .ddc-recoveritem:disabled { opacity: 0.5; cursor: default; }
      .ddc-recoveritem .ddc-chattitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ddc-recoverbadge { flex: none; font-size: 10px; padding: 1px 6px; border-radius: 10px; white-space: nowrap;
        color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
      .ddc-recoveritem[data-imported="true"] .ddc-recoverbadge { color: var(--dsw-alias-label-primary-foreground);
        background: var(--dsw-alias-button-primary-fill); }
      .ddc-empty-side { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 8px; }
      .ddc-chatrow { text-align: left; border: none; background: transparent; cursor: pointer;
        padding: 7px 8px; border-radius: 8px; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ddc-chatrow:hover { background: var(--dsw-alias-bg-layer-1); }
      .ddc-chatrow[data-active="true"] { background: var(--dsw-alias-bg-layer-2); }
      .ddc-chattitle { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ddc-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .ddc-messages { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }
      .ddc-empty { margin: auto; text-align: center; max-width: 420px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
      .ddc-empty-title { font-size: 18px; margin: 0; }
      .ddc-empty-body { color: var(--dsw-alias-label-secondary); font-size: 13px; margin: 0; }
      .ddc-msgrow { display: flex; flex-direction: column; }
      .ddc-msgrow[data-role="user"] { align-items: flex-end; }
      .ddc-msgbody { display: flex; gap: 10px; width: 100%; min-width: 0; }
      .ddc-msgrow[data-role="user"] .ddc-msgbody { flex-direction: column; align-items: flex-end; width: auto; max-width: 82%; }
      .ddc-msgrow[data-role="assistant"] .ddc-msgbody { align-items: flex-start; }
      .ddc-avatar { flex: none; width: 26px; height: 26px; border-radius: 50%; margin-top: 1px;
        display: flex; align-items: center; justify-content: center;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-link); }
      .ddc-msgcontent { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      .ddc-msgmeta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ddc-speaker { font-weight: 600; }
      .ddc-badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
      .ddc-answer { line-height: 1.68; font-size: 14px; word-break: break-word; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 12px; padding: 12px 15px; }
      .ddc-bubble { line-height: 1.6; font-size: 14px; word-break: break-word; }
      /* User turn: the host's own bubble surface, with primary text — never a
         brand fill (that token is an inverted neutral and goes near-black). */
      .ddc-msgrow[data-role="user"] .ddc-bubble { background: var(--dsw-specific-bubble);
        color: var(--dsw-alias-label-primary); padding: 9px 14px; border-radius: 14px; }
      .ddc-usertext { white-space: pre-wrap; }
      .ddc-answer > *:first-child { margin-top: 0; }
      .ddc-answer > *:last-child { margin-bottom: 0; }
      .ddc-answer p, .ddc-bubble p { margin: 0 0 10px; }
      .ddc-answer p:last-child, .ddc-bubble p:last-child { margin-bottom: 0; }
      .ddc-answer ul, .ddc-answer ol { margin: 0 0 10px; padding-left: 22px; }
      .ddc-answer li { margin: 2px 0; }
      .ddc-answer li > ul, .ddc-answer li > ol { margin: 2px 0; padding-left: 20px; }
      .ddc-answer h3, .ddc-answer h4, .ddc-answer h5, .ddc-answer h6 { margin: 14px 0 8px; line-height: 1.35; }
      .ddc-answer blockquote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); }
      .ddc-answer hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1); margin: 14px 0; }
      /* GFM table */
      .ddc-tablewrap { margin: 10px 0; overflow-x: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
      .ddc-table { border-collapse: collapse; width: 100%; font-size: 13px; }
      .ddc-table th, .ddc-table td { padding: 7px 11px; text-align: left; border-bottom: 1px solid var(--dsw-alias-border-l1);
        vertical-align: top; }
      .ddc-table th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; color: var(--dsw-alias-label-primary);
        white-space: nowrap; }
      .ddc-table tbody tr:last-child td { border-bottom: none; }
      .ddc-table tbody tr:hover { background: var(--dsw-alias-bg-layer-2); }
      .ddc-answer code { background: var(--dsw-alias-bg-layer-2);
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
        padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
      .ddc-answer a { color: var(--dsw-alias-link); text-decoration: none; }
      .ddc-answer a:hover { text-decoration: underline; }
      /* code block with language label + copy */
      .ddc-codeblock { margin: 10px 0; border-radius: 10px; overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-markdown-code-block); }
      .ddc-codehead { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 4px 8px 4px 12px; font-size: 11px; color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-markdown-code-block-banner); border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .ddc-codelang { text-transform: lowercase; letter-spacing: 0.2px; }
      .ddc-copy { border: none; background: transparent; color: var(--dsw-alias-label-secondary);
        cursor: pointer; font: inherit; font-size: 12px; line-height: 1; padding: 3px 6px; border-radius: 6px; }
      .ddc-copy:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .ddc-copy[data-copied="true"] { color: var(--dsw-alias-state-success-primary); }
      .ddc-codepre { margin: 0; padding: 11px 13px; overflow-x: auto; font-size: 12.5px; line-height: 1.55;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
      .ddc-codepre code { background: transparent; padding: 0; border-radius: 0; font-family: inherit; }
      /* syntax tokens — light palette (default), then overridden for dark mode */
      .ddc-tok-kw { color: #a626a4; }
      .ddc-tok-str { color: #2f7d32; }
      .ddc-tok-num { color: #b76b01; }
      .ddc-tok-com { color: #8a9199; font-style: italic; }
      .ddc-tok-fn { color: #2a63c9; }
      .ddc-tok-type { color: #0e7490; }
      .ddc-tok-pun { color: #6b7280; }
      body[data-ds-dark-theme] .ddc-tok-kw { color: #c678dd; }
      body[data-ds-dark-theme] .ddc-tok-str { color: #98c379; }
      body[data-ds-dark-theme] .ddc-tok-num { color: #d19a66; }
      body[data-ds-dark-theme] .ddc-tok-com { color: #7f848e; }
      body[data-ds-dark-theme] .ddc-tok-fn { color: #61afef; }
      body[data-ds-dark-theme] .ddc-tok-type { color: #56b6c2; }
      body[data-ds-dark-theme] .ddc-tok-pun { color: #9aa0a6; }
      /* reasoning trace, collapsed by default */
      .ddc-think { margin: 0; font-size: 12.5px; }
      .ddc-think-summary { display: inline-flex; align-items: center; gap: 6px; width: fit-content;
        cursor: pointer; list-style: none; padding: 3px 10px; border-radius: 12px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .ddc-think-summary::-webkit-details-marker { display: none; }
      .ddc-think-summary:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .ddc-think-ico { color: var(--dsw-alias-link); }
      .ddc-think-body { border-left: 2px solid var(--dsw-alias-border-l2); padding-left: 11px; margin-top: 8px;
        color: var(--dsw-alias-label-secondary); }
      .ddc-think-body p { margin: 0 0 8px; }
      .ddc-msgerror { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin-top: 4px; }
      .ddc-msgrow[data-streaming="true"] .ddc-answer::after { content: '▍'; margin-left: 2px;
        color: var(--dsw-alias-link); animation: ddc-blink 1s steps(2, start) infinite; }
      @keyframes ddc-blink { 50% { opacity: 0; } }
      .ddc-composer { flex: none; border-top: 1px solid var(--dsw-alias-border-l1); padding: 10px 16px 14px;
        display: flex; flex-direction: column; gap: 8px; }
      .ddc-toolbar { display: flex; gap: 8px; }
      .ddc-toggle { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 14px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); }
      .ddc-toggle[data-active="true"] { background: var(--dsw-alias-button-primary-fill);
        color: var(--dsw-alias-label-primary-foreground); border-color: transparent; }
      .ddc-toggle:disabled { opacity: 0.5; cursor: default; }
      .ddc-input { width: 100%; box-sizing: border-box; resize: none; min-height: 64px; max-height: 200px;
        font: inherit; font-size: 14px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary); }
      .ddc-input:focus { outline: none; border-color: var(--dsw-alias-link); }
      .ddc-footer { display: flex; align-items: center; gap: 10px; }
      .ddc-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ddc-toast { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
        background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
        padding: 8px 14px; border-radius: 10px; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
      .ddc-toast[data-error="true"] { color: var(--dsw-alias-state-error-primary); }
      .ddc-panel { position: relative; }
    `

    const inject = ['slots', 'locale']

    function apply(ctx) {
      // dictionaries
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-deepseek-chat: dictionaries')
      } catch (e) {
        console.warn('[dsh-deepseek-chat] locale register failed:', e)
      }
      const tt = ctx.locale.bind(NS)

      // panel
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, (props) => h('div', { className: 'ddc-host' }, h('style', null, STYLE), h(Panel, { ...props, tt }))))
      } catch (e) {
        console.warn('[dsh-deepseek-chat] main slot register failed:', e)
      }

      // sidebar entry
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => tt('meta.title'),
        }, SidebarIcon))
      } catch (e) {
        console.warn('[dsh-deepseek-chat] sidebar.panellist register failed:', e)
      }
    }

    return { inject, apply }
  },
})