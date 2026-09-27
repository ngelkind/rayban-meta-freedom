'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {install, WINDOW_MS} = require('../tools/patch/android-mic-probe');

test('one glasses turn drops mic frames, then passes future frames through', () => {
  const previous = global.Java;
  let now = 1000;
  let marker = '';
  let voices = 0;
  let frames = 0;
  const states = [];
  const voice = function () { voices++; };
  const mic = function () { frames++; };
  voice.overload = () => voice;
  mic.overload = () => mic;
  const prefs = {getString() { return marker; }, edit() { return {
    putString(_key, value) { marker = value; return this; }, commit() { return true; }
  }; }};
  global.Java = {use(name) {
    if (name === 'android.app.ActivityThread') return {
      currentApplication() { return {getSharedPreferences() { return prefs; }}; }
    };
    if (name === 'com.meta.air.SgOacrApi') return {executeVoiceRequest: voice};
    if (name === 'X.ENk') return {A06: mic};
    throw new Error('unexpected class ' + name);
  }};
  try {
    const hook = install({token: 'test-1', now: () => now,
      onState: state => states.push(state)});
    mic.implementation({}, {});
    assert.equal(frames, 1);
    voice.implementation.call({}, 'private-id', 'private-request', {}, {});
    assert.equal(voices, 1);
    mic.implementation({}, {});
    assert.equal(frames, 1);
    assert.equal(hook.count(), 1);
    now += WINDOW_MS;
    mic.implementation({}, {});
    assert.equal(frames, 2);
    voice.implementation.call({}, 'later-id', 'later-request', {}, {});
    assert.equal(voices, 2);
    hook.disable();
    assert.equal(marker, 'test-1');
    assert.deepEqual(states, ['waiting-for-turn', 'armed-turn', 'dropped-1']);
  } finally {
    global.Java = previous;
  }
});
