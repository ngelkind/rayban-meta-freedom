'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const consent = require('../tools/patch/android-camera-consent');
const vision = require('../tools/patch/android-vision');
const {validate} = require('../tools/patch/config');

function method() {
  const m = function () {};
  m.overload = () => m;
  return m;
}

test('camera consent keys are turned on for the device the app reads', () => {
  const previous = global.Java;
  const values = {MMAI_USER_CONSENT_ENABLED: false, CAMERA_SETTING_ENABLED: true};
  const writes = [];
  const read = method(); const get = method(); const set = method();
  read.call = () => 'holder';
  get.call = (_cls, key, id) => { assert.equal(id, 'glasses-1'); return values[key]; };
  set.call = (_cls, key, type, id, source, value, check) => {
    writes.push([key, type, id, value, check]); values[key] = value;
  };
  global.Java = {retain: x => x, performNow: fn => fn(), use(name) {
    if (name === 'X.3H1') return {valueOf: key => key};
    return {A01: read, A08: get, A06: set};
  }};
  try {
    const states = [];
    consent.install({keys: ['MMAI_USER_CONSENT_ENABLED', 'CAMERA_SETTING_ENABLED'],
      onState: s => states.push(s), defer: fn => fn()});
    assert.equal(read.implementation.call({}, 'ANY_KEY', 'GLASSES', 'glasses-1'), 'holder');
    assert.deepEqual(writes, [['MMAI_USER_CONSENT_ENABLED', 'GLASSES', 'glasses-1', true, false]]);
    assert.equal(states.at(-1), 'MMAI_USER_CONSENT_ENABLED:0>1 CAMERA_SETTING_ENABLED:1>1');
    read.implementation.call({}, 'ANY_KEY', 'GLASSES', 'glasses-1');
    assert.equal(writes.length, 1, 'applied once per start');
  } finally {
    global.Java = previous;
  }
});

test('the latest glasses photo is kept in memory for one turn only', () => {
  const previous = global.Java;
  const frame = method();
  frame.call = () => undefined;
  let now = 1000;
  global.Java = {
    array: (_type, values) => values,
    use(name) {
      if (name === 'android.util.Base64') return {encodeToString: bytes => 'b64:' + bytes.length};
      return {onImageFrameReceived: frame};
    }
  };
  try {
    const hook = vision.install({now: () => now});
    const buffer = {duplicate: () => ({remaining: () => 3, get: arr => arr.fill(7)})};
    frame.implementation.call({}, 'turn-1', buffer, 0, 0, 0);
    assert.equal(hook.take('turn-1', 20000), 'b64:3');
    assert.equal(hook.take('turn-1', 20000), null, 'consumed');
    frame.implementation.call({}, 'turn-2', buffer, 0, 0, 0);
    now += 30000;
    assert.equal(hook.take('turn-2', 20000), null, 'stale photos are not used');
  } finally {
    global.Java = previous;
  }
});

test('camera AI and vision model are opt-in config values', () => {
  assert.equal(validate({}).cameraAi.enabled, false);
  assert.equal(validate({cameraAi: {enabled: true}}).cameraAi.enabled, true);
  const pick = validate({fixedReply: {enabled: true, text: 't', source: 'model',
    model: 'openai/gpt-oss-20b', visionModel: 'meta/llama-3.2-11b-vision-instruct'}})
    .fixedReply.model;
  assert.equal(pick.visionModel, 'meta/llama-3.2-11b-vision-instruct');
});
