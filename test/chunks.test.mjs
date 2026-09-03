import test from 'node:test';
import assert from 'node:assert/strict';
import { ChunkEmitter } from '../lib/chunks.js';

test('ChunkEmitter - text delta and usage calculation', () => {
  const emitter = new ChunkEmitter();

  // 1. Send step_update
  const stepLine = JSON.stringify({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      text_delta: 'Hello from agy!',
    },
  });
  const c1 = emitter.handleLine(stepLine);
  assert.equal(c1.some((c) => c.type === 'text-delta' && c.text === 'Hello from agy!'), true);

  // 2. Send result
  const resultLine = JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'Hello from agy!',
      usage: {
        input_tokens: 1500,
        output_tokens: 40,
        thinking_tokens: 30,
        total_tokens: 1540,
      },
    },
  });
  const c2 = emitter.handleLine(resultLine);

  const usageChunk = c2.find((c) => c.type === 'usage');
  assert.ok(usageChunk);
  assert.equal(usageChunk.usage.inputTokens, 1500);
  assert.equal(usageChunk.usage.outputTokens, 40);
  assert.equal(usageChunk.usage.reasoningTokens, 30);

  const finishChunk = c2.find((c) => c.type === 'finish');
  assert.ok(finishChunk);
  assert.equal(finishChunk.reason.kind, 'stop');
});

test('ChunkEmitter - incremental usage across multiple turns', () => {
  const emitter = new ChunkEmitter();

  // Turn 1 result
  const r1 = emitter.handleLine(JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 10 },
    },
  }));
  const u1 = r1.find((c) => c.type === 'usage');
  assert.equal(u1.usage.inputTokens, 100);
  assert.equal(u1.usage.outputTokens, 20);
  assert.equal(u1.usage.reasoningTokens, 10);

  // Turn 2 result (cumulative tokens: 250 input, 50 output)
  const r2 = emitter.handleLine(JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      usage: { input_tokens: 250, output_tokens: 50, thinking_tokens: 25 },
    },
  }));
  const u2 = r2.find((c) => c.type === 'usage');
  assert.equal(u2.usage.inputTokens, 150); // 250 - 100
  assert.equal(u2.usage.outputTokens, 30);  // 50 - 20
  assert.equal(u2.usage.reasoningTokens, 15); // 25 - 10
});

test('ChunkEmitter - error status in result', () => {
  const emitter = new ChunkEmitter();
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
  const emitter1 = new ChunkEmitter();
  const errorChunks = emitter1.handleTerminalError(new Error('Process died'), 'TRANSPORT');
  const errFinish = errorChunks.find((c) => c.type === 'finish');
  assert.ok(errFinish);
  assert.equal(errFinish.reason.kind, 'error');
  assert.equal(errFinish.reason.failure.code, 'TRANSPORT');

  const emitter2 = new ChunkEmitter();
  const abortChunks = emitter2.handleAbort();
  const abortFinish = abortChunks.find((c) => c.type === 'finish');
  assert.ok(abortFinish);
  assert.equal(abortFinish.reason.kind, 'aborted');
  assert.equal(abortFinish.reason.failure.code, 'ABORTED');
});
