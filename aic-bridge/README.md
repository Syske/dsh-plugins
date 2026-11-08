# aic-bridge

AIC × DSH 融合项目 —— **A1 插件（S0 骨架 + S1 适配层 + S3.0 最小 Manager 命令入口）**。

本插件是 [A1 实施契约](../../../workspaces/aic-dsh-integration/roadmap/A1-IMPLEMENTATION-CONTRACT.md)
的最小实现：A1 Worker 使用**独立顶层 Agent Session**（与 Manager 主 Session 分离，见 ADR-006），
AIC Adapter **只读**，审批 **fail-closed**。**不 Fork、不修改 DSH Core。**

> 状态（S3.0 + S3.1-B）：
> - **已实现**：插件骨架与适配层（S0/S1）；**最小 Manager 命令入口** `/aic-status`、`/aic <task>`（经 `ctx.commands` 注册）；Manager **显式、fail-closed** 的模型路由（`manager.provider`/`manager.model`，create 与 resume 一致）；命令状态**诚实判定**（需本次 turn 非空 `assistant/message` 且 flush 成功）。
> - **已实现（S3.1-B）**：经 `ctx.storageDomain`（dsh-storage / storage-json / storage-domain）的**持久 TaskRecord**（写前 schema 校验）；**幂等派发**（`taskId` + `payloadHash` 冲突检测）与 **intent-before-send**；Worker 关联（确定性 `workerSessionId`）；崩溃/歧义 **unknown fail-closed、不自动重发**。`completed` 不可达（AIC Evaluator 未实现）。
> - **未实现**（明确占位，不宣称能力）：AIC Evaluator/evidence（`getEvaluation` 抛 `not implemented`）、Control Tower、富 Browser UI（当前以命令入口替代）。
> - **未验证**：真实 Web UI 触发（需装入日常 Web Profile 且具备 GUI 控制能力，当前不具备）、真实 Provider/Worker 闭环、生产环境生命周期时序。

## 目录

```text
aic-bridge/
├── index.js                       # 插件入口：name / inject / Config / apply（装配 + 注册命令 + teardown）
├── cordis.patch.yml               # bundle 挂载声明（仅 insert 本行）
├── src/
│   ├── config.js                  # 纯函数配置/默认值 + validateManagerRoute（fail-closed，可单测）
│   ├── commands.js                # S3.0 命令入口：/aic-status、/aic（状态诚实判定）
│   ├── adapters/
│   │   ├── approval.js            # ApprovalAdapter（封 ctx.approval，fail-closed）
│   │   ├── approval-policy.js     # 审批词表 + 风险策略（纯函数，仅 allowed-once 放行）
│   │   ├── worker-lifecycle.js    # WorkerLifecycleAdapter（封 ctx.agents create/resume/send/whenIdle/flush）
│   │   └── session-persistence.js # SessionPersistenceAdapter（只读 + flush 屏障）
│   ├── manager/
│   │   └── manager-session.js     # Manager canonical Session：稳定身份 create/resume + 模型路由
│   └── aic/
│       ├── read-adapter.js        # AIC 只读 Adapter（接口占位，无网络；getEvaluation 未实现）
│       └── idempotency-store.js   # 持久 TaskRecord + 幂等/关联（Storage Domain 落点，写前校验）
└── test/                          # node:test 纯逻辑/契约单测
```

## 用户入口（S3.0，经 `ctx.commands`）

- `/aic-status`：查询 canonical Manager 状态（模型路由、稳定身份、回复/任务计数）；若尚无则按配置**创建或恢复** Manager。
- `/aic <task text>`：把任务文本发送到 canonical Manager 会话，并**诚实**报告状态：
  `accepted → queued→executed → persisted → replied`。**成功要求本次 turn 存在非空 `assistant/message` 且 flush 成功**；
  空响应 → `failed (no model response)`；无法读取持久化事件 → `unknown`；replied 但 flush 失败 → `NOT persisted`。
  **绝不**因 turn 完成或 flush 成功即报告成功。
- **canonical Manager**：由 `manager.sessionId` 提供**唯一稳定身份**；命令层缓存单一活句柄，重复命令**不重复创建**；当前 UI 会话的 agent **绝不被当作** Manager。

## 模型路由（fail-closed，必须显式配置）

- 配置字段：`manager.provider` + `manager.model`（或环境变量 `AIC_BRIDGE_MANAGER_PROVIDER` / `AIC_BRIDGE_MANAGER_MODEL`）。
- **fail-closed**：两者缺失或仅配置其一 → `/aic-status`、`/aic` **阻止** Manager 创建与任务发送，返回清晰配置错误；**不会**把空配置当作可运行的默认配置。
- 解析出的路由**同时**用于 `ctx.agents.create` 与 `ctx.agents.resume`，恢复时**不改变** Manager 模型身份（无静默漂移）；仅配置一半属**非法配置**，直接抛错。
- 说明：本 Manager 由 `ctx.agents.create` 直接创建，**不会自动采用** Profile 的 `agent-default-model`（该服务仅被宿主入口 `dsh-api-session-controller` / `dsh-headless` 消费），因此**必须**显式配置 `manager.provider/model`。
- 安全：路由仅为 provider/model **名称**，不读取、不写入任何 API Key/凭据。

