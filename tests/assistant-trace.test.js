'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {install, FrameCounter, HOOKS, MAX_EVENTS} = require('../tools/patch/assistant-trace');

test('mic frame trace records bounded metadata, never contents', () => {
  const records = [];
  const counter = new FrameCounter((event, fields) => records.push({event, fields}), 2);
  counter.add(12, 1000);
  assert.equal(records.length, 0);
  counter.add(20, 1050);
  assert.deepEqual(records, [{event: 'micFrames', fields: {
    reason: 'batch', frames: 2, bytes: 32, durationMs: 50}}]);
  counter.flush('boundary', 1100);
  assert.equal(records.length, 1);
});

test('output trace batches byte counts without logging audio', () => {
  const records = [];
  const counter = new FrameCounter((event, fields) => records.push({event, fields}), 2,
    'audioWrites');
  counter.add(120, 1000);
  counter.add(80, 1040);
  assert.deepEqual(records, [{event: 'audioWrites', fields: {
    reason: 'batch', frames: 2, bytes: 200, durationMs: 40}}]);
});

test('observe-only trace covers the saved candidate boundaries', () => {
  assert.deepEqual(HOOKS.map(h => h.name), [
    'micHeader', 'micFrame', 'turnEntryW', 'turnEntryM', 'nativeHandoff',
    'transcription', 'ttsText', 'action', 'replyAudioLegacy',
    'replyAudioConnectivity', 'ttsSpeak', 'audioPlay', 'audioWrite',
    'dataxSend', 'dataxReceive', 'trackPlay', 'trackWrite', 'trackWriteBytes']);
  assert.ok(MAX_EVENTS <= 300);
  assert.ok(HOOKS.every(h => !('mode' in h)));
});

test('installed hooks call originals once and never log speech content', () => {
  const previous = global.Java;
  const methods = new Map();
  const lines = [];
  let calls = 0;
  global.Java = {use(name) {
    if (name === 'android.util.Log') return {i(_tag, line) { lines.push(line); }};
    return new Proxy({}, {get(_target, method) {
      const key = name + '.' + String(method);
      if (!methods.has(key)) {
        function original() { calls++; return 7; }
        original.overload = () => original;
        methods.set(key, original);
      }
      return methods.get(key);
    }});
  }};
  try {
    const trace = install();
    assert.equal(trace.status().faults.length, 0);
    const tts = methods.get('com.facebook.assistant.sdk.apis.interaction.NativeInteractionListener.onTtsMessage');
    assert.equal(tts.implementation.call({}, 'private spoken text', 'private-id'), 7);
    assert.equal(calls, 1);
    assert.equal(lines.join('\n').includes('private spoken text'), false);
    assert.equal(lines.join('\n').includes('private-id'), false);
    trace.setEnabled(false);
    assert.equal(tts.implementation.call({}, 'another private text', 'id'), 7);
    assert.equal(calls, 2);
    assert.equal(lines.join('\n').includes('another private text'), false);
  } finally {
    global.Java = previous;
  }
});
