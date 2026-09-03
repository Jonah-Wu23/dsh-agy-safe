import type { ContentBlock, StreamChunk, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm';

export const TOOL_CALL_START = '<<<TOOL_CALL>>>';
export const TOOL_CALL_END = '<<<END_TOOL_CALL>>>';

export function buildToolSystemPrompt(tools: readonly ToolSchema[]): string {
  if (tools.length === 0) return '';

  const toolDescriptions = tools.map((tool) => {
    return [
      `- **${tool.name}**: ${tool.description || 'No description'}`,
      `  Parameters: ${JSON.stringify(tool.parameters)}`,
    ].join('\n');
  }).join('\n\n');

  return [
    '# Tool Use Rules',
    'You have access to the following external functions/tools provided by the environment:',
    toolDescriptions,
    '',
    'When you need to call one or more tools, you MUST emit the call in this exact block format:',
    TOOL_CALL_START,
    '{"name": "<tool_name>", "arguments": {<json_arguments>}}',
    TOOL_CALL_END,
    '',
    'Rules:',
    '1. You may write natural explanations before or after the tool call blocks.',
    '2. Arguments MUST be valid JSON matching the parameters schema.',
    '3. Do NOT execute tools yourself or invent simulated results. Emit the call block and wait for the harness to return the real results.',
    '4. Do NOT call built-in Antigravity CLI tools (like view_file, run_command, etc.) directly; only use the specified tools defined above.',
    '5. Do NOT create, update, or rewrite conversation goals (goal tools such as create_goal) unless the human user explicitly asks for one. Ordinary conversation needs no goal; never infer goal intent from a plain user message.',
  ].join('\n');
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown> | string;
}

export class ToolCallProtocol {
  private buffer = '';
  private inToolCall = false;
  private currentBlockIndex = 0;
  private isTextBlockOpen = false;
  private toolCallCount = 0;
  private accumulatedText = '';
  private toolCallsEmitted: ContentBlock[] = [];

  constructor(
    private readonly initialBlockIndex = 0,
    private readonly maxToolCallBuffer = 262_144,
  ) {
    this.currentBlockIndex = initialBlockIndex;
  }

  getEmittedToolCalls(): readonly ContentBlock[] {
    return this.toolCallsEmitted;
  }

  hasToolCalls(): boolean {
    return this.toolCallsEmitted.length > 0;
  }

  processDelta(delta: string): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    this.buffer += delta;

    while (this.buffer.length > 0) {
      if (!this.inToolCall) {
        const startIndex = this.buffer.indexOf(TOOL_CALL_START);
        if (startIndex === -1) {
          // Check for partial match at the tail of the buffer
          const partialLen = this.findPartialMatch(this.buffer, TOOL_CALL_START);
          if (partialLen > 0) {
            const emitLen = this.buffer.length - partialLen;
            if (emitLen > 0) {
              const textToEmit = this.buffer.slice(0, emitLen);
              chunks.push(...this.emitText(textToEmit));
              this.buffer = this.buffer.slice(emitLen);
            }
            break; // wait for more input
          } else {
            // No partial match, emit entire buffer
            chunks.push(...this.emitText(this.buffer));
            this.buffer = '';
            break;
          }
        } else {
          // Emitting text before the tool call delimiter
          if (startIndex > 0) {
            const textToEmit = this.buffer.slice(0, startIndex);
            chunks.push(...this.emitText(textToEmit));
          }
          // Close active text block before tool call
          if (this.isTextBlockOpen) {
            chunks.push(this.closeTextBlock());
          }
          this.inToolCall = true;
          this.buffer = this.buffer.slice(startIndex + TOOL_CALL_START.length);
        }
      } else {
        // We are inside a tool call block, looking for TOOL_CALL_END
        const endIndex = this.buffer.indexOf(TOOL_CALL_END);
        if (endIndex === -1) {
          if (this.buffer.length > this.maxToolCallBuffer) {
            // 未闭合块超过缓冲上限：按 EOF 未闭合的同一语义整体透传为文本，
            // 回到文本状态继续解析后续 delta，不让内存无界增长。
            chunks.push(...this.emitText(`${TOOL_CALL_START}${this.buffer}`));
            this.buffer = '';
            this.inToolCall = false;
            continue;
          }
          // Still accumulating tool call body, wait for end tag
          break;
        } else {
          const rawPayload = this.buffer.slice(0, endIndex).trim();
          this.buffer = this.buffer.slice(endIndex + TOOL_CALL_END.length);
          this.inToolCall = false;

          // Attempt to parse JSON
          const toolCall = this.tryParseToolCall(rawPayload);
          if (toolCall) {
            chunks.push(...this.emitToolCall(toolCall.name, toolCall.arguments));
          } else {
            // Malformed JSON: fall back to emitting as plain text without crashing
            chunks.push(...this.emitText(`${TOOL_CALL_START}\n${rawPayload}\n${TOOL_CALL_END}`));
          }
        }
      }
    }

    return chunks;
  }

  flush(): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    if (this.buffer.length > 0) {
      if (this.inToolCall) {
        // Unclosed tool call block: treat as raw text
        chunks.push(...this.emitText(`${TOOL_CALL_START}${this.buffer}`));
      } else {
        chunks.push(...this.emitText(this.buffer));
      }
      this.buffer = '';
    }

    if (this.isTextBlockOpen) {
      chunks.push(this.closeTextBlock());
    }

    return chunks;
  }

  private emitText(text: string): StreamChunk[] {
    if (text.length === 0) return [];
    const chunks: StreamChunk[] = [];

    if (!this.isTextBlockOpen) {
      this.isTextBlockOpen = true;
      this.accumulatedText = '';
      chunks.push({
        type: 'block-start',
        index: this.currentBlockIndex,
        blockType: 'text',
      });
    }

    this.accumulatedText += text;
    chunks.push({
      type: 'text-delta',
      index: this.currentBlockIndex,
      text,
    });

    return chunks;
  }

  private closeTextBlock(): StreamChunk {
    this.isTextBlockOpen = false;
    const block: ContentBlock = {
      type: 'text',
      text: this.accumulatedText,
    };
    const chunk: StreamChunk = {
      type: 'block-end',
      index: this.currentBlockIndex,
      block,
    };
    this.currentBlockIndex++;
    this.accumulatedText = '';
    return chunk;
  }

  private emitToolCall(name: string, args: Record<string, unknown> | string): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    const id = `agy_tc_${Date.now()}_${++this.toolCallCount}` as ToolCallId;
    const argsJson = typeof args === 'string' ? args : JSON.stringify(args);
    const index = this.currentBlockIndex++;

    chunks.push({
      type: 'block-start',
      index,
      blockType: 'tool-call',
    });

    chunks.push({
      type: 'tool-call-delta',
      index,
      id,
      name,
      argumentsDelta: argsJson,
    });

    const block: ContentBlock = {
      type: 'tool-call',
      id,
      name,
      arguments: argsJson,
    };

    chunks.push({
      type: 'block-end',
      index,
      block,
    });

    this.toolCallsEmitted.push(block);
    return chunks;
  }

  private tryParseToolCall(payload: string): ParsedToolCall | null {
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.name === 'string') {
        const args = parsed.arguments ?? parsed.parameters ?? {};
        return {
          name: parsed.name,
          arguments: args,
        };
      }
    } catch {
      // Return null on JSON parse failure
    }
    return null;
  }

  private findPartialMatch(str: string, target: string): number {
    for (let len = Math.min(str.length, target.length - 1); len > 0; len--) {
      if (str.endsWith(target.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }
}
