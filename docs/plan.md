# dsh-agy-safe 计划文档

## 1. 背景与目标

dsh（deepseek harness，npm 包 `@deepseek-ai/dsh`，全局安装）的模型提供方走 OpenAI 兼容 HTTP API（`~/.dsh/settings.yaml` 的 `llm-pi-ai.providers`）。本项目做一个插件，把本机已登录的 Antigravity CLI（agy 1.1.22）的 headless 模式接成 dsh 的一级模型提供方：主对话模型和子代理模型都能选它，使用体验与 deepseek-v4-flash 这类官方 provider 完全一致，并兼容 dsh-web 全包。

- npm 包名：`dsh-agy-safe`（无 scope，最终发布到 npm）
- 项目目录：`E:\AI\dsh-agy-safe`
- 首次安装目标：dsh 的 `web` profile

## 2. 需求对齐结论

苏格拉底式问答的收敛结果：

| 问题 | 结论 |
| --- | --- |
| agy 扮演什么角色 | 纯模型。只输出文本与思考，不执行工具；dsh 保持唯一代理循环 |
| 工具调用 | 完整 function calling。dsh 注入工具定义，agy 按约定格式返回调用请求，dsh 执行并回喂结果 |
| 会话映射 | 混合模式。常驻 agy 进程，历史指纹分叉检测，分叉时全量重放重建 |
| 模型暴露 | 多 slug 可选；思考强度像原生 provider 一样在 dsh UI 里选（low / medium / high） |
| 权限 | agy 永远带 `--dangerously-skip-permissions`，agy 侧零弹窗；批准与审核全部发生在 dsh 侧 |
| 登录入口 | 设置面板提供 Antigravity CLI 专页，一个按钮打开系统终端跑交互式 agy 完成登录，页内显示登录状态 |
| 分发 | 本目录开发，npm 发布取向；首次装进 `web` profile |

## 3. 技术调研结论

以下路径均相对 `C:/Users/JonahWu/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/`。

- `llm-pi-ai` 的 `api` 字段只认 `openai-completions` / `openai-responses` / `anthropic-messages` 三个 HTTP 协议，私有 `PROTOCOLS` 表封闭，不能通过 settings.yaml 加新方言。
- 正确路径：实现 `@deepseek-ai/dsh-llm` 的 `LlmAdapter`（唯一抽象方法 `stream(options): AsyncIterable<StreamChunk>`），用 `ctx.llm.registerAdapter(['agy'], adapter)` 注册。主模型、子代理、Web UI 自动兼容。
- 活样板：`C:/Users/JonahWu/.dsh/profiles/exp-codex-web/node_modules/@eddyskywalker/dsh-chatgpt-subscription/`（`CodexChatGptAdapter`，`lib/index.js` 3297–3366 行；登录 UI 见下一条）。
- `StreamChunk` 序列：`block-start` → `text-delta` / `reasoning-delta` / `tool-call-delta` → `block-end` → `usage` → `finish`。工具调用块的形状是 `{type:'tool-call', id, name, arguments: JSON字符串}`，harness 层不流通 OpenAI 原生 `tool_calls` 对象。
- 子代理走同一注册表（`dsh-subagent` 的 `resolveChildAgentOptions`，默认继承父 agent 的 provider / model / reasoningEffort），adapter 注册后无需额外接线。
- dsh-web 全包（`dsh-web-app` / `dsh-web-frontend` / `dsh-client-*` / `dsh-api-session-controller`）消费的模型目录、流式 chunk、usage、effort 选择器全部来自 adapter 契约。再注册 `registerConfigurableProviders` 和 `settings.installSection`，设置页 Models 才能显示和编辑本 provider。
- settings 的 schemastery Schema 没有任何按钮或 action 字段类型。设置面板的自定义交互走插槽：客户端 `ctx.slots.register({name:'settings.section', id, order, label}, Component)` 注册整页 React 组件，宿主侧 `ctx.webServer.register` 挂 `/api/<插件前缀>` 路由，组件用同源 `fetch` 调用。样板插件的登录页 `CodexSubscriptionSection`（其 `lib/client.js` 330 行起）和 `registerRoutes`（其 `lib/index.js` 2623 行起）就是这套结构。
- dsh-web 没有可复用的浏览器终端组件，`dsh-terminal` 是宿主内部 PTY 注册表，没有浏览器渲染面。登录终端只能 spawn 系统终端窗口。
- `settings.yaml` 里现有的 `agent-default-model: deepseek-official/deepseek-v4-flash` 不动，agy 作为新增 provider 出现。

