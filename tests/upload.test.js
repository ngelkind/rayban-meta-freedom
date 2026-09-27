'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {envelope, classify, utf8, token} = require('../tools/patch/android-upload');

const photo = {captureId: 'cap/1 x', capturedAt: 5, mime: 'image/jpeg'};

test('raw uploads send the image bytes alone', () => {
  const wrap = envelope({format: 'raw'}, photo, 'unused');
  assert.equal(wrap.contentType, 'image/jpeg');
  assert.equal(wrap.prefix.length + wrap.suffix.length, 0);
});

test('multipart wraps the image with fields and a closing boundary', () => {
  const boundary = 'rayban0123456789abcdef';
  const wrap = envelope({format: 'multipart', field: 'photo', fields: {chat_id: '42'}},
    photo, boundary);
  assert.equal(wrap.contentType, 'multipart/form-data; boundary=' + boundary);
  const head = Buffer.from(wrap.prefix).toString('utf8');
  assert.match(head, /name="chat_id"\r\n\r\n42\r\n/);
  assert.match(head, /name="photo"; filename="cap_1_x\.jpg"\r\nContent-Type: image\/jpeg\r\n\r\n$/);
  assert.equal(Buffer.from(wrap.suffix).toString('utf8'), '\r\n--' + boundary + '--\r\n');
});

test('HTTP status decides between done, retry and permanent failure', () => {
  assert.equal(classify(200), 'acknowledged');
  assert.equal(classify(204), 'acknowledged');
  assert.equal(classify(429), 'retry');
  assert.equal(classify(503), 'retry');
  assert.equal(classify(400), 'failed');
  assert.equal(classify(401), 'failed');
  assert.equal(classify(302), 'failed');
});

test('utf8 matches the platform encoder and tokens are header-safe', () => {
  const sample = 'abc é ש 😀';
  assert.deepEqual([...utf8(sample)], [...Buffer.from(sample, 'utf8')]);
  assert.equal(token('a b\r\nc'), 'a_b__c');
});
