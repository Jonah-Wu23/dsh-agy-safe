import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgyEnv } from '../lib/session.js';

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
