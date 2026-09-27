'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validate, privateHost, DEFAULTS} = require('../tools/patch/config');

test('an absent or empty config leaves every feature off', () => {
  assert.equal(DEFAULTS.photos.enabled, false);
  assert.equal(DEFAULTS.photos.destination, null);
  assert.equal(DEFAULTS.trace.assistant, false);
  assert.equal(DEFAULTS.assistant.enabled, false);
  assert.equal(validate({}).photos.enabled, false);
});

test('unverified assistant replacement fails closed and never accepts a key in config', () => {
  const route = {enabled: true, mode: 'replace', provider: 'nvidia',
    model: 'nvidia/nemotron-3-super-120b-a12b'};
  assert.throws(() => validate({assistant: route}), /experimentalAudioGate/);
  assert.throws(() => validate({assistant: {...route, experimentalAudioGate: true}}),
    /original Meta reply is not suppressible/);
  const choice = validate({assistant: {enabled: true, mode: 'shadow',
    provider: 'nvidia', model: route.model}});
  assert.equal(choice.assistant.mode, 'shadow');
  assert.equal(Object.hasOwn(choice.assistant, 'apiKey'), false);
  assert.throws(() => validate({assistant: {...route, apiKey: 'secret'}}),
    /credentials cannot be stored/);
  assert.throws(() => validate({assistant: {...route, experimentalAudioGate: true},
    trace: {assistant: true}}), /not suppressible/);
});

test('assistant trace is opt-in and validates its toggle', () => {
  assert.equal(validate({trace: {assistant: true}}).trace.assistant, true);
  assert.equal(validate({trace: {assistant: false}}).trace.assistant, false);
  assert.throws(() => validate({trace: {assistant: 'yes'}}), /boolean/);
});

test('speaker probe is explicit, bounded, and separate from assistant replacement', () => {
  assert.equal(DEFAULTS.diagnostics.speakerTestId, null);
  assert.equal(DEFAULTS.diagnostics.suppressOriginalTestId, null);
  assert.equal(DEFAULTS.diagnostics.muteMicTestId, null);
  assert.equal(DEFAULTS.diagnostics.muteDataxTestId, null);
  assert.equal(validate({diagnostics: {speakerTestId: 'physical-1'}})
    .diagnostics.speakerTestId, 'physical-1');
  assert.throws(() => validate({diagnostics: {speakerTestId: 'bad phrase'}}),
    /speakerTestId invalid/);
  assert.throws(() => validate({diagnostics: {speakerTestId: 'physical-1'},
    assistant: {enabled: true, model: 'model'}}), /requires assistant disabled/);
});

test('accepts an https multipart destination such as a bot API', () => {
  const config = validate({photos: {enabled: true, pollSeconds: 10, destination: {
    type: 'http', url: 'https://api.example.org/bot123/sendPhoto', format: 'multipart',
    field: 'photo', fields: {chat_id: '42'}, headers: {Authorization: 'Bearer x'}}}});
  assert.equal(config.photos.enabled, true);
  assert.equal(config.photos.pollSeconds, 10);
  assert.equal(config.photos.destination.format, 'multipart');
  assert.deepEqual(config.photos.destination.fields, {chat_id: '42'});
  assert.equal(config.photos.destination.timeoutSeconds, 60);
  assert.ok(Object.isFrozen(config.photos.destination));
});

test('plain http is limited to private addresses', () => {
  for (const host of ['10.0.2.2', '192.168.2.10', '172.20.1.1', '100.101.102.103', '127.0.0.1', 'nas.local']) {
    assert.ok(privateHost(host), host);
    assert.doesNotThrow(() => validate({photos: {enabled: true, destination: {
      type: 'http', url: 'http://' + host + ':8765/upload'}}}));
  }
  for (const host of ['8.8.8.8', 'example.com', '172.32.0.1', '192.169.0.1']) {
    assert.equal(privateHost(host), false, host);
    assert.throws(() => validate({photos: {enabled: true, destination: {
      type: 'http', url: 'http://' + host + '/upload'}}}), /private address/);
  }
});

test('rejects unsafe or malformed settings instead of guessing', () => {
  const photo = destination => ({photos: {enabled: true, destination}});
  assert.throws(() => validate(photo(undefined)), /type must be/);
  assert.throws(() => validate(photo({type: 'ftp', url: 'https://a.b/'})), /type must be/);
  assert.throws(() => validate(photo({type: 'http', url: 'https://a.b/#x'})), /URL/);
  assert.throws(() => validate(photo({type: 'http', url: 'https://a.b/', format: 'zip'})), /format/);
  assert.throws(() => validate(photo({type: 'http', url: 'https://a.b/',
    headers: {'Content-Length': '1'}})), /may not set/);
  assert.throws(() => validate(photo({type: 'http', url: 'https://a.b/',
    headers: {'X-Bad': 'a\r\nInjected: 1'}})), /single-line/);
  assert.throws(() => validate({photos: {pollSeconds: 1}}), /pollSeconds/);
  assert.throws(() => validate([]), /must be an object/);
});
