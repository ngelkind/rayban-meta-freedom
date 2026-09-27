'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {install, WINDOW_MS} = require('../tools/patch/android-datax-input-probe');

test('drops only assistant audio packets for one bounded turn', () => {
  const previous = global.Java;
  let now = 1000;
  let marker = '';
  let received = 0;
  let voices = 0;
  const states = [];
  const voice = function () { voices++; };
  const receive = function () { received++; };
  voice.overload = () => voice;
  receive.overload = () => receive;
  const prefs = {getString() { return marker; }, edit() { return {
    putString(_key, value) { marker = value; return this; }, commit() { return true; }
  }; }};
  global.Java = {use(name) {
    if (name === 'android.app.ActivityThread') return {
      currentApplication() { return {getSharedPreferences() { return prefs; }}; }
    };
    if (name === 'com.meta.air.SgOacrApi') return {executeVoiceRequest: voice};
    if (name === 'com.facebook.wearable.datax.LocalChannel') return {handleReceived: receive};
    throw new Error('unexpected class ' + name);
  }};
  try {
    const hook = install({token: 'datax-1', now: () => now,
      onState: state => states.push(state)});
    const assistant = {service: {value: 15}};
    const unrelated = {service: {value: 14}};
    receive.implementation.call(assistant, 5003, {});
    assert.equal(received, 1);
    voice.implementation.call({}, 'private-id', 'private-request', {}, {});
    assert.equal(voices, 1);
    receive.implementation.call(assistant, 5003, {});
    receive.implementation.call(assistant, 6003, {});
    receive.implementation.call(assistant, 9000, {});
    receive.implementation.call(unrelated, 5003, {});
    assert.equal(hook.count(), 2);
    assert.equal(received, 3);
    now += WINDOW_MS;
    receive.implementation.call(assistant, 5003, {});
    assert.equal(received, 4);
    hook.disable();
    assert.equal(marker, 'datax-1');
    assert.deepEqual(states, ['waiting-for-turn', 'armed-turn', 'dropped-1']);
  } finally {
    global.Java = previous;
  }
});
