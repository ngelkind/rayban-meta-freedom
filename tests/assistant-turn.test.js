'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TurnEngine} = require('../tools/patch/assistant-turn');

test('one final transcript triggers one model call and one speaker call', async () => {
  const calls = [];
  const engine = new TurnEngine({mode: 'replace',
    model: {ask: async ({requestId, text}) => {
      calls.push(['model', requestId, text]);
      return {requestId, text: 'The answer.'};
    }},
    speaker: {speak: async ({requestId, text}) => calls.push(['speaker', requestId, text])}});
  assert.equal((await engine.accept({requestId: 'r1', text: 'Question?', final: false})).status,
    'ignored');
  assert.equal((await engine.accept({requestId: 'r1', text: 'Question?'})).status, 'complete');
  assert.equal((await engine.accept({requestId: 'r1', text: 'Question?'})).status, 'duplicate');
  assert.deepEqual(calls, [['model', 'r1', 'Question?'], ['speaker', 'r1', 'The answer.']]);
});

test('shadow runs the model without speaking, and model failure never speaks', async () => {
  let spoken = 0;
  const speaker = {speak: async () => { spoken++; }};
  const shadow = new TurnEngine({mode: 'shadow', model: {ask: async ({requestId}) =>
    ({requestId, text: 'A'})}, speaker});
  assert.equal((await shadow.accept({requestId: 'a', text: 'Q'})).status, 'complete');
  const failed = new TurnEngine({mode: 'replace', model: {ask: async () => {
    throw new Error('private text must not appear in result');
  }}, speaker});
  assert.deepEqual(await failed.accept({requestId: 'b', text: 'private question'}),
    {status: 'failed'});
  assert.equal(spoken, 0);
});

test('a cancelled model response cannot reach the speaker', async () => {
  let finish;
  let spoken = 0;
  const engine = new TurnEngine({mode: 'replace', model: {ask: () =>
    new Promise(resolve => { finish = resolve; })}, speaker: {speak: async () => { spoken++; }}});
  const pending = engine.accept({requestId: 'turn', text: 'Question'});
  engine.disable();
  finish({requestId: 'turn', text: 'Too late'});
  assert.equal((await pending).status, 'cancelled');
  assert.equal(spoken, 0);
});

test('busy and invalid turns never start another request', async () => {
  let finish;
  let calls = 0;
  const engine = new TurnEngine({model: {ask: () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }}});
  const first = engine.accept({requestId: 'a', text: 'Q'});
  assert.equal((await engine.accept({requestId: 'b', text: 'Q'})).status, 'busy');
  assert.equal((await engine.accept({requestId: 'c', text: ' '.repeat(3001)})).status,
    'invalid');
  finish({requestId: 'a', text: 'A'});
  await first;
  assert.equal(calls, 1);
});