## 4. 总体设计

### 4.1 架构

标准 cordis 插件，TypeScript 编译为 ESM（`lib/`）。分宿主侧和浏览器侧两个入口：

- 宿主侧入口 `src/index.ts` 导出 `name = 'llm-agy'`、`inject = ['llm', 'settings', 'webServer']`（inject 清单以样板插件为准再核对）、`apply(ctx, config)`。
- 浏览器侧入口 `src/client.ts`，经 package.json 的 `exports["./client"]` 和 `dsh.client` 字段注入（字段写法 M1 时照抄样板插件）。

宿主侧 `apply` 内完成四件事：

1. `ctx.llm.registerAdapter(['agy'], new AgyAdapter(...))`
2. `ctx.llm.registerConfigurableProviders([{provider:'agy', displayName:'Antigravity CLI', settingsNs:'llm-agy', settingsPath:'providers'}])`
3. `settings.installSection(ctx, 'llm-agy', Schema, 默认配置, hooks)`
4. `ctx.webServer.register` 挂 `/api/dsh-agy/status`（GET）和 `/api/dsh-agy/login`（POST）两个路由

浏览器侧 `apply` 完成一件事：`ctx.slots.register({name:'settings.section', id:'agy', order:45, label:'Antigravity CLI'}, AgySection)`。

设置段 `llm-agy` 的字段：`agyPath`（默认 `'agy'`）、`defaultEffort`（默认 `'medium'`）、`scratchDir`（默认 `~/.dsh/llm-agy/scratch`）、`idleTimeoutMs`、`streamIdleTimeoutMs`、`retryPolicy`（模型目录由 `agy models` 动态提供，不在设置段里）。

### 4.2 组件

| 文件 | 模块 | 职责 |
| --- | --- | --- |
| `src/index.ts` | 宿主入口 | `apply()` 装配与注销 |
| `src/adapter.ts` | `AgyAdapter` | 实现 `LlmAdapter`：`stream`、`listModels`、`resolveModelInfo`、`providerRetryPolicy` |
| `src/session.ts` | `AgySessionManager` | 常驻 agy 进程池、指纹分叉检测与重建、崩溃恢复、空闲回收 |
| `src/flatten.ts` | `TranscriptFlattener` | dsh 的 `system/messages/tools` 压平为 agy user 消息；历史哈希指纹链 |
| `src/tool-protocol.ts` | `ToolCallProtocol` | 工具调用提示词注入模板 + 增量解析状态机 |
| `src/models.ts` | `ModelCatalog` | agy slug 清单、contextWindow 表、reasoning efforts 元数据 |
| `src/chunks.ts` | `ChunkEmitter` | agy NDJSON 事件转 dsh `StreamChunk` |
| `src/config.ts` | 设置段 | settings Schema 与默认值 |
| `src/login.ts` | 登录管理 | `/api/dsh-agy/*` 路由 handler：spawn 系统终端跑交互式 agy、探测 agy 存在性与登录状态 |
| `src/client.ts` | 浏览器入口 | 注册 `settings.section` 页：登录按钮、状态行、错误条 |

### 4.3 一次请求的数据流

1. dsh agent 循环调 `adapter.stream(options)`，`options` 里有全量 `system/messages/tools`、`reasoningEffort`、`signal`。
2. `AgySessionManager` 按会话键找常驻进程。进程不存在或指纹分叉，则 kill 旧进程、spawn 新进程（`agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions --model <slug> --effort <e>`，cwd 锁定 scratch 目录），首条消息发送压平后的全量历史。进程健在且指纹一致，只发送增量消息（新的 user 输入和 tool-result）。
3. agy 的 NDJSON 输出逐行解析：`step_update` 里 `agent_response` 的 `text_delta` 交给 `ToolCallProtocol` 增量解析，分流为 `text-delta` 或 `tool-call-delta`。
4. `result` 事件映射为 `usage` chunk（agy 的 usage 是累计值，插件存上次累计值算本轮差值）和 `finish` chunk。
5. `options.signal` 触发 abort 时 kill 进程，按 `LlmError('...', 'ABORTED')` 收尾，下次请求自动重建会话。

