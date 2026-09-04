import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallProtocol } from './tool-protocol.js';
import type { UsageTracker } from './usage.js';

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
    error?: string | {
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
  private readonly usageTracker: UsageTracker;

  /**
   * usage 差分基线由注入的 UsageTracker 持有（生产中是 AgySession，与 agy
   * 进程同生命周期）。emitter 每轮 stream() 新建，绝不能自带跨轮记账状态，
   * 否则复用会话时会把累计 usage 当成本轮增量重复上报。
   */
  constructor(initialBlockIndex: number, usageTracker: UsageTracker) {
    this.toolProtocol = new ToolCallProtocol(initialBlockIndex);
    this.usageTracker = usageTracker;
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

      // 2. Usage：agy 的 result.usage 是会话累计值，差分由会话级 UsageTracker 完成
      if (res.usage) {
        chunks.push({
          type: 'usage',
          usage: this.usageTracker.takeUsageDelta(res.usage),
        });
      }

      // 3. Emit finish reason
      let finishReason: FinishReason;
      if (res.status === 'ERROR') {
        const errorMessage = typeof res.error === 'string'
          ? res.error
          : res.error?.message || 'Antigravity CLI returned error status';
        finishReason = {
          kind: 'error',
          failure: {
            message: errorMessage,
            code: typeof res.error === 'object' && res.error?.code ? res.error.code : 'SERVER_ERROR',
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
