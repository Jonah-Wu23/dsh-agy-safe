# AGENTS.md

## 这个项目是什么

`dsh-agy-safe`：dsh（deepseek harness，`@deepseek-ai/dsh`）的 LLM 提供商插件。把本机已登录的 Antigravity CLI（`agy`）headless 会话接成 dsh 的一级模型提供方，主对话模型与子代理模型通用，体验与 OpenAI 兼容 provider 一致。设计基线见 `docs/plan.md`，改设计先改文档。

## 常用命令

```bash
npm run build          # tsc 编译 src/ → lib/
npm test               # 先编译，再 node --test test/
dsh plugin --profile web add <本目录绝对路径>   # 装进 web profile 联调
```

## 目录约定

- `src/`：TypeScript 源码，一个模块一个文件，模块划分见 `docs/plan.md` 4.2。`src/index.ts` 是宿主入口，`src/client.ts` 是浏览器入口。
- `lib/`：编译产物，不入库，不手改。
- `test/`：纯 JS 单测，import 编译后的 `lib/`，只覆盖纯函数（flattener、协议状态机、指纹链）。
- `docs/plan.md`：需求结论、调研事实、设计、里程碑、验证清单。

## dsh 契约备忘

- 全局 dsh 安装位置：`C:/Users/JonahWu/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh`，真实代码在其下 `node_modules/@deepseek-ai/*`。
- 核心接口：`@deepseek-ai/dsh-llm/lib/types/index.d.ts` 的 `LlmAdapter`（抽象方法只有 `stream(options)`），注册走 `ctx.llm.registerAdapter(['agy'], adapter)`。
- `StreamChunk` 序列：`block-start` → `text-delta` / `reasoning-delta` / `tool-call-delta` → `block-end` → `usage` → `finish`；工具调用块形状 `{type:'tool-call', id, name, arguments: JSON字符串}`。
- settings Schema 没有按钮字段。设置面板交互走插槽：浏览器侧 `ctx.slots.register({name:'settings.section', ...}, Component)`，宿主侧 `ctx.webServer.register` 挂 `/api/dsh-agy/*` 路由，组件同源 fetch 调用。package.json 需要 `exports["./client"]` 和 `dsh.client` 字段，写法照抄参考实现。
- 参考实现：`C:/Users/JonahWu/.dsh/profiles/exp-codex-web/node_modules/@eddyskywalker/dsh-chatgpt-subscription/`（adapter 在 `lib/index.js` 3297 行起，登录设置页在其 `lib/client.js`）。
- 不修改全局 `node_modules` 里的任何 dsh 内部包；契约以 peerDependency 的 `.d.ts` 为准。

## agy 备忘

- 二进制：`agy`（1.1.26，`C:/Users/JonahWu/AppData/Local/agy/bin/agy`）。
- 会话模式：`agy --input-format stream-json --output-format stream-json`，stdin 每行一条 `{"event":"user","message":{"content":"..."}}`，stdout 每行一条事件，每轮以 `result` 事件收尾；`result` 的 `usage`、`num_turns`、`duration_seconds` 是整会话累计值，`response` 才是本轮文本。实测（2026-09-04）：`output_tokens` 包含 `thinking_tokens`，`total_tokens = input_tokens + output_tokens`（不含 cache_read），详见 `docs/plan.md` 第 3 节。
- 关 stdin 即优雅结束会话；畸形输入会让会话立即终止，对照官方文档的错误表处理。
- 作为模型后端的 agy 进程：永远带 `--dangerously-skip-permissions`，cwd 锁在 scratch 目录。
- 登录终端例外：设置页按钮 spawn 的是用户自己的交互式会话，跑纯 `agy`，`detached` 加 `windowsHide: false`，窗口开在用户桌面。

## 工作纪律

- **Let It Fail**：联调失败如实报错，不吞异常，不用兜底文本假装成功，不为跑通测试改生产代码。修复直击根因。
- **Let It Go**：工具调用协议的解析只做语法解析和格式校验，不用正则或关键词去猜模型意图，不维护意图词典。
- 联调一律用真实 dsh `web` profile 加真实 agy 进程；单测只给纯函数，不拿单测冒充联调。
- 全局 AGENTS.md（`C:/Users/JonahWu/.agents/AGENTS.md`）的约束对本项目全部有效。
