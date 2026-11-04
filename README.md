# DSH Plugins

A collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Each plugin lives in its own subdirectory and is independently installable as a DSH
bundle. See each plugin's own README for details.

## Plugins

| Plugin | Description |
| --- | --- |
| [dsh-deepseek-chat](./dsh-deepseek-chat) | Bring `chat.deepseek.com` into the DSH Web GUI as a chat panel: drives the real web app via a browser, reusing your DeepSeek web login session (no API key, no billing). Supports pulling and refreshing complete conversation history. |
| [dsh-ui-zoom](./dsh-ui-zoom) | Whole-interface zoom for the DSH Web GUI: scales the sidebar, buttons, icons and text (50%–200%) from a Settings row, with keyboard shortcuts and a remembered preference. |

## Install a plugin

```bash
# from the plugin directory
dsh plugin --profile web add ./dsh-deepseek-chat
# or, in a session, plugin_manager install_bundle with that directory as target
```

## License

Each plugin carries its own license (see the plugin's `LICENSE`). Unless noted otherwise,
they are Apache-2.0.
