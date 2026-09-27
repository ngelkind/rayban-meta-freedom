'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {AudioGate} = require('../tools/patch/assistant-audio-gate');

function original() {
  const calls = [];
  return {calls, open() { calls.push('open'); return {
    write(bytes) { calls.push(Buffer.from(bytes).toString()); },
    close() { calls.push('close'); }
  }; }};
}

test('a claimed turn discards buffered original audio and completes its callback', () => {
  const gate = new AudioGate();
  const source = original();
  let completed = 0;
  assert.equal(gate.arm('turn'), true);
  const stream = gate.open('turn', () => source.open(), () => { completed++; });
  stream.write(new Uint8Array(Buffer.from('meta audio')));
  stream.close();
  assert.deepEqual(source.calls, []);
  assert.equal(gate.claim('turn'), true);
  assert.deepEqual(source.calls, []);
  assert.equal(completed, 1);
});

test('model failure releases buffered audio once, in order', () => {
  const gate = new AudioGate();
  const source = original();
  gate.arm('turn');
  const stream = gate.open('turn', () => source.open(), () => {});
  stream.write(new Uint8Array(Buffer.from('one')));
  stream.write(new Uint8Array(Buffer.from('two')));
  stream.close();
  assert.equal(gate.release('turn'), true);
  assert.deepEqual(source.calls, ['open', 'one', 'two', 'close']);
  assert.equal(gate.claim('turn'), false);
});

test('buffer limit releases the original instead of using unbounded memory', () => {
  const gate = new AudioGate({maxBytes: 1024});
  const source = original();
  gate.arm('turn');
  const stream = gate.open('turn', () => source.open(), () => {});
  stream.write(new Uint8Array(900));
  stream.write(new Uint8Array(200));
  stream.close();
  assert.deepEqual(source.calls.map(x => typeof x === 'string' ? x.length : 0),
    [4, 900, 200, 5]);
  assert.equal(gate.claim('turn'), false);
});

test('a reply already started before its transcript cannot be replaced', () => {
  const gate = new AudioGate();
  gate.observeOriginal('turn');
  assert.equal(gate.arm('turn'), false);
  assert.equal(gate.claim('turn'), false);
});

test('disable releases a held original reply', () => {
  const gate = new AudioGate();
  const source = original();
  gate.arm('turn');
  const stream = gate.open('turn', () => source.open(), () => {});
  stream.write(new Uint8Array(Buffer.from('meta')));
  gate.disable();
  stream.close();
  assert.deepEqual(source.calls, ['open', 'meta', 'close']);
});

test('multiple audio streams for one turn are all completed when replaced', () => {
  const gate = new AudioGate();
  let completions = 0;
  gate.arm('turn');
  const first = gate.open('turn', () => { throw new Error('original opened'); },
    () => { completions++; });
  const second = gate.open('turn', () => { throw new Error('original opened'); },
    () => { completions++; });
  first.close();
  second.close();
  assert.equal(gate.claim('turn'), true);
  assert.equal(completions, 2);
});
