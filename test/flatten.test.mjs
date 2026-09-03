import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptFlattener, extractBlockText, extractMessageText } from '../lib/flatten.js';

test('TranscriptFlattener - extractBlockText', () => {
  assert.equal(extractBlockText({ type: 'text', text: 'hello world' }), 'hello world');
  assert.equal(extractBlockText({ type: 'reasoning', text: 'internal thought' }), '');

  const toolCallBlock = {
    type: 'tool-call',
    id: 'call_1',
    name: 'search',
    arguments: JSON.stringify({ query: 'test query' }),
  };
  const extractedTc = extractBlockText(toolCallBlock);
  assert.match(extractedTc, /<<<TOOL_CALL>>>/);
  assert.match(extractedTc, /search/);
  assert.match(extractedTc, /test query/);

  const toolResultBlock = {
    type: 'tool-result',
    toolCallId: 'call_1',
    content: [{ type: 'text', text: 'found 3 results' }],
  };
  const extractedTr = extractBlockText(toolResultBlock);
  assert.match(extractedTr, /\[Tool Result for call_1\]/);
  assert.match(extractedTr, /found 3 results/);
});

test('TranscriptFlattener - computeFingerprint determinism and chaining', () => {
  const h1 = TranscriptFlattener.computeFingerprint('', 'user', 'hello');
  const h2 = TranscriptFlattener.computeFingerprint('', 'user', 'hello');
  const hDiff = TranscriptFlattener.computeFingerprint('', 'user', 'different');

  assert.equal(h1, h2);
  assert.notEqual(h1, hDiff);
  assert.equal(typeof h1, 'string');
  assert.equal(h1.length, 64); // SHA-256 hex string

  const chained1 = TranscriptFlattener.computeFingerprint(h1, 'assistant', 'hi');
  const chained2 = TranscriptFlattener.computeFingerprint(h1, 'assistant', 'hi');
  assert.equal(chained1, chained2);
  assert.notEqual(chained1, h1);
});

test('TranscriptFlattener - flattenTurns and fingerprint chain', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first turn' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] },
    { role: 'user', content: [{ type: 'text', text: 'second turn' }] },
  ];

  const turns = TranscriptFlattener.flattenTurns(messages);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[0].text, 'first turn');
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[1].text, 'first reply');
  assert.equal(turns[2].role, 'user');
  assert.equal(turns[2].text, 'second turn');

  // Verify fingerprint chain uniqueness
  assert.notEqual(turns[0].fingerprint, turns[1].fingerprint);
  assert.notEqual(turns[1].fingerprint, turns[2].fingerprint);
});

test('TranscriptFlattener - buildFullPrompt with system, tools, and history', () => {
  const tools = [
    {
      name: 'calculate',
      description: 'Perform math calculation',
      parameters: { type: 'object', properties: { expr: { type: 'string' } } },
    },
  ];

  const turns = [
    { role: 'user', text: 'what is 2 + 2?', fingerprint: 'f1' },
    { role: 'assistant', text: 'it is 4', fingerprint: 'f2' },
    { role: 'user', text: 'and 3 + 3?', fingerprint: 'f3' },
  ];

  const prompt = TranscriptFlattener.buildFullPrompt('You are a helpful assistant.', tools, turns);

  assert.match(prompt, /You are a helpful assistant\./);
  assert.match(prompt, /# Tool Use Rules/);
  assert.match(prompt, /calculate/);
  assert.match(prompt, /# Conversation History/);
  assert.match(prompt, /what is 2 \+ 2\?/);
  assert.match(prompt, /it is 4/);
  assert.match(prompt, /and 3 \+ 3\?/);
});

test('TranscriptFlattener - buildIncrementalPrompt', () => {
  const newTurns = [
    { role: 'user', text: 'next turn message', fingerprint: 'f4' },
  ];
  const prompt = TranscriptFlattener.buildIncrementalPrompt(newTurns);
  assert.equal(prompt, 'next turn message');
});
