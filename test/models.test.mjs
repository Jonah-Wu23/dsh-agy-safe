import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAgyModelsOutput,
  splitEffortVariant,
  groupBaseModels,
  pickDefaultEffort,
} from '../lib/models.js';

// 真实 `agy models` 输出的数据行（stdout，TAB 分隔），2026-09-04 抓取。
const REAL_OUTPUT = [
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n') + '\n';

test('parseAgyModelsOutput - parses tab-separated data lines only', () => {
  const output = [
    '',
    'id\tname',
    'a\t b ',
    'no tab line',
    '\tonly name',
    'only id',
    'a\tduplicate',
    'b\tsecond',
  ].join('\n');
  const listed = parseAgyModelsOutput(output);
  assert.deepEqual(listed, [
    { id: 'id', name: 'name' },
    { id: 'a', name: 'b' },
    { id: 'b', name: 'second' },
  ]);
});

test('parseAgyModelsOutput - parses the real agy output with 14 entries', () => {
  const listed = parseAgyModelsOutput(REAL_OUTPUT);
  assert.equal(listed.length, 14);
  assert.equal(listed[0].id, 'gemini-3.8-flash-high');
  assert.equal(listed[0].name, 'Gemini 3.8 Flash (High)');
});

test('splitEffortVariant - strips effort suffix only when id and name agree', () => {
  assert.deepEqual(
    splitEffortVariant('gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'),
    { baseId: 'gemini-3.8-flash', baseName: 'Gemini 3.8 Flash', effort: 'high' },
  );
  assert.deepEqual(
    splitEffortVariant('gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'),
    { baseId: 'gpt-oss-120b', baseName: 'GPT-OSS 120B', effort: 'medium' },
  );
  // 名称后缀不匹配时（非档位变体）不得拆
  assert.equal(splitEffortVariant('foo-medium', 'Foo Medium'), null);
  // 非档位后缀模型原样返回
  const sonnet = splitEffortVariant('claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)');
  assert.equal(sonnet, null);
  const opus = splitEffortVariant('claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)');
  assert.equal(opus, null);
});

test('groupBaseModels - groups real agy output into 7 base models', () => {
  const bases = groupBaseModels(parseAgyModelsOutput(REAL_OUTPUT));
  assert.equal(bases.length, 7);
  const byId = new Map(bases.map((b) => [b.id, b]));
  assert.deepEqual(byId.get('gemini-3.8-flash'), {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    efforts: ['low', 'medium', 'high'],
  });
  // 3.1 Pro 只有 low/high 两档
  assert.deepEqual(byId.get('gemini-3.1-pro'), {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    efforts: ['low', 'high'],
  });
  // 无档位模型 efforts 为空
  assert.deepEqual(byId.get('claude-sonnet-4-6'), {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (Thinking)',
    efforts: [],
  });
  assert.deepEqual(byId.get('gpt-oss-120b'), {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    efforts: ['medium'],
  });
  // 保持 agy 首现顺序：pro 在 claude 之前，claude 在 gpt 之前
  assert.deepEqual(bases.map((b) => b.id), [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.1-pro',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
    'gpt-oss-120b',
  ]);
});

test('pickDefaultEffort - prefers medium, else deepest available', () => {
  assert.equal(pickDefaultEffort(['low', 'medium', 'high']), 'medium');
  assert.equal(pickDefaultEffort(['low', 'high']), 'high');
  assert.equal(pickDefaultEffort(['low']), 'low');
  assert.equal(pickDefaultEffort(['high']), 'high');
});
