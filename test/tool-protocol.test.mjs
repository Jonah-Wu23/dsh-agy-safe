import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallProtocol, buildToolSystemPrompt, TOOL_CALL_START, TOOL_CALL_END } from '../lib/tool-protocol.js';

test('buildToolSystemPrompt formats tools and instructions correctly', () => {
  const tools = [
    {
      name: 'get_weather',
      description: 'Get weather for city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ];
  const prompt = buildToolSystemPrompt(tools);
  assert.match(prompt, /get_weather/);
  assert.match(prompt, /<<<TOOL_CALL>>>/);
  assert.match(prompt, /<<<END_TOOL_CALL>>>/);
  assert.match(prompt, /do NOT create, update, or rewrite conversation goals/i);
});

test('ToolCallProtocol - pure text streaming', () => {
  const protocol = new ToolCallProtocol();
  const c1 = protocol.processDelta('Hello ');
  const c2 = protocol.processDelta('world!');
  const c3 = protocol.flush();

  const all = [...c1, ...c2, ...c3];
  assert.equal(all.some((c) => c.type === 'block-start' && c.blockType === 'text'), true);
  assert.equal(all.some((c) => c.type === 'text-delta' && c.text === 'Hello '), true);
  assert.equal(all.some((c) => c.type === 'text-delta' && c.text === 'world!'), true);
  assert.equal(all.some((c) => c.type === 'block-end'), true);
  assert.equal(protocol.hasToolCalls(), false);
});

test('ToolCallProtocol - partial match buffering at boundary', () => {
  const protocol = new ToolCallProtocol();
  // String ending with partial prefix "<<<TOOL"
  const c1 = protocol.processDelta('Let me think... <<<TOOL');
  // It should emit 'Let me think... ' and buffer '<<<TOOL'
  assert.equal(c1.some((c) => c.type === 'text-delta' && c.text === 'Let me think... '), true);

  // Next delta completes false alarm
  const c2 = protocol.processDelta('_NOT_A_TAG');
  // Should flush buffered text
  const textDeltas = c2.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.match(textDeltas, /<<<TOOL_NOT_A_TAG/);
  assert.equal(protocol.hasToolCalls(), false);
});

test('ToolCallProtocol - complete tool call extraction', () => {
  const protocol = new ToolCallProtocol();
  const rawInput = [
    'I will search for the weather.\n',
    TOOL_CALL_START,
    '\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n',
    TOOL_CALL_END,
    '\nLooking forward to the results.',
  ].join('');

  const chunks = [...protocol.processDelta(rawInput), ...protocol.flush()];

  // Should have text block before
  assert.equal(chunks.some((c) => c.type === 'block-start' && c.blockType === 'text'), true);
  // Should have tool-call block
  const tcStart = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call');
  assert.ok(tcStart);

  const tcDelta = chunks.find((c) => c.type === 'tool-call-delta');
  assert.ok(tcDelta);
  assert.equal(tcDelta.name, 'get_weather');
  assert.match(tcDelta.argumentsDelta, /Paris/);

  const tcEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.ok(tcEnd);
  assert.equal(tcEnd.block.name, 'get_weather');

  assert.equal(protocol.hasToolCalls(), true);
  assert.equal(protocol.getEmittedToolCalls().length, 1);
});

test('ToolCallProtocol - multiple tool calls in single stream', () => {
  const protocol = new ToolCallProtocol();
  const input = [
    TOOL_CALL_START,
    '{"name": "tool_a", "arguments": {"x": 1}}',
    TOOL_CALL_END,
    ' intermediate text ',
    TOOL_CALL_START,
    '{"name": "tool_b", "arguments": {"y": 2}}',
    TOOL_CALL_END,
  ].join('');

  const chunks = [...protocol.processDelta(input), ...protocol.flush()];
  const toolCalls = chunks.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call');
  assert.equal(toolCalls.length, 2);
  assert.equal(protocol.getEmittedToolCalls().length, 2);
});

test('ToolCallProtocol - malformed tool call JSON falls back to text', () => {
  const protocol = new ToolCallProtocol();
  const input = `${TOOL_CALL_START}\n{ INVALID JSON NOT AN OBJECT\n${TOOL_CALL_END}`;

  const chunks = [...protocol.processDelta(input), ...protocol.flush()];
  // Should not crash, should not emit tool-call block, should emit text
  assert.equal(chunks.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'), false);
  assert.equal(chunks.some((c) => c.type === 'text-delta'), true);
  assert.equal(protocol.hasToolCalls(), false);
});

test('ToolCallProtocol - unclosed tool call at EOF flushes as text', () => {
  const protocol = new ToolCallProtocol();
  const input = `Some text ${TOOL_CALL_START} {"name": "unclosed"`;

  const chunks = [...protocol.processDelta(input), ...protocol.flush()];
  assert.equal(chunks.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'), false);
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.match(text, /unclosed/);
});

test('ToolCallProtocol - unclosed tool call exceeding buffer cap flushes as text and keeps parsing', () => {
  const protocol = new ToolCallProtocol(0, 1024);
  const junk = 'x'.repeat(2048);
  const chunks = protocol.processDelta(`${TOOL_CALL_START}${junk}`);
  const textDeltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text);
  assert.ok(textDeltas.join('').startsWith(TOOL_CALL_START), 'over-cap block emitted as text');
  assert.equal(protocol.hasToolCalls(), false);
  // 溢出后回到文本状态，后续 delta 继续正常出文本
  const rest = protocol.processDelta(' continued text');
  assert.equal(rest.some((c) => c.type === 'text-delta' && c.text === ' continued text'), true);
  const finalChunks = protocol.flush();
  assert.ok(finalChunks.some((c) => c.type === 'block-end'), 'text block closes cleanly');
});