### 4.4 设置页与登录入口

- 设置面板出现「Antigravity CLI」专页（`settings.section` 插槽，order 取 45，落在模型相关页附近）。页面内容：agy 探测结果（路径、版本）、登录状态行、「打开登录终端」按钮、错误条。
- 点按钮 → 同源 `POST /api/dsh-agy/login` → 宿主 spawn 一个可见的系统终端窗口跑纯交互式 `agy`（登录场景不带 `--dangerously-skip-permissions`）。Windows 下用 `cmd.exe /c start "" cmd /k agy`，`detached: true` 且 `windowsHide: false`，spawn 后 `unref()` 不阻塞宿主。dsh host 默认只监听 127.0.0.1，窗口就开在用户本机桌面。
- 登录状态探测分两档：页面加载时只查 agy 二进制存在性、版本、凭据缓存文件是否在位，快速返回；用户点「验证登录」才真实跑一次 `agy -p` 短请求确认凭据有效（这个调用消耗一次模型请求，所以做成显式动作）。
- 状态轮询：组件每隔几秒拉一次 `/api/dsh-agy/status`，登录窗口关闭后状态自动翻新。
- 宿主路由照抄样板的防护：同源校验、JSON body 上限、`{ok, value}` / `{ok:false, error:{code, message}}` 信封。
- 兜底：spawn 失败（比如无桌面环境）时状态区给出可复制的手动命令，让用户自己开终端跑 `agy`。

### 4.5 工具调用线协议

- 系统提示中注入工具清单（name + description + JSON Schema）和输出约定：模型要调工具时输出带唯一 sentinel 的围栏块，内容为 `{"name": "...", "arguments": {...}}`，一条回复可含多个块；块外文本即正常回复。
- `ToolCallProtocol` 是增量状态机，三个状态：正文、疑似围栏、围栏内。流结束时未闭合的围栏按纯文本透传；围栏内 JSON 校验失败同样按纯文本透传。模型输出了什么就呈现什么，不伪造调用成功。
- tool-call 的 `id` 由插件生成（agy 不提供），格式 `agy_tc_<会话内序号>`。

### 4.6 安全

- 作为模型后端的 agy 进程永远带 `--dangerously-skip-permissions`，agy 侧不出现任何权限弹窗，工具审核全部在 dsh 侧完成。
- agy 子进程（模型后端与 `--version`/`-p` 探测）只继承最小环境白名单：PATH、SystemRoot、USERPROFILE、HOME、TEMP/APPDATA 等 Windows 基础变量 + `AGY_*`/`AV_*` 前缀变量。宿主环境里的密钥类变量不会进入模型后端进程（`printenv` 读不到）。交互式登录终端例外：那是用户自己的窗口，环境与手动开终端一致。
- `ToolCallProtocol` 的未闭合工具块缓冲有上限（默认 256KB）：`<<<TOOL_CALL>>>` 后迟迟不来 `<<<END_TOOL_CALL>>>` 时，超过上限后整块按文本透传并回到文本状态，杜绝无界内存增长。
- 模型后端的 agy 进程 cwd 固定为 scratch 目录，绝不指向用户项目目录。模型即使无视提示词约束调用了 agy 自身工具，文件写入也只会落在 scratch 里。
- 提示词层再声明一遍不要使用任何内置工具，作为第一道约束。
- 登录终端是用户自己的交互式会话，不适用以上两条，行为与用户手动打开终端跑 `agy` 完全相同。

### 4.7 模型目录与思考强度

- `listModels` 运行时执行一次 `agy models`（stdout 为 `id\t名称` 数据行，spinner 走 stderr），严格解析后按基础模型归组：`-low/-medium/-high` 后缀且显示名匹配 ` (Low)/(Medium)/(High)` 的条目合并为同一基础模型，档位集合为该模型实际存在的档位（如 `gemini-3.1-pro` 只有 low/high；claude 系无档位）。带 5 分钟 TTL 缓存；agy 缺失或命令失败原样抛错，不伪造清单。
- agy 模型的档位信息在 `--model` 的裸 id（如 `gemini-3.8-flash`）+ `--effort` 传递，已实测：裸 id 合法，组合档位合法；**无档位模型（claude 系）传 `--effort` 会被 agy 以 `invalid model selection` 拒绝**，因此这类模型在 resolve 结果里不声明 reasoning（UI 不出现 effort 选择器），spawn 时也不带 `--effort`。
- `contextWindow` 用官方 Model Card 数字按基础模型硬编码（Gemini 3.x 全系 1,048,576；Claude 4.6 双子 1,000,000；GPT-OSS 120B 131,072；thinking 档位不改变上下文窗口），表外的模型省略该字段；未知模型回退全档位 + 配置默认 effort。
- `spawn('agy', ['models'])` 必须 `stdio: ['ignore', 'pipe', 'pipe']`：agy 在 stdin 为打开的管道时会挂起等待 EOF（Windows 实测）。
- 设置段无 `models` 字段（目录完全来自 agy models 输出）。

