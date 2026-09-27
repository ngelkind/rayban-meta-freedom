'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {endpoint} = require('../tools/patch/android-http');

test('only exact model API hosts can receive private requests', () => {
  assert.equal(endpoint('https://integrate.api.nvidia.com/v1/chat/completions'),
    'https://integrate.api.nvidia.com/v1/chat/completions');
  for (const url of [
    'http://integrate.api.nvidia.com/v1/chat/completions',
    'https://integrate.api.nvidia.com.attacker.invalid/v1/chat/completions',
    'https://user:pass@api.anthropic.com/v1/messages',
    'https://api.openai.com:444/v1/chat/completions'
  ]) assert.throws(() => endpoint(url), /not allowed/);
});
