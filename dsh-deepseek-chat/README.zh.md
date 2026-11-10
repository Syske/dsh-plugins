# dsh-deepseek-chat

> ## ⚠️ 已归档 —— 请勿使用
>
> **本插件已停止维护，不应再安装使用。** 它通过浏览器自动化与未公开的内部接口驱动
> `chat.deepseek.com`，与《DeepSeek 用户协议》冲突，**可能导致账号被封禁**。
>
> ### 协议禁止的行为
>
> 依据 [DeepSeek 用户协议](https://cdn.deepseek.com/policies/zh-CN/deepseek-terms-of-use.html) 第 3.5 条：
>
> - **3.5（3）** 禁止"以任何方式（包括但不限于通过**任何机器人、爬虫、其他自动设置**、设置镜像）来抓取、复制本服务及其所包含的任何内容"
> - **3.5（1）** 禁止"使用未经许可的数据"
> - **3.5（2）** 禁止"以导致计算机系统或设施承受不合理负载的方式干扰运营"
>
> ### 本插件的冲突点
>
> | 实现方式 | 对应条款 |
> | --- | --- |
> | 用 Playwright 自动填入输入框并按 Enter 发送 | 3.5（3）"其他自动设置" |
> | 包装 `XMLHttpRequest`/`fetch` 并 `tee()` 复制响应流以读取回复 | 3.5（3）"抓取、复制本服务内容" |
> | 读取 `localStorage.userToken`，调用未公开的 `chat/history_messages` 接口批量拉取历史 | 3.5（1）"未经许可的数据" |
> | 启动独立 Chromium profile，在风控看来像自动化客户端 | 3.5（2） |
>
> ### 实际后果
>
> 使用本插件的账号收到了 DeepSeek 的临时封禁（"由于违反用户使用规范，你的账号已被禁言至…"）。
> 具体触发原因未经 DeepSeek 确认，但上述行为是最可能的原因。
>
> ### 请改用官方方式
>
> 使用 [DeepSeek API](https://platform.deepseek.com/)（需 API key，按 token 计费）——官方明确支持、
> 稳定，且不会导致账号被封。若希望直接在 DSH 内使用，任何 OpenAI 兼容的模型服务都可以在
> **设置 → 模型** 中配置。
>
> 代码仅保留作参考学习之用，不再提供支持，也不再跟进 issue。

---

将 [chat.deepseek.com](https://chat.deepseek.com) 集成进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的 Web GUI，作为一个原生聊天面板使用。

它在侧边栏增加一个 **「DeepSeek 网页聊天」** 入口。点开后，在中央栏显示聊天面板，
通过**真实浏览器**（`playwright-core`）驱动 chat.deepseek.com 网页，复用你已有的 DeepSeek
**网页登录会话**——**无需 API key、无 token 计费**，适合日常提问。

> **为什么用真实浏览器而不是 iframe？** `chat.deepseek.com` 响应头带
> `content-security-policy: frame-ancestors 'none'`，明确禁止被任何 iframe 嵌入。
> 因此本插件用 `playwright-core` 启动本地 Chromium 直接驱动页面，复用网页登录态。

## 特性

- **基于网页会话的聊天** —— 无需 API key、无计费；流式回复，支持「深度思考（R1）」与「智能搜索」开关。
- **拉取历史会话** —— 把 chat.deepseek.com 上已有会话导入面板，**内容完整、不截断**
  （通过 DeepSeek 自己的历史接口读取，而非抓 DOM）；可重新导入以**刷新 / 修复**异常会话。
- **原生 UI 集成** —— 注册进内置的 `sidebar.panellist` 与 `main` 插槽；通过主题 token 与
  locale 服务跟随宿主亮/暗主题与中英文。
- **空闲自动关闭** —— 空闲一段时间（默认 5 分钟）后自动关闭 Chromium 释放内存，下次提问自动唤醒；可用 `idleTimeoutMs` 配置。
- **仅回环（loopback-only）** 的 HTTP 接口 —— `/api/dsh-deepseek-chat/*` 路由仅绑定本机，安全。

## 架构

- **Host 半区**（`index.js` + `engine/`、`store.js`、`routes.js`）—— 运行在 Node 宿主进程。
  - `engine/engine.js` —— 用 playwright 驱动 chat.deepseek.com；注入脚本 tee 页面自身的 SSE 流
    （`/api/v0/chat/completion`）以获取完整回复（含 R1 思考过程），DOM 抓取兜底。拉取历史时在页面内
    用 `userToken` 调 `/api/v0/chat/history_messages`。
  - `store.js` —— 本地会话存储（`~/.dsh/dsh-deepseek-chat/transcripts.json`）。
  - `routes.js` —— `/api/dsh-deepseek-chat/*` HTTP 路由（state / open-login / close-browser /
    new-chat / send / stop / deep-think / search / rename / delete / web-chats / recover）。
- **Client 半区**（`client.js`）—— 运行在 Web GUI。注册 `sidebar.panellist` 图标与 `main`
  面板（key `dsh-deepseek-chat`），轮询 `/api/dsh-deepseek-chat/state`，用宿主主题 token
  （`--dsw-alias-*`）渲染聊天界面。

## 首次使用

1. 侧边栏点击 **「DeepSeek 网页聊天」** 图标，打开面板。
2. 点 **「打开登录窗口」** —— 会弹出一个**可见浏览器窗口**，在其中登录 chat.deepseek.com
   （手机号 / 密码 / 扫码均可）。
3. 登录成功后窗口自动关闭，之后聊天在后台无头运行，可正常提问。

## 拉取历史会话

登录后，面板左侧 **「拉取历史」** 按钮会列出你 DeepSeek 网页端已有的全部历史会话。点任意一条导入：

- **内容完整（关键）**：导入时**在页面内直接调用 DeepSeek 自己的历史接口**
  `GET /api/v0/chat/history_messages?chat_session_id=<id>`（Bearer = 页面 localStorage 的
  `userToken`，且**不带 cache 参数**以获得全量），该响应携带完整的 `RESPONSE`（raw markdown）
  与 `THINK`（R1 思考过程）片段——再长的会话也不会被截断（DOM 抓取会被虚拟列表/懒渲染截断，仅作兜底）。
- **去重 / 刷新（修复异常会话）**：按 **web 会话 id（`webId`）** 优先、标题兜底匹配。列表显示
  **全部**网页会话：未导入标「导入」，已导入标「已导入 · 刷新」。对已导入的会话再点一次，会
  **用完整最新内容原地覆盖刷新**（不重复创建），可用于修复以前被截断 / 不完整的异常历史。

## 配置项（可选，写在 profile 的 cordis.patch.yml 该行 config 里）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `browserChannel` | `auto` | 浏览器渠道 `chrome`/`msedge`/`chromium`/`auto` |
| `browserExecutablePath` | `''` | 显式指定浏览器可执行文件路径 |
| `browserProxy` | `direct` | `direct` / `system` / `http://host:port` |
| `browserHeadless` | `true` | 聊天时是否无头（登录窗口始终可见） |
| `replyTimeoutMs` | `180000` | 等待回复上限（毫秒） |
| `dataDir` | `~/.dsh/dsh-deepseek-chat` | 数据目录（浏览器 profile + 会话记录） |
| `idleTimeoutMs` | `300000` | 空闲多久后自动关闭浏览器以释放内存（`0` = 不自动关） |

## 环境要求

- Node.js >= 22
- 一个 Chromium 系浏览器（`playwright-core` 会依次探测 `browserExecutablePath` →
  `browserChannel` → `PLAYWRIGHT_BROWSERS_PATH`/常见缓存下的已下载 Chromium → 系统 Chrome/Edge）。
- 首次登录需要可交互的图形会话。

## 安装 / 卸载

```bash
# 安装（把本地目录作为 bundle 装进 web profile）
dsh plugin --profile web add /path/to/dsh-deepseek-chat
# 或在会话中通过 plugin_manager install_bundle 以该目录为 target
```

卸载：`plugin_manager` `remove_bundle` target=`dsh-deepseek-chat`。

## 已知限制

- 网页端受 DeepSeek 官方风控；页面改版或操作失败时返回错误而非崩溃。
- 密码/会话凭据保存在本地私有 profile 目录，请勿外泄。
- Host 半区的 JS 改动需重启 Harness 生效；Client 半区（`client.js`）改动由 HMR 热更。

## 许可

[Apache-2.0](./LICENSE)。引擎思路参考并部分改编自
[dsh-web-chat](https://github.com/xmuwenxiang/dsh-web-chat)（Apache-2.0），重写并裁剪为
「基础对话 + 历史导入」能力。
