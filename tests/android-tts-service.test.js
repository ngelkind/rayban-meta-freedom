'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TtsSpeaker} = require('../tools/patch/android-tts-service');

test('TTS speaker sends model text to the supplied device player and waits for completion',
  async () => {
    const events = [];
    const player = {stop() { events.push('stop'); }};
    const playback = {A00(cont) { events.push('complete'); return 'done'; }};
    const api = {BrE(...args) {
      events.push(['speak', ...args]);
      return playback;
    }};
    const speaker = new TtsSpeaker({api, player, useCase: 'assistant',
      suspend: async call => call('continuation'),
      onStage: stage => events.push(stage)});
    await speaker.speak({requestId: 'r1', text: 'The answer'});
    assert.equal(events[0], 'requesting');
    assert.deepEqual(events[1], ['speak', player, 'assistant', 'The answer',
      'en_US', 'rayban-proxy:r1', null, 'continuation', 4, 100, 100, false]);
    assert.deepEqual(events.slice(2), ['awaiting-playback', 'complete', 'played']);
    assert.equal(events.includes('stop'), false);
  });

test('TTS speaker rejects empty text and does not invoke the service', async () => {
  let called = false;
  const speaker = new TtsSpeaker({api: {BrE() { called = true; }}, player: {},
    useCase: {}, suspend: async () => {}});
  await assert.rejects(speaker.speak({requestId: 'r1', text: ''}));
  assert.equal(called, false);
});
