'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {AssistantRouter, DailyBudget, requestFor} = require('../tools/patch/assistant');

function fixture(provider = 'nvidia', response = {choices: [{message: {content: 'Hi.'}}]}) {
  let record = null;
  let calls = 0;
  const store = {read: () => record, write: value => { record = value; }};
  const transport = {post: async (url, options) => {
    calls++;
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return {status: 200, json: response};
  }};
  const router = new AssistantRouter({transport, keyFor: () => 'test-key',
    budget: new DailyBudget(store, 1, () => new Date('2026-09-25T10:00:00Z')),
    provider, model: 'configured-model',
    prices: {inputPerMillion: 1, outputPerMillion: 1}});
  return {router, calls: () => calls, record: () => record};
}

test('NVIDIA text route uses configured model and preserves request id', async () => {
  const run = fixture();
  const result = await run.router.ask({text: 'Hello', requestId: 'turn-2'});
  assert.deepEqual(result, {requestId: 'turn-2', provider: 'nvidia', text: 'Hi.'});
  assert.equal(run.calls(), 1);
  assert.ok(run.record().reservedUsd > 0);
});

test('a failed model request never falls through to a second provider', async () => {
  const run = fixture('nvidia');
  run.router.transport.post = async () => ({status: 429, json: {}});
  await assert.rejects(run.router.ask({text: 'Hello', requestId: 'turn-3'}), /status 429/);
  assert.ok(run.record().reservedUsd > 0);
});

test('daily budget blocks the call before transport', async () => {
  const run = fixture();
  run.router.budget.limitUsd = 0;
  await assert.rejects(run.router.ask({text: 'Hello', requestId: 'turn-4'}), /budget reached/);
  assert.equal(run.calls(), 0);
});

test('unknown price and missing key fail closed', async () => {
  const run = fixture();
  run.router.prices = null;
  await assert.rejects(run.router.ask({text: 'Hello', requestId: 'turn-5'}), /price is unknown/);
  run.router.prices = {inputPerMillion: 0, outputPerMillion: 0};
  run.router.keyFor = () => null;
  await assert.rejects(run.router.ask({text: 'Hello', requestId: 'turn-5'}), /key and valid output cap are required/);
  assert.equal(run.calls(), 0);
});

test('Gemini key stays in a header and a model id cannot become a URL', () => {
  const request = requestFor('gemini', 'gemini-test', 'private-key', 'Hi', 'Be brief', 128);
  assert.equal(request.headers['x-goog-api-key'], 'private-key');
  assert.ok(!request.url.includes('private-key'));
  assert.throws(() => requestFor('gemini', 'test/../bad', 'k', 'Hi', 'Be brief', 128), /invalid/);
});

test('Anthropic and Gemini replies are normalized', async () => {
  for (const [provider, response, expected] of [
    ['anthropic', {content: [{type: 'text', text: 'Hello'}]}, 'Hello'],
    ['gemini', {candidates: [{content: {parts: [{text: 'World'}]}}]}, 'World']
  ]) {
    const run = fixture(provider, response);
    if (provider === 'gemini') run.router.transport.post = async () => ({status: 200, json: response});
    assert.equal((await run.router.ask({text: 'Hi', requestId: 'x'})).text, expected);
  }
});
