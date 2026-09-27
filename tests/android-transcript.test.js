'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {finalTranscript, install} = require('../tools/patch/android-transcript');

function desc(fields) { return {A01(index) { return fields[index] ?? null; }}; }

test('only a bounded final transcription yields a turn', () => {
  assert.deepEqual(finalTranscript(desc({0: 'Question', 4: 'id', 8: true})),
    {requestId: 'id', text: 'Question', final: true});
  assert.equal(finalTranscript(desc({0: 'Partial', 4: 'id', 8: false})), null);
  assert.equal(finalTranscript(desc({0: 'Question', 8: true})), null);
  assert.equal(finalTranscript(desc({0: 'x'.repeat(3001), 4: 'id', 8: true})), null);
});

test('observer calls the original once, then queues the final turn', async () => {
  const prior = global.Java;
  const calls = [];
  let original;
  const method = {overload() { return original; }};
  original = function () { calls.push('original'); return 42; };
  method.overload = () => original;
  global.Java = {use() { return {onTranscription: method}; }};
  try {
    const observer = install(event => calls.push(event.requestId));
    const result = original.implementation.call({}, desc({0: 'private', 4: 'r1', 8: true}));
    assert.equal(result, 42);
    assert.deepEqual(calls, ['original']);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['original', 'r1']);
    observer.disable();
    original.implementation.call({}, desc({0: 'private', 4: 'r2', 8: true}));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['original', 'r1', 'original']);
  } finally { global.Java = prior; }
});
