'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {OneTurnWindow, install, WINDOW_MS} = require('../tools/patch/android-request-probe');

test('one turn window suppresses duplicates, then returns to pass-through', () => {
  let now = 1000;
  const window = new OneTurnWindow(() => now);
  assert.equal(window.decision(), 'first');
  window.begin();
  assert.equal(window.decision(), 'suppress');
  now += WINDOW_MS - 1;
  assert.equal(window.decision(), 'suppress');
  now++;
  assert.equal(window.decision(), 'pass');
});

test('diagnostic hook drops only one bounded turn and records the marker', () => {
  const previous = global.Java;
  let now = 1000;
  let saved = '';
  let originalCalls = 0;
  let failedCallbacks = 0;
  const states = [];
  const method = function () { originalCalls++; };
  method.overload = () => method;
  const prefs = {getString() { return saved; }, edit() { return {
    putString(_key, value) { saved = value; return this; }, commit() { return true; }
  }; }};
  global.Java = {use(name) {
    if (name === 'android.app.ActivityThread') return {
      currentApplication() { return {getSharedPreferences() { return prefs; }}; }
    };
    if (name === 'com.meta.air.SgOacrApi') return {executeVoiceRequest: method};
    throw new Error('unexpected class ' + name);
  }};
  try {
    const hook = install({token: 'one', now: () => now, onState: value => states.push(value)});
    const callback = {onComplete(success) {
      assert.equal(success, false); failedCallbacks++;
    }};
    method.implementation.call({}, 'private-id', 'private-request', {}, callback);
    now += 100;
    method.implementation.call({}, 'another-id', 'another-request', {}, callback);
    assert.equal(originalCalls, 0);
    assert.equal(failedCallbacks, 2);
    assert.equal(saved, 'one');
    now += WINDOW_MS;
    method.implementation.call({}, 'later-id', 'later-request', {}, callback);
    assert.equal(originalCalls, 1);
    hook.disable();
    method.implementation.call({}, 'after-disable', 'request', {}, callback);
    assert.equal(originalCalls, 2);
    assert.deepEqual(states, ['armed', 'suppressed']);
  } finally {
    global.Java = previous;
  }
});
