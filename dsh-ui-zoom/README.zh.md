# dsh-ui-zoom

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面提供**整页缩放**。

内置的字号设置只缩放内容文字；本插件缩放**整个界面**——侧边栏、按钮、图标、间距与文字，范围 50%–200%。

## 安装

```bash
dsh plugin --profile web add github:Syske/dsh-ui-zoom
```

或在会话中使用 `plugin_manager` 的 `install_bundle`，目标为本仓库目录。

安装后**刷新一次** Web 页面，以加载新的 Client 模块。

## 功能

- **设置 → 通用 → 界面缩放**：滑块 + −/+ 步进 + 实时百分比 + 重置。
- **快捷键**：`Ctrl/Cmd + Alt + =` 放大，`Ctrl/Cmd + Alt + -` 缩小，`Ctrl/Cmd + Alt + 0` 重置为 100%。
- **记住偏好**：存于浏览器，加载时自动恢复。
- **跨标签页同步**：一个标签页改了缩放，其他标签页同步。

## 兼容性

- **DSH**：在 `0.2.1-rc.5`（Web profile）上验证。`apply(ctx)` 契约稳定，但注册的 `ctx` 能力在预览版之间可能变化。
- **平台**：仅 Web（`dsh.client.platform = "web"`），未针对 Desktop 外壳。
- **浏览器**：需支持 CSS `zoom` 属性（Chromium、Safari、Firefox 126+）。使用 `Ctrl/Cmd + Alt` 而非浏览器自身的缩放键。
- **Node**：`>= 22`（用于 bundle 的 Host 半边）。
- **依赖**：无。不访问网络、不依赖外部服务、不需要任何凭证。

## 权限与范围

- 插件只修改应用外壳节点（`#root`）的 CSS `zoom` 属性。
- 在 Harness 源下读写一个 `localStorage` 键（`dsh-ui-zoom.factor`）。
- 为上述快捷键添加一个 keydown 监听，卸载时移除。
- 在 **设置 → 通用** 注册一行偏好项。
- 不触碰文件、进程、网络，无遥测。

## 为什么用 Alt 修饰键

`Ctrl/Cmd +` / `-` / `0` 是**浏览器自身**的缩放快捷键，网页无法拦截——绑定它们会导致双重缩放。因此本插件使用 Alt 变体，按键才能真正到达页面。未使用快捷键服务，是因为 Web 端对插件声明的组合有白名单限制（Linux Web 仅允许 `Mod+Slash`、`Mod+Shift+Comma`、`Mod+Shift+Period`）。

## 实现原理

插件在应用外壳节点（`#root`）上设置 CSS `zoom` 属性。`zoom` 会按缩放后的尺寸重新布局该子树，因此百分比尺寸与视口尺寸的子元素仍能填满窗口而不会溢出，无需额外的视口补偿。已在 0.8×–2.0×、两种视口尺寸下实测无滚动条增长。

**特意缩放 `#root` 而非文档根节点**：对话框、菜单与提示条都是以 `position: fixed` 挂到 `body` 的 portal，与外壳同级。若缩放文档根节点，这些 portal 也会被缩放，而定位库仍按未缩放的视口测量坐标，结果被推到屏幕外——左下角「更多」菜单因此只剩一行可见。以 `#root` 为缩放目标，portal 保持正确锚定、完全可用。

## 已知限制

- 浮层（菜单、对话框、提示条）位于被缩放子树之外，因此保持 100% 尺寸，不随界面一起放大；它们仍能正确锚定并正常使用。
- 偏好按浏览器源（`localStorage`）保存，不随 Harness profile 走。
- 仅作用于 Harness Web 界面，不影响其他站点。
- 禁用或移除插件会把页面恢复为 100%。

## 许可证

Apache-2.0 — 见 [LICENSE](./LICENSE)。
