# dsh-ui-zoom

Whole-interface zoom for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI.

The built-in font-size setting only scales content text. This plugin scales the **entire interface** — sidebar, buttons, icons, spacing and text — from 50% to 200%.

## Install

```bash
dsh plugin --profile web add @syske.range/dsh-ui-zoom
```

Install from source instead (no npm release, or to pin a commit):

```bash
dsh plugin --profile web add github:Syske/dsh-ui-zoom
```

Or, inside a session, use `plugin_manager` with `install_bundle` and this repository directory as the target.

Reload the Web page once after installing so the new Client module is picked up.

> Not to be confused with the unrelated npm package `dsh-ui-zoom` (maintained by
> another author, `sjrslh/dsh-ui-zoom`). This plugin is published as
> `@syske/dsh-ui-zoom`.

## Features

- **Settings → General → Interface zoom**: a slider with −/+ steps, a live percentage and a reset control.
- **Keyboard shortcuts**: `Ctrl/Cmd + Alt + =` zooms in, `Ctrl/Cmd + Alt + -` zooms out, `Ctrl/Cmd + Alt + 0` resets to 100%.
- **Remembered preference**: stored in the browser and restored on load.
- **Cross-tab sync**: changing the zoom in one tab updates the others.

## Compatibility

- **DSH**: tested against `0.2.1-rc.5` (Web profile). The `apply(ctx)` contract is stable, but registered `ctx` capabilities can change between preview releases.
- **Platform**: Web only (`dsh.client.platform = "web"`). The Desktop shell is not targeted.
- **Browser**: any browser that supports the CSS `zoom` property (Chromium, Safari, and Firefox 126+). `Ctrl/Cmd + Alt` is used instead of the browser's own zoom keys.
- **Node**: `>= 22` (for the Host half of the bundle).
- **Dependencies**: none. No network access, no external service, no credentials.

## Permissions and scope

- The plugin only manipulates the CSS `zoom` property on the app shell element (`#root`).
- It reads and writes one `localStorage` key (`dsh-ui-zoom.factor`) in the Harness origin.
- It adds one keydown listener for the shortcuts above and removes it when unloaded.
- It registers one preference row in **Settings → General**.
- No files, no processes, no network calls, no telemetry.

## Why the Alt modifier

`Ctrl/Cmd +` / `-` / `0` are the browser's own zoom shortcuts and cannot be intercepted by a page — binding them would scale twice. The plugin therefore uses the Alt variant, which does reach the page. The Shortcut service is not used because Web restricts plugin-declared combinations to a small whitelist (`Mod+Slash`, `Mod+Shift+Comma`, `Mod+Shift+Period` on Linux Web).

## How it works

The plugin sets the CSS `zoom` property on the app shell element (`#root`). `zoom` re-lays-out that subtree at the scaled size, so percentage- and viewport-sized children keep filling the window instead of overflowing; no viewport compensation is needed. Verified from 0.8× to 2.0× at two viewport sizes with no scrollbar growth.

Zooming `#root` rather than the document root is deliberate: dialogs, menus and toasts are portalled to `body` as `position: fixed` siblings of the shell. Zooming the document root scaled those portals too, while their positioning library still measured the unscaled viewport — which pushed them off-screen (the sidebar "More" menu then showed a single clipped row). With `#root` as the target the portals stay correctly anchored and fully usable.

## Known limitations

- Overlay surfaces (menus, dialogs, toasts) are portalled outside the zoomed subtree, so they keep their 100% size while the rest of the interface scales. They stay correctly anchored and usable.
- The preference is per browser origin (`localStorage`), not per Harness profile.
- Scope is the Harness Web UI; it does not affect other sites.
- Disabling or removing the plugin restores the page to 100%.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
