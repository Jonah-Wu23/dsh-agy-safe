import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageBaseline } from '../lib/usage.js';

test('UsageBaseline - cumulative usage to per-turn delta', () => {
  const baseline = new UsageBaseline();

  const u1 = baseline.takeUsageDelta({ input_tokens: 100, output_tokens: 20, thinking_tokens: 10 });
  assert.equal(u1.inputTokens, 100);
  assert.equal(u1.outputTokens, 10); // 实测口径：output 含 thinking，上报时扣除
  assert.equal(u1.reasoningTokens, 10);
  assert.equal(u1.totalTokens, 120); // total 保留 provider 口径（含思考）
  assert.equal('cacheReadTokens' in u1, false);

  // 第二轮传累计值（250/50/25），差分后为本轮增量
  const u2 = baseline.takeUsageDelta({ input_tokens: 250, output_tokens: 50, thinking_tokens: 25 });
  assert.equal(u2.inputTokens, 150);
  assert.equal(u2.outputTokens, 15); // output差 30 - thinking差 15
  assert.equal(u2.reasoningTokens, 15);
  assert.equal(u2.totalTokens, 180);
});

test('UsageBaseline - hidden thinking excluded from outputTokens (probe regression)', () => {
  // scripts/probe-usage-semantics.mjs 第一轮实测（gemini-3.1-pro high）：
  // 校准轮 output=283 = thinking 282 + 可见 "OK\n"≈1；重思考轮累计 834/703。
  const baseline = new UsageBaseline();

  const u1 = baseline.takeUsageDelta({ input_tokens: 13983, output_tokens: 283, thinking_tokens: 282 });
  assert.equal(u1.outputTokens, 1);
  assert.equal(u1.reasoningTokens, 282);
  assert.equal(u1.totalTokens, 14266);

  const u2 = baseline.takeUsageDelta({
    input_tokens: 19100,
    output_tokens: 834,
    thinking_tokens: 703,
    cache_read_tokens: 24392,
  });
  assert.equal(u2.outputTokens, 130); // 551 - 421（含内置工具调用请求 token）
  assert.equal(u2.reasoningTokens, 421);
  assert.equal(u2.totalTokens, 5668); // input差 5117 + output差 551 = agy total 差（19934-14266）
  assert.equal(u2.cacheReadTokens, 24392);
});

test('UsageBaseline - cache read tokens delta and omission', () => {
  const baseline = new UsageBaseline();

  const u1 = baseline.takeUsageDelta({ input_tokens: 10, output_tokens: 4, cache_read_tokens: 30000 });
  assert.equal(u1.cacheReadTokens, 30000);

  const u2 = baseline.takeUsageDelta({ input_tokens: 10, output_tokens: 4, cache_read_tokens: 30214 });
  assert.equal(u2.cacheReadTokens, 214);

  // agy 未携带 cache_read_tokens 的轮次不输出该字段
  const u3 = baseline.takeUsageDelta({ input_tokens: 5, output_tokens: 2 });
  assert.equal('cacheReadTokens' in u3, false);
});

test('UsageBaseline - missing fields count as zero and never go negative', () => {
  const baseline = new UsageBaseline();

  const u1 = baseline.takeUsageDelta({ output_tokens: 5 });
  assert.equal(u1.inputTokens, 0);
  assert.equal(u1.outputTokens, 5);
  assert.equal(u1.reasoningTokens, 0);

  // 累计值回退（异常场景）按 0 计，不得产生负增量
  const u2 = baseline.takeUsageDelta({ output_tokens: 2 });
  assert.equal(u2.outputTokens, 0);
});

test('UsageBaseline - instances are independent', () => {
  const a = new UsageBaseline();
  const b = new UsageBaseline();

  a.takeUsageDelta({ output_tokens: 100 });
  const ub = b.takeUsageDelta({ output_tokens: 3 });
  assert.equal(ub.outputTokens, 3);
});
