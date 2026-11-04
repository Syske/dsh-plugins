# dsh-ui-zoom

Whole-interface zoom for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Web GUI.

The built-in font-size setting only scales content text. This plugin scales the
**entire interface** — sidebar, buttons, icons, spacing and text — from 50% to
200%.

## Features

- **Settings → General → Interface zoom**: a slider with −/+ steps, a live
  percentage and a reset control.
- **Keyboard shortcuts**: `Ctrl/Cmd + Alt + =` zooms in, `Ctrl/Cmd + Alt + -`
  zooms out, `Ctrl/Cmd + Alt + 0` resets to 100%.
- **Remembered preference**: stored in the browser and restored on load.
- **Cross-tab sync**: changing the zoom in one tab updates the others.

## Why the Alt modifier

`Ctrl/Cmd +` / `-` / `0` are the browser's own zoom shortcuts and cannot be
intercepted by a page — binding them would scale twice. The plugin therefore
uses the Alt variant, which does reach the page. The Shortcut service is not
used because Web restricts plugin-declared combinations to a small whitelist
(`Mod+Slash`, `Mod+Shift+Comma`, `Mod+Shift+Period` on Linux Web).

## How it works

The plugin sets the CSS `zoom` property on the app shell element (`#root`). `zoom`
re-lays-out that subtree at the scaled size, so percentage- and viewport-sized
children keep filling the window instead of overflowing; no viewport compensation
is needed. Verified from 0.8× to 2.0× at two viewport sizes with no scrollbar
growth.

Zooming `#root` rather than the document root is deliberate: dialogs, menus and
toasts are portalled to `body` as `position: fixed` siblings of the shell. Zooming
the document root scaled those portals too, while their positioning library still
measured the unscaled viewport — which pushed them off-screen (the sidebar
"More" menu then showed a single clipped row). With `#root` as the target the
portals stay correctly anchored and fully usable.

## Install

```bash
# from this directory
dsh plugin --profile web add ./dsh-ui-zoom
```

Or, in a session, `plugin_manager` with `install_bundle` and this directory as
the target. Reload the Web page once after installing so the new Client module
is picked up.

## Notes

- Scope is the whole Harness Web UI; it does not affect other sites.
- Overlay surfaces (menus, dialogs, toasts) are portalled outside the zoomed
  subtree, so they keep their 100% size while the rest of the interface scales.
  They stay correctly anchored and usable.
- The preference is per browser origin (`localStorage`), not per Harness profile.
- Disabling or removing the plugin restores the page to 100%.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
