import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgyEnv, sessionKeyFor } from '../lib/session.js';

test('buildAgyEnv - keeps whitelisted base vars and AGY_*/AV_* prefixes only', () => {
  const env = buildAgyEnv({
    PATH: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\me',
    HOME: 'C:\\Users\\me',
    TEMP: 'C:\\Temp',
    DEEPSEEK_API_KEY: 'sk-secret',
    AGY_HOME: 'C:\\Users\\me\\.agy',
    AV_CRED: 'av-cred',
    OTHER_SECRET: 'hunter2',
  });
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.USERPROFILE, 'C:\\Users\\me');
  assert.equal(env.TEMP, 'C:\\Temp');
  assert.equal(env.AGY_HOME, 'C:\\Users\\me\\.agy');
  assert.equal(env.AV_CRED, 'av-cred');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.OTHER_SECRET, undefined);
});

test('sessionKeyFor - separates main conversation from auxiliary purposes', () => {
  assert.equal(sessionKeyFor('s1'), 's1::conversation');
  assert.equal(sessionKeyFor('s1', 'conversation'), 's1::conversation');
  assert.equal(sessionKeyFor('s1', 'session-title'), 's1::session-title');
  assert.equal(sessionKeyFor('s1', 'compaction'), 's1::compaction');
  // 同一 sessionId 的不同 purpose 必须得到不同键（标题/压缩调用不得与主对话抢进程）
  assert.notEqual(sessionKeyFor('s1', 'session-title'), sessionKeyFor('s1'));
  assert.notEqual(sessionKeyFor('s1', 'compaction'), sessionKeyFor('s1'));
  // 不同会话即使 purpose 相同也互不影响
  assert.notEqual(sessionKeyFor('s1', 'session-title'), sessionKeyFor('s2', 'session-title'));
});
