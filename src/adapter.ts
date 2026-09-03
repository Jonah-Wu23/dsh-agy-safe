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
    this.catalog = new ModelCatalog(config.models);
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
    const { session, prompt } = this.sessionManager.resolvePromptAndSession(
      options,
      this.config.defaultEffort,
    );

    const emitter = new ChunkEmitter(0);

    try {
      for await (const line of session.streamTurn(prompt, options.signal)) {
        const chunks = emitter.handleLine(line);
        for (const c of chunks) {
          yield c;
        }
      }
    } catch (err: unknown) {
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
      throw err;
    }
  }

  dispose(): void {
    this.sessionManager.dispose();
  }
}