## 已核实 API 契约（DSH 0.2.1-rc.5，证据 T/S）

- `ctx.agents.create({ sessionId, agentOptions? })` / `ctx.agents.resume({ resumeSessionId, agentOptions? })` → `Promise<AgentHandle>`；省略 `parentAgent` = 顶层；`agentOptions = { provider?, model? }`；`resume` 打开写句柄（**非只读**）。
- `ctx.sessionPersistence.open(id, 'read'|'write')`；`handle.read/append/flush/close`；`read` 不取所有权，`append` best-effort、`flush` 持久化屏障。
- `ctx.approval.request(req)` 需在 open turn；结果 `allowed-once/rejected/cancelled/unavailable`，仅 `allowed-once` 放行；无/异常应答者 → `unavailable`（fail-closed）。
- `ctx.commands.register(def)` / `execute(agent, line, attachments, signal)`：slash 命令注册/执行；`CommandResult = { kind:'success', text? } | { kind:'error', text }`。

详见 A1 契约 §8（含文件:行号）。**类型/源码属实；命令处理器行为已在隔离 Mock 环境验证（见下），真实 Web UI/Provider 未验证。**

## 权限与安全默认

- `aic.readOnly` 恒为 `true`（配置层强制，`resolveConfig` 覆盖）。
- 审批策略默认：`secrets=deny`，`gitPush/npmPublish/githubRelease/externalWrite=ask`，`read/test/build/workspaceWrite/localCommit=auto`；**未知决策一律回退 `ask`**，仅 `allowed-once` 放行。
- 插件不注册任何文件/Git 写工具；不绕过 DSH 审批与沙箱；命令处理不绕过受控自主/审批策略。

## 安装 / 启用（仅已核实步骤）

- 纯 JS（ESM），**无 build 步骤**；`engines.node >= 22`。
- 作为 **bundle** 加入目标 DSH Profile：在其 `package.json` 的 `dsh.profile.bundles` 增加 `aic-bridge`（本包 `dsh.bundle.patch` 指向 `cordis.patch.yml`，仅 insert 本行；不要重复 insert `storage`/`session-projection-cache`，否则 loader 报 `duplicate loader entry id`）。
- 依赖基础服务：目标 Profile 需具备 `@deepseek-ai/dsh-base`（提供 `agents` / `sessions` / `sessionPersistence` / `commands`）。
- 必须配置 `manager.sessionId`、`manager.provider`、`manager.model`（否则 fail-closed 阻止命令）。
- 已验证环境：**隔离 /tmp DSH_HOME + 本地 aic-bridge 副本 + Mock Provider** 下完成加载与命令调用；**未**在日常 Web Profile 安装/启用。

## 本地验证（不联网、不安装依赖）

```bash
node --check index.js
node --test
```

现状：`node --test` 全量 **48 tests / 47 pass / 1 skip**（skip 为 `load-entry` 依赖 schemastery 解析）；真实加载/类型检查需在具备 DSH 依赖的 Profile 下进行。

## 隔离 Mock 验证证据（R）

- 真实挂载最小 DSH 底座：`session` / `session-projection` / `typert-registry` / `system-prompt` / `tools` / `llm` / `agent` / `agent-loop` / `session-persistence-jsonl`（`root=/tmp`）/ `dsh-commands`。
- 注册 `MockAdapter(['mock'])`，配置 `manager.provider=mock, model=mock-model`（无真实 Provider、无外联、无凭据）。
- 真实调用已注册 handler：`/aic-status` 报告 canonical 身份与路由；`/aic <task>` 返回
  `accepted→queued→executed→persisted→replied reply="MOCK_MGR_OK"`；事件回读含 `user/message`、`request/header`、**非空** `assistant/message`；JSONL **真实 flush** 至 /tmp；单一 Manager（`listIds=["…"]`，UI 会话未被创建/占用）。
- 负向：缺路由 → 阻止且不创建 Manager；空响应 → `failed`；flush 失败 → `NOT persisted`。
- **未验证**：真实 Provider/模型、真实 Web UI 输入触发（本机 Web Profile 未启用 aic-bridge，且当前无 GUI/浏览器控制能力）。

## 未解决风险 / pending-validation

1. 真实 Web UI 触发验收（需在启用 aic-bridge 的 Profile + GUI 控制下进行）。
2. 真实 Provider/Worker 端到端闭环（本阶段仅 Mock）。
3. JSONL backend 实际配置与崩溃恢复时序在生产环境的验证。
4. Approval UI 交互（无应答者 fail-closed 已源码确认）。
5. S3.1 持久幂等/关联已落地（Storage Domain）；跨进程并发锁/多写者未验证（单写者部署假设）。
6. AIC 实际只读接口（未核实，无网络代码；`getEvaluation` 未实现）。
7. Bridge 旧版本（0.1.7-rc.2 / 0.2.0-rc.2）与本机 0.2.1-rc.5 兼容性。

## 许可

Apache-2.0（见 [LICENSE](./LICENSE)）。
