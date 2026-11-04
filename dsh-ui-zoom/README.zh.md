# dsh-ui-zoom

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面提供**整页缩放**。

内置的字号设置只缩放内容文字；本插件缩放**整个界面**——侧边栏、按钮、图标、间距与文字，范围 50%–200%。

## 功能

- **设置 → 通用 → 界面缩放**：滑块 + −/+ 步进 + 实时百分比 + 重置。
- **快捷键**：`Ctrl/Cmd + Alt + =` 放大，`Ctrl/Cmd + Alt + -` 缩小，`Ctrl/Cmd + Alt + 0` 重置为 100%。
- **记住偏好**：存于浏览器，加载时自动恢复。
- **跨标签页同步**：一个标签页改了缩放，其他标签页同步。

## 为什么用 Alt 修饰键

`Ctrl/Cmd +` / `-` / `0` 是**浏览器自身**的缩放快捷键，网页无法拦截——绑定它们会导致双重缩放。因此本插件使用 Alt 变体，按键才能真正到达页面。未使用快捷键服务，是因为 Web 端对插件声明的组合有白名单限制（Linux Web 仅允许 `Mod+Slash`、`Mod+Shift+Comma`、`Mod+Shift+Period`）。

## 实现原理

插件在文档根节点设置 CSS `zoom` 属性。`zoom` 会按缩放后的尺寸重新布局，因此百分比尺寸与视口尺寸的子元素仍能填满窗口而不会溢出，无需额外的视口补偿。已在 0.8×–2.0× 实测无滚动条增长。

## 安装

```bash
# 在本目录执行
dsh plugin --profile web add ./dsh-ui-zoom
```

或在会话中用 `plugin_manager` 的 `install_bundle`，目标为该目录。安装后**刷新一次** Web 页面，以加载新的 Client 模块。

## 说明

- 仅作用于 Harness Web 界面，不影响其他站点。
- 偏好按浏览器源（`localStorage`）保存，不随 Harness profile 走。
- 禁用或移除插件会把页面恢复为 100%。

## 许可证

Apache-2.0 — 见 [LICENSE](./LICENSE)。
