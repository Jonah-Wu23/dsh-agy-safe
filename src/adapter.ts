import {
  LlmAdapter,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type ReasoningEffortId,
} from '@deepseek-ai/dsh-llm';
import { ModelCatalog } from './models.js';
import { AgySessionManager } from './session.js';
import { ChunkEmitter } from './chunks.js';
import type { AgyPluginConfig } from './config.js';

export class AgyAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalog;
  private readonly sessionManager: AgySessionManager;
  private readonly retryPolicy: ResolvedRetryPolicy;

  constructor(private readonly config: Required<AgyPluginConfig>) {
    super();
    this.catalog = new ModelCatalog(config.agyPath);
    this.sessionManager = new AgySessionManager({
      agyPath: config.agyPath,
      scratchDir: config.scratchDir,
      idleTimeoutMs: config.idleTimeoutMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    });
    this.retryPolicy = resolveRetryPolicy(config.retryPolicy, 'llm-agy: retryPolicy');
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: 'Antigravity CLI',
    };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy;
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.list(provider);
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.catalog.resolve(provider, model, this.config.defaultEffort as ReasoningEffortId);
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { session, prompt } = this.sessionManager.resolvePromptAndSession(options, this.resolveEffort(options));

    // emitter 每轮新建（工具协议缓冲不跨轮），usage 差分基线注入会话级
    // tracker——基线随 AgySession 跨轮持久，与 agy 累计计数器同生命周期。
    const emitter = new ChunkEmitter(0, session);

    try {
      for await (const line of session.streamTurn(prompt, options.signal)) {
        const chunks = emitter.handleLine(line);
        for (const c of chunks) {
          yield c;
        }
      }
    } catch (err: unknown) {
      // dsh-llm 会把迭代器抛错转成唯一的终态 finish chunk；这里先产出本会话的
      // 收尾块（含 ToolCallProtocol 缓冲冲洗）后正常返回，绝不 rethrow，
      // 否则宿主会在已结束的流上再写一份 finish，导致 write EOF。
      if (options.signal?.aborted) {
        for (const c of emitter.handleAbort()) {
          yield c;
        }
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const c of emitter.handleTerminalError(error)) {
          yield c;
        }
      }
    }
  }

  /**
   * 计算出本次生成要传给 agy 的 --effort 值。
   * 目录中无档位变体的模型（如 claude-sonnet-4-6）不能带 --effort，agy 会拒绝；
   * 有档位的模型优先用请求指定档位，未指定时落到配置默认档位。
   */
  private resolveEffort(options: GenerateOptions): string {
    const requested = options.reasoningEffort !== undefined
      ? String(options.reasoningEffort).toLowerCase()
      : undefined;
    const efforts = this.catalog.peekEfforts(options.model);
    if (efforts !== undefined && efforts.length === 0) {
      return requested ?? '';
    }
    return requested ?? this.config.defaultEffort;
  }

  dispose(): void {
    this.sessionManager.dispose();
  }
}
