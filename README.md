# DSH Plugins

A collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Each plugin lives in its own subdirectory and is independently installable as a DSH
bundle. See each plugin's own README for details.

## Plugins

| Plugin | Status | Description |
| --- | --- | --- |
| [dsh-ui-zoom](./dsh-ui-zoom) | Active | Whole-interface zoom for the DSH Web GUI: scales the sidebar, buttons, icons and text (50%–200%) from a Settings row, with keyboard shortcuts and a remembered preference. |
| [dsh-deepseek-chat](./dsh-deepseek-chat) | **Archived** | Brings `chat.deepseek.com` into the DSH Web GUI by driving the real web app through a browser. **Do not use**: it conflicts with the DeepSeek Terms of Use (clause 3.5) and can get your account suspended. Kept for reference only. |

## Why `dsh-deepseek-chat` is archived

It reused a free DeepSeek **web login** instead of an API key, which required browser
automation, response-stream interception, and an undocumented history endpoint. Those
are exactly the behaviours the [DeepSeek Terms of Use](https://cdn.deepseek.com/policies/zh-CN/deepseek-terms-of-use.html)
prohibit in clause 3.5, and an account using the plugin received a temporary
suspension. Use the official [DeepSeek API](https://platform.deepseek.com/) or any
OpenAI-compatible provider configured in **Settings → Models** instead.

## Install a plugin

```bash
# from the plugin directory
dsh plugin --profile web add ./dsh-ui-zoom
# or, in a session, plugin_manager install_bundle with that directory as target
```

## License

Each plugin carries its own license (see the plugin's `LICENSE`). Unless noted otherwise,
they are Apache-2.0.
