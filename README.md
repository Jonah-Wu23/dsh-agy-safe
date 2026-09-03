<p align="center">
  <h1 align="center">dsh-agy-safe</h1>
</p>

<p align="center">
  <strong>Antigravity CLI 模型提供商插件</strong>
</p>

<p align="center">
  DeepSeek Harness 的本地 Antigravity CLI 无头会话接入层
</p>

<p align="center">
  <a href="https://github.com/Jonah-Wu23/dsh-agy-safe/releases"><img src="https://img.shields.io/badge/version-v0.1.0-blue" alt="Version 0.1.0" /></a>
  <img src="https://img.shields.io/badge/platform-DSH%20%7C%20Node.js%20ESM-2F5D50" alt="Platform" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-5B6C8F" alt="MIT License" /></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-E8B25C" alt="dsh-plugin" /></a>
</p>

<p align="center">
  <a href="#30-秒了解">30 秒了解</a> ·
  <a href="#核心特性">核心特性</a> ·
  <a href="#架构设计">架构设计</a> ·
  <a href="#快速上手">快速上手</a> ·
  <a href="#仓库结构">仓库结构</a> ·
  <a href="LICENSE">许可协议</a>
</p>

## 30 秒了解

**dsh-agy-safe 将本机已登录的 Antigravity CLI（agy）无头会话接入 DeepSeek Harness，作为一级模型提供方。主对话与子代理均可调用该提供方，保持一致的流式生成与工具分发体验。**

插件为本地 CLI 提供面向 Harness 平台的适配能力：

- **无头会话桥接**：以子进程管道连接 agy 的流式交互，由 Harness 统一驱动智能体循环。
- **工具调用适配**：向模型注入工具契约，解析结构化标记并回传执行结果。
- **历史指纹管理**：维护会话哈希链，检测上下文分叉并按需重放完整历史。
- **系统终端唤起**：设置界面提供凭据引导，调用原生终端完成登录交互。

## 核心特性

| 维度 | 原生 HTTP 提供商 | dsh-agy-safe |
| --- | --- | --- |
| 认证机制 | 依赖远程 API Key | 复用本机 CLI 登录态 |
| 运行位置 | 远端模型服务 | 本地沙盒子进程 |
| 工具分发 | 平台原生支持 | 结构化标记解析与双向转换 |
| 会话维护 | 无状态 HTTP 往返 | 常驻长连接结合哈希分叉重建 |

## 架构设计

插件采用模块化分层架构，适配 DeepSeek Harness 生态：

```text
┌─────────────────────────────────────────────┐
│ DSH Agent Runtime / Subagents / Web UI      │  上层应用：模型选择与智能体调用回路
├─────────────────────────────────────────────┤
│ AgyAdapter (LlmAdapter 实现)                │  适配核心：统一模型流式分发与用量统计
├─────────────────────────────────────────────┤
│ ToolCallProtocol / TranscriptFlattener      │  协议解析：结构化工具标记与历史指纹链
├─────────────────────────────────────────────┤
│ AgySessionManager / ChildProcess Pool       │  进程管理：进程生命周期与异常重放
├─────────────────────────────────────────────┤
│ Antigravity CLI (agy 1.1.22)                │  底层模型：本地无头流式会话
└─────────────────────────────────────────────┘
```

### 运行流程

1. **会话解析**：接收生成请求后，系统比对传入消息与常驻进程的历史哈希链。
2. **增量调度**：历史前缀一致时仅发送增量输入；若发生上下文分叉，系统重置子进程并重放完整记录。
3. **输出转换**：逐行解析输出事件，将文本增量与工具调用请求转换为标准数据块。
4. **状态反馈**：任务完成时汇总输入输出用量，向调用方提供终止状态。

## 快速上手

**兼容性**：插件适配 dsh v0.1.2-rc.1 的 Web 界面，运行环境需具备 Node.js 20 及更高版本。

### 一行命令安装

在 DeepSeek Harness 环境中执行安装命令：

```bash
dsh plugin --profile web add dsh-agy-safe
```

发布到 npm 的包里已含编译产物 `lib/`（`npm publish` 经 `prepare` 自动构建），单条命令即可安装，无需其他配置。

如需使用本地源码路径联调：

```bash
dsh plugin --profile web add <本地仓库路径>
```

> 本地仓库与 `github:` 源不包含 `lib/`（构建产物不入库）：`github:` 安装依赖 pnpm 执行 `prepare` 构建，若 pnpm 提示忽略了 `dsh-agy-safe` 的构建脚本，需在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 中放行（`dsh-agy-safe@0.1.0: true`）后重新安装。

安装完成后重新启动服务：

```bash
dsh web
```

### 登录与凭据配置

1. 打开 Web 控制面板，进入「设置」中的「Antigravity CLI」专页。
2. 点击「打开登录终端」按钮，系统会调起桌面终端运行登录命令。
3. 完成登录后，点击「验证登录凭据」确认会话状态。
4. 在模型列表中选择 `agy` 分组下的模型即可开始交互。

## 仓库结构

| 目录与文件 | 说明 |
| --- | --- |
| `src/adapter.ts` | 继承 `LlmAdapter`，实现模型路由与流式转换。 |
| `src/session.ts` | 维护子进程池，处理分叉检测与生命周期。 |
| `src/tool-protocol.ts` | 增量状态机，处理工具调用标记的语法解析。 |
| `src/flatten.ts` | 历史消息压平与状态哈希计算。 |
| `src/models.ts` | 模型目录定义与思考等级映射。 |
| `src/chunks.ts` | 进程事件流到 Harness 数据块的格式映射。 |
| `src/login.ts` | 原生终端唤起与凭据可用性探测。 |
| `src/client.ts` | 前端设置面板的交互组件。 |
| `test/` | 面向协议状态机与纯函数的单元测试套件。 |

## 参与项目

欢迎提交 Issue 或 Pull Request。本地运行测试命令：

```powershell
npm test
```

## 许可协议

本项目采用 [MIT License](LICENSE) 开源许可协议。版权所有 © 2026 Jonah Wu。