### 4.8 错误与中止

- agy 非零退出或 `status: ERROR` 映射为 `LlmError` 分类：未登录 → `AUTH`（报错文案引导用户到设置页点登录按钮）、未知 slug → `INVALID_REQUEST`、超时 → `TIMEOUT`、进程传输故障 → `TRANSPORT`。
- `providerRetryPolicy` 只对 `TIMEOUT`、`TRANSPORT`、`RATE_LIMIT`、`SERVER` 开放重试。
- 空闲看门狗：流超过 `idleTimeoutMs` 无事件则 kill 进程并报 `TIMEOUT`。
- adapter 的 `stream()` 出错时先 yield 本会话收尾块（含 ToolCallProtocol 缓冲冲洗）后**正常返回，不得 rethrow**：dsh-llm 会把迭代器抛错再转成一份终态 finish chunk，双信号会在已结束的流上二次写出（实测宿主演化为未处理的 `write EOF` 崩溃）。

## 5. 里程碑

- **M0 spike（最先做）**：用真实 agy 1.1.22 驱动 stream-json 会话，验证五件事：注入工具约定后模型是否守规矩、thinking 是否有独立 delta、slug 后缀与 `--effort` 是否互斥、stdin 会话模式下 `--print-timeout` 是否生效、登录状态用什么方式探测最省钱（凭据文件路径与格式）。产出实测记录，校准 4.5 和 4.7 的设计。
- **M1 核心实现**：按 4.2 的模块表完成全部源码，含浏览器侧 `client.ts` 和 package.json 的 client 入口字段。
- **M2 纯函数单测**：`flatten.ts`、`tool-protocol.ts`、指纹链。测试跑在编译产物上，不给生产代码打补丁。
- **M3 真实联调**：装进 `web` profile，按第 6 节清单逐项过。
- **M4 发布**：补 README，`npm pack` 检查产物，发布 npm。

## 6. 端到端验证清单

1. `web` profile 设置页 Models 出现 Antigravity CLI 分组；聊天界面模型下拉可选各 slug，effort 选择器可选 low / medium / high。
2. 设置面板出现「Antigravity CLI」专页，点「打开登录终端」弹出系统终端窗口跑交互式 agy；完成登录后状态行自动翻新；未登录时状态行如实显示。
3. 纯文本流式对话，前端逐字渲染。
4. 单工具调用闭环：模型请求工具，dsh 执行，结果回喂，模型继续输出。
5. 一条回复里多个工具调用，全部正确分发执行。
6. 长会话触发 dsh 压缩后对话继续正常，分叉检测与重建生效。
7. 流式中途 abort，agy 进程被杀，会话可继续。
8. 子代理继承 agy provider 完成任务。
9. 用量面板显示 input / output / cache / thinking token。
10. 模型会话全程 agy 无权限弹窗；检查 scratch 目录之外无意外文件写入。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 模型不守工具调用约定 | sentinel 块设计加容错透传；M0 先测模型服从度，服从度差就限定推荐 slug |
| agy 内部工具被触发而写文件 | cwd 锁定 scratch 目录，爆炸半径收在沙盒内 |
| 分叉检测失效导致上下文错乱 | 指纹链采取保守策略，拿不准一律重建会话 |
| agy 不输出 thinking 内容 | UI 至少能在用量里展示 `reasoningTokens`，设计不依赖 thinking 文本 |
| 无桌面环境下登录终端弹不出来 | spawn 失败时设置页给出手动命令兜底文案 |
| dsh 升级导致 adapter 契约变化 | 契约类型来自 peerDependency 的 `.d.ts`，编译期即可发现破坏 |
