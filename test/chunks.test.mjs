import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkEmitter } from '../lib/chunks.js';
import { UsageBaseline } from '../lib/usage.js';

function resultEvent(usage) {
  return JSON.stringify({ event: 'result', result: { status: 'SUCCESS', usage } });
}

test('ChunkEmitter - text delta routed through protocol', () => {
  const emitter = new ChunkEmitter(0, new UsageBaseline());

  const stepLine = JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      text_delta: 'Hello from agy!',
    },
  });
  const c1 = emitter.handleLine(stepLine);
  assert.equal(c1.some((c) => c.type === 'text-delta' && c.text === 'Hello from agy!'), true);
});

test('ChunkEmitter - usage chunk delegates to the injected tracker', () => {
  const emitter = new ChunkEmitter(0, new UsageBaseline());

  const c = emitter.handleLine(
    resultEvent({ input_tokens: 1500, output_tokens: 40, thinking_tokens: 30 }),
  );

  const usageChunk = c.find((x) => x.type === 'usage');
  assert.ok(usageChunk);
  assert.equal(usageChunk.usage.inputTokens, 1500);
  assert.equal(usageChunk.usage.outputTokens, 10); // 40 - thinking 30
  assert.equal(usageChunk.usage.reasoningTokens, 30);
  assert.equal(usageChunk.usage.totalTokens, 1540);

  const finishChunk = c.find((x) => x.type === 'finish');
  assert.ok(finishChunk);
  assert.equal(finishChunk.reason.kind, 'stop');
});

test('ChunkEmitter - per-turn emitters over one reused session report increments (regression)', () => {
  // 生产组装复现：AgySessionManager 指纹前缀匹配时复用同一 AgySession（同一
  // agy 进程，result.usage 为会话累计值），而 AgyAdapter.stream() 每次调用新建
  // ChunkEmitter。差分基线必须随会话持久：官方 apple 两轮样例（累计 4 → 8）
  // 下，第二轮应报本轮增量 4，而不是累计值 8。
  const baseline = new UsageBaseline();

  const first = new ChunkEmitter(0, baseline).handleLine(
    resultEvent({ input_tokens: 30384, output_tokens: 4 }),
  );
  const u1 = first.find((c) => c.type === 'usage').usage;
  assert.equal(u1.outputTokens, 4);
  assert.equal(u1.inputTokens, 30384);

  const second = new ChunkEmitter(0, baseline).handleLine(
    resultEvent({ input_tokens: 30662, output_tokens: 8 }),
  );
  const u2 = second.find((c) => c.type === 'usage').usage;
  assert.equal(u2.outputTokens, 4); // 8 - 4，而非累计值 8
  assert.equal(u2.inputTokens, 278); // 30662 - 30384
});

test('ChunkEmitter - error status in result', () => {
  const emitter = new ChunkEmitter(0, new UsageBaseline());
  const res = emitter.handleLine(JSON.stringify({
    event: 'result',
    result: {
      status: 'ERROR',
      error: { message: 'Quota exceeded', code: 'RATE_LIMIT' },
    },
  }));

  const finishChunk = res.find((c) => c.type === 'finish');
  assert.ok(finishChunk);
  assert.equal(finishChunk.reason.kind, 'error');
  assert.equal(finishChunk.reason.failure.message, 'Quota exceeded');
  assert.equal(finishChunk.reason.failure.code, 'RATE_LIMIT');
});

test('ChunkEmitter - terminal error and abort handlers', () => {
  const emitter1 = new ChunkEmitter(0, new UsageBaseline());
  const errorChunks = emitter1.handleTerminalError(new Error('Process died'), 'TRANSPORT');
  const errFinish = errorChunks.find((c) => c.type === 'finish');
  assert.ok(errFinish);
  assert.equal(errFinish.reason.kind, 'error');
  assert.equal(errFinish.reason.failure.code, 'TRANSPORT');

  const emitter2 = new ChunkEmitter(0, new UsageBaseline());
  const abortChunks = emitter2.handleAbort();
  const abortFinish = abortChunks.find((c) => c.type === 'finish');
  assert.ok(abortFinish);
  assert.equal(abortFinish.reason.kind, 'aborted');
  assert.equal(abortFinish.reason.failure.code, 'ABORTED');
});
