/**
 * dsh-ui-zoom — browser half. Runs inside the dsh web GUI.
 *
 * Adds whole-interface zoom to the Harness Web UI. Unlike the font-size setting
 * (which only scales content text), this scales everything: the sidebar, icons,
 * buttons and spacing.
 *
 * Implementation: the CSS `zoom` property on the document root. It re-lays-out
 * the page at the scaled size, so `100%`/`100vh` children keep filling the
 * viewport (verified from 0.8x to 2.0x with no scrollbar growth), which is why
 * no viewport compensation is needed.
 *
 * Surfaces:
 *  - Settings → General → a "Interface zoom" row (slider + - / + + reset).
 *  - Keyboard shortcuts (Control/Command + Alt + = / - / 0).
 *  - The preference is remembered in localStorage and restored on load.
 */
window.__ModuleLoader__.load({
  id: '@syske/dsh-ui-zoom',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-ui-zoom'
    const STORAGE_KEY = 'dsh-ui-zoom.factor'
    const DEFAULT_FACTOR = 1
    const MIN = 0.5
    const MAX = 2
    const STEP = 0.05

    const zh = {
      'settings.title': '界面缩放',
      'settings.description': '整体缩放侧边栏、按钮、图标与文字；仅作用于本浏览器。',
      'settings.decrease': '缩小',
      'settings.increase': '放大',
      'settings.reset': '重置',
      'settings.value': '当前',
      'shortcut.increase': '界面放大',
      'shortcut.decrease': '界面缩小',
      'shortcut.reset': '界面缩放重置为 100%',
    }
    const en = {
      'settings.title': 'Interface zoom',
      'settings.description': 'Scale the whole interface — sidebar, buttons, icons and text. Applies to this browser only.',
      'settings.decrease': 'Zoom out',
      'settings.increase': 'Zoom in',
      'settings.reset': 'Reset',
      'settings.value': 'Current',
      'shortcut.increase': 'Zoom interface in',
      'shortcut.decrease': 'Zoom interface out',
      'shortcut.reset': 'Reset interface zoom to 100%',
    }

    // --- zoom store ------------------------------------------------------------
    // A tiny observable around the persisted factor, shared by the settings row
    // and the shortcut commands so both stay in sync.
    function clamp(value) {
      const n = Math.round(Number(value) / STEP) * STEP
      if (!Number.isFinite(n)) return DEFAULT_FACTOR
      return Math.min(MAX, Math.max(MIN, Number(n.toFixed(2))))
    }

    function readStored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return DEFAULT_FACTOR
        return clamp(raw)
      } catch {
        return DEFAULT_FACTOR
      }
    }

    // The app shell lives in `#root`; dialogs, menus and toasts are portalled to
    // `body` as `position: fixed` siblings of it. Zooming `documentElement` scales
    // those portals too, but their positioning library still measures the
    // unscaled viewport, so they land outside the window (the sidebar "More"
    // menu showed a single clipped row). Zooming `#root` instead keeps the app
    // filling the viewport at every factor with no overflow, and leaves the
    // portals anchored correctly; they simply keep their 100% size.
    function zoomTarget() {
      return document.getElementById('root') || document.body
    }

    function applyZoom(factor) {
      const target = zoomTarget()
      if (target === null) return
      if (factor === DEFAULT_FACTOR) target.style.removeProperty('zoom')
      else target.style.zoom = String(factor)
    }

    const zoomStore = (() => {
      let factor = readStored()
      const listeners = new Set()
      const emit = () => listeners.forEach((fn) => fn(factor))
      return {
        get: () => factor,
        set(next) {
          const value = clamp(next)
          if (value === factor) return
          factor = value
          applyZoom(factor)
          try { window.localStorage.setItem(STORAGE_KEY, String(factor)) } catch { /* ignore */ }
          emit()
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        /** Adopt a factor written by another tab, without re-persisting it. */
        adopt(next) {
          const value = clamp(next)
          if (value === factor) return
          factor = value
          applyZoom(factor)
          emit()
        },
      }
    })()

    // --- settings row ----------------------------------------------------------
    function ZoomRow(props) {
      const tt = props.tt
      const factor = useFactor()
      const percent = Math.round(factor * 100)
      return h('div', { className: 'duz-row' },
        h('div', { className: 'duz-text' },
          h('div', { className: 'duz-title' }, tt('settings.title')),
          h('div', { className: 'duz-desc' }, tt('settings.description'))),
        h('div', { className: 'duz-control' },
          h('button', {
            className: 'duz-btn', type: 'button', title: tt('settings.decrease'),
            'aria-label': tt('settings.decrease'), disabled: factor <= MIN,
            onClick: () => zoomStore.set(factor - STEP),
          }, '−'),
          h('input', {
            className: 'duz-slider', type: 'range',
            min: String(MIN), max: String(MAX), step: String(STEP), value: String(factor),
            'aria-label': tt('settings.title'), 'aria-valuetext': percent + '%',
            onChange: (e) => zoomStore.set(Number(e.target.value)),
          }),
          h('button', {
            className: 'duz-btn', type: 'button', title: tt('settings.increase'),
            'aria-label': tt('settings.increase'), disabled: factor >= MAX,
            onClick: () => zoomStore.set(factor + STEP),
          }, '+'),
          h('span', { className: 'duz-value' }, percent + '%'),
          h('button', {
            className: 'duz-reset', type: 'button', disabled: factor === DEFAULT_FACTOR,
            onClick: () => zoomStore.set(DEFAULT_FACTOR),
          }, tt('settings.reset'))))
    }

    // Subscribe to the shared factor; React 18 provides useSyncExternalStore,
    // and the manual fallback keeps older runtimes working.
    function useFactor() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(zoomStore.subscribe, zoomStore.get, zoomStore.get)
      }
      return useFallbackFactor()
    }

    function useFallbackFactor() {
      const [factor, setFactor] = React.useState(zoomStore.get())
      React.useEffect(() => zoomStore.subscribe(setFactor), [])
      return factor
    }

    const STYLE = `
      .duz-row { display: flex; align-items: center; gap: 16px; width: 100%;
        padding: 12px 0; flex-wrap: wrap; }
      .duz-text { flex: 1 1 220px; min-width: 180px; display: flex; flex-direction: column; gap: 2px; }
      .duz-title { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .duz-desc { font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
      .duz-control { display: flex; align-items: center; gap: 8px; flex: none; }
      .duz-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
        font: inherit; font-size: 16px; line-height: 1; cursor: pointer; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary); }
      .duz-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .duz-btn:disabled { opacity: 0.4; cursor: default; }
      .duz-slider { width: 140px; accent-color: var(--dsw-alias-link); cursor: pointer; }
      .duz-value { min-width: 44px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-secondary); }
      .duz-reset { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2); background: transparent;
        color: var(--dsw-alias-label-secondary); }
      .duz-reset:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .duz-reset:disabled { opacity: 0.4; cursor: default; }
    `

    const inject = ['slots', 'locale']

    function apply(ctx) {
      if (!ctx.locale) {
        console.warn('[dsh-ui-zoom] locale service unavailable; skipping registration')
        return
      }
      // dictionaries
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ui-zoom: dictionaries')
      } catch (e) { console.warn('[dsh-ui-zoom] locale register failed:', e) }
      const tt = ctx.locale.bind(NS)

      // Apply the remembered factor immediately, and keep it applied.
      ctx.effect(() => {
        applyZoom(zoomStore.get())
        return () => { zoomTarget().style.removeProperty('zoom') }
      }, 'dsh-ui-zoom: apply saved factor')

      // Mirror changes made in another tab.
      ctx.effect(() => {
        const onStorage = (e) => {
          if (e.key !== STORAGE_KEY || e.newValue === null) return
          zoomStore.adopt(e.newValue)
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, 'dsh-ui-zoom: cross-tab sync')

      // Settings → General row.
      try {
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'ui-zoom',
          order: 13,
          locale: NS,
          label: () => tt('settings.title'),
        }, (props) => h('div', { className: 'duz-host' }, h('style', null, STYLE), h(ZoomRow, { ...props, tt }))))
      } catch (e) { console.warn('[dsh-ui-zoom] settings row register failed:', e) }

      // Keyboard shortcuts. The Shortcut service refuses arbitrary Web
      // combinations (Linux Web accepts only Mod+Slash, Mod+Shift+Comma and
      // Mod+Shift+Period), so this plugin owns a small keydown listener instead.
      // Control/Command + Alt keeps clear of the browser's own zoom keys, which
      // a page cannot intercept.
      ctx.effect(() => {
        const onKeyDown = (event) => {
          if (event.defaultPrevented) return
          const primary = event.ctrlKey || event.metaKey
          if (!primary || !event.altKey) return
          if (event.shiftKey) return
          let action
          if (event.code === 'Equal' || event.code === 'NumpadAdd') action = () => zoomStore.set(zoomStore.get() + STEP)
          else if (event.code === 'Minus' || event.code === 'NumpadSubtract') action = () => zoomStore.set(zoomStore.get() - STEP)
          else if (event.code === 'Digit0' || event.code === 'Numpad0') action = () => zoomStore.set(DEFAULT_FACTOR)
          if (action === undefined) return
          event.preventDefault()
          event.stopPropagation()
          action()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, 'dsh-ui-zoom: keyboard shortcuts')
    }

    return { inject, apply }
  },
})
