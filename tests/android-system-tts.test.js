'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {SystemSpeaker} = require('../tools/patch/android-system-tts');

test('speaks through the bridge and waits for playback to finish', async () => {
  const calls = [];
  const stages = ['initializing', 'speaking', 'completed'];
  const speaker = new SystemSpeaker({bridge: {
    start(text, id) { calls.push(['start', text, id]); return true; },
    status(id) { calls.push(['status', id]); return stages.shift(); },
    cancel(id) { calls.push(['cancel', id]); }
  }, pollMs: 1});
  await speaker.speak({requestId: 'turn-1', text: 'Hello'});
  assert.deepEqual(calls[0], ['start', 'Hello', 'turn-1']);
  assert.equal(calls.filter(([kind]) => kind === 'status').length, 3);
  assert.equal(calls.some(([kind]) => kind === 'cancel'), false);
});

test('refuses speech when glasses are not selected', async () => {
  const speaker = new SystemSpeaker({bridge: {
    start() { return false; }, status() { throw new Error('unexpected'); }, cancel() {}
  }});
  await assert.rejects(speaker.speak({requestId: 'x', text: 'Hello'}),
    /glasses not selected/);
});

test('failed playback cancels the active request', async () => {
  let cancelled = null;
  const speaker = new SystemSpeaker({bridge: {
    start() { return true; }, status() { return 'failed'; },
    cancel(id) { cancelled = id; }
  }});
  await assert.rejects(speaker.speak({requestId: 'x', text: 'Hello'}), /failed/);
  assert.equal(cancelled, 'x');
});

test('empty and oversized speech is refused before the bridge', async () => {
  const speaker = new SystemSpeaker({bridge: {
    start() { throw new Error('unexpected'); }, status() {}, cancel() {}
  }});
  await assert.rejects(speaker.speak({requestId: 'x', text: ''}), /invalid/);
  await assert.rejects(speaker.speak({requestId: 'x', text: 'a'.repeat(3001)}), /invalid/);
});
