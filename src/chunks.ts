import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { ToolCallProtocol } from './tool-protocol.js';

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update: {
    conversation_id?: string;
    step_index?: number;
    state?: 'ACTIVE' | 'DONE';
    step_type: string;
    text_delta?: string;
    usage?: AgyUsage;
    duration_seconds?: number;
  };
}

export interface AgyResultEvent {
  event: 'result';
  result: {
    conversation_id?: string;
    status: 'SUCCESS' | 'ERROR';
    response?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: AgyUsage;
    error?: {
      code?: string;
      message?: string;
    };
  };
}

export interface AgyInitEvent {
  event: 'init';
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
}

export type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | { event: string; [key: string]: unknown };

export class ChunkEmitter {
  private readonly toolProtocol: ToolCallProtocol;
  private lastInputTokens = 0;
  private lastOutputTokens = 0;
  private lastThinkingTokens = 0;

  constructor(initialBlockIndex = 0) {
    this.toolProtocol = new ToolCallProtocol(initialBlockIndex);
  }

  getToolProtocol(): ToolCallProtocol {
    return this.toolProtocol;
  }

  handleLine(line: string): StreamChunk[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let parsed: AgyEvent;
    try {
      parsed = JSON.parse(trimmed) as AgyEvent;
    } catch {
      // Non-JSON line from process output, skip or ignore
      return [];
    }

    const chunks: StreamChunk[] = [];

    if (parsed.event === 'step_update') {
      const update = (parsed as AgyStepUpdateEvent).step_update;
      if (update.step_type === 'agent_response' && update.text_delta) {
        chunks.push(...this.toolProtocol.processDelta(update.text_delta));
      }
    } else if (parsed.event === 'result') {
      const res = (parsed as AgyResultEvent).result;
      // 1. Flush any buffered text or tool call from the protocol
      chunks.push(...this.toolProtocol.flush());

      // 2. Compute delta usage
      if (res.usage) {
        const currentInput = res.usage.input_tokens ?? 0;
        const currentOutput = res.usage.output_tokens ?? 0;
        const currentThinking = res.usage.thinking_tokens ?? 0;

        const deltaInput = Math.max(0, currentInput - this.lastInputTokens);
        const deltaOutput = Math.max(0, currentOutput - this.lastOutputTokens);
        const deltaThinking = Math.max(0, currentThinking - this.lastThinkingTokens);

        this.lastInputTokens = currentInput;
        this.lastOutputTokens = currentOutput;
        this.lastThinkingTokens = currentThinking;

        const tokenUsage: TokenUsage = {
          inputTokens: deltaInput,
          outputTokens: deltaOutput,
          totalTokens: deltaInput + deltaOutput,
          reasoningTokens: deltaThinking,
        };

        chunks.push({
          type: 'usage',
          usage: tokenUsage,
        });
      }

      // 3. Emit finish reason
      let finishReason: FinishReason;
      if (res.status === 'ERROR') {
        finishReason = {
          kind: 'error',
          failure: {
            message: res.error?.message || 'Antigravity CLI returned error status',
            code: res.error?.code || 'SERVER_ERROR',
          },
        };
      } else if (this.toolProtocol.hasToolCalls()) {
        finishReason = { kind: 'tool-calls' };
      } else {
        finishReason = { kind: 'stop' };
      }

      chunks.push({
        type: 'finish',
        reason: finishReason,
      });
    }

    return chunks;
  }

  handleTerminalError(error: Error, code = 'TRANSPORT'): StreamChunk[] {
    const chunks: StreamChunk[] = [...this.toolProtocol.flush()];
    chunks.push({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: error.message,
          code,
        },
      },
    });
    return chunks;
  }

  handleAbort(): StreamChunk[] {
    const chunks: StreamChunk[] = [...this.toolProtocol.flush()];
    chunks.push({
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: {
          message: 'Generation aborted by caller',
          code: 'ABORTED',
        },
      },
    });
    return chunks;
  }
}
