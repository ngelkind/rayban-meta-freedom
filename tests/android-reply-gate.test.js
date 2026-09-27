'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {AudioGate} = require('../tools/patch/assistant-audio-gate');
const {install} = require('../tools/patch/android-reply-gate');

test('unarmed audio passes through; armed original audio is held and completed', () => {
  const prior = global.Java;
  let originalCalls = 0;
  let callbacks = 0;
  const original = function () { originalCalls++; return {write() {}, close() {}}; };
  original.overload = () => original;
  global.Java = {
    use: () => ({play: original}),
    array: (_kind, values) => values,
    performNow: fn => fn(),
    registerClass: spec => ({$new() {
      const stream = {token: {value: 0}};
      stream.write = spec.methods.write.bind(stream);
      stream.close = spec.methods.close.bind(stream);
      return stream;
    }})
  };
  try {
    const gate = new AudioGate();
    const hook = install(gate);
    const callback = {onComplete() { callbacks++; }};
    const desc = id => ({getInteractionId() { return id; }});
    original.implementation.call({}, desc('old'), callback);
    assert.equal(originalCalls, 1);
    assert.equal(gate.arm('old'), false);
    gate.arm('new');
    const buffered = original.implementation.call({}, desc('new'), callback);
    const data = [1, 2, 3];
    buffered.write({duplicate() { return this; }, remaining() { return 3; },
      get(array) { data.forEach((value, index) => { array[index] = value; }); }});
    assert.equal(originalCalls, 1);
    buffered.close();
    gate.claim('new');
    assert.equal(callbacks, 1);
    assert.equal(originalCalls, 1);
    original.implementation.call({}, desc('rayban-proxy:new'), callback);
    assert.equal(originalCalls, 2);
    hook.disable();
  } finally { global.Java = prior; }
});
