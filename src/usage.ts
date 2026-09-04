import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { AgyUsage } from './chunks.js';

/**
 * usage 记账接口：把 agy 的会话累计 usage 折算成本轮增量的 DSH TokenUsage。
 * 实现方必须与累计值的生产者（agy 持续会话进程）同生命周期。
 */
export interface UsageTracker {
  takeUsageDelta(usage: AgyUsage): TokenUsage;
}

/**
 * 会话级 usage 差分基线。
 *
 * agy 持续 stream-json 会话的 result.usage 是进程级累计值（官方字段表明确说明），
 * 因此「上次累计值」必须归属于持有 agy 进程的 AgySession，而不是每次 stream()
 * 新建的 ChunkEmitter——否则复用会话的第二次及后续调用会把当前累计值减 0，
 * 按累计值上报，DSH 的 Turn TPS 分子随之过计量。
 */
export class UsageBaseline implements UsageTracker {
  private lastInputTokens = 0;
  private lastOutputTokens = 0;
  private lastThinkingTokens = 0;
  private lastCacheReadTokens = 0;

  takeUsageDelta(usage: AgyUsage): TokenUsage {
    const currentInput = usage.input_tokens ?? 0;
    const currentOutput = usage.output_tokens ?? 0;
    const currentThinking = usage.thinking_tokens ?? 0;
    const currentCacheRead = usage.cache_read_tokens ?? 0;

    const deltaInput = Math.max(0, currentInput - this.lastInputTokens);
    const deltaOutput = Math.max(0, currentOutput - this.lastOutputTokens);
    const deltaThinking = Math.max(0, currentThinking - this.lastThinkingTokens);
    const deltaCacheRead = Math.max(0, currentCacheRead - this.lastCacheReadTokens);

    this.lastInputTokens = currentInput;
    this.lastOutputTokens = currentOutput;
    this.lastThinkingTokens = currentThinking;
    this.lastCacheReadTokens = currentCacheRead;

    // 实测（scripts/probe-usage-semantics.mjs，agy 1.1.26 / gemini-3.1-pro high，
    // 两轮样本与官方文档样例一致）：output_tokens 包含 thinking_tokens，即
    // output = thinking + 非思考输出（可见文本与工具调用请求）。DSH 的 decode
    // 窗口从首个可见 token 起算、不含思考时间，思考又没有可流式的文本字段，
    // 无法用 reasoning-delta 提前 firstTokenTime——若把含思考的 output 原样上报，
    // TPS 分子会按思考 token 过计量。因此 outputTokens 只上报非思考输出，
    // 思考单独走 reasoningTokens；totalTokens 保留 provider 口径（含思考）。
    const nonThinkingOutput = Math.max(0, deltaOutput - deltaThinking);

    const tokenUsage: TokenUsage = {
      inputTokens: deltaInput,
      outputTokens: nonThinkingOutput,
      // provider 口径的 full-call total：官方样例中 agy 的 total_tokens =
      // input + output（不含 cache_read），从权威的 input/output 累计差值派生
      // 与 provider total 一致，且不依赖 total_tokens 字段是否出现。
      totalTokens: deltaInput + deltaOutput,
      reasoningTokens: deltaThinking,
    };

    // agy 只在带缓存读取的轮次携带 cache_read_tokens；缺失时不输出该字段
    if (usage.cache_read_tokens !== undefined) {
      tokenUsage.cacheReadTokens = deltaCacheRead;
    }

    return tokenUsage;
  }
}
