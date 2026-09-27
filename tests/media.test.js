'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const { PhotoRouter } = require('../tools/patch/media');

const jpeg = () => new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample-photo.jpg')));

test('sends a complete owned JPEG to a custom destination', async () => {
  let received;
  const router = new PhotoRouter({deliver: async photo => {
    received = {mime: photo.mime, bytes: [...photo.bytes], id: photo.captureId};
    return 'stored';
  }});
  const input = jpeg();
  assert.equal(await router.deliver({bytes: input, captureId: 'shot-1', capturedAt: 123}), 'stored');
  assert.deepEqual(received, {mime: 'image/jpeg', bytes: [...jpeg()], id: 'shot-1'});
  assert.deepEqual([...input], [...jpeg()]);
  assert.equal(router.pending, 0);
});

test('rejects capture notifications and truncated images', async () => {
  const router = new PhotoRouter({deliver: async () => { throw new Error('must not deliver'); }});
  await assert.rejects(router.deliver({bytes: Uint8Array.from([0x08, 0x01]),
    captureId: 'notice', capturedAt: 123}), /not a complete/);
  await assert.rejects(router.deliver({bytes: Uint8Array.from([0xff, 0xd8, 1]),
    captureId: 'truncated', capturedAt: 123}), /not a complete/);
  await assert.rejects(router.deliver({bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    captureId: 'header-only', capturedAt: 123}), /not a complete/);
});

test('an incomplete image is retryable while the gallery finishes writing it', async () => {
  const router = new PhotoRouter({deliver: async () => { throw new Error('must not deliver'); }});
  const short = Uint8Array.from([0xff, 0xd8, 1]);
  await assert.rejects(router.deliver({bytes: short, captureId: 'still-importing', capturedAt: 123}),
    error => error.outcome === 'retry');
});

test('bounds in-flight transfers and clears the owned copy after delivery', async () => {
  let release;
  let held;
  const gate = new Promise(resolve => { release = resolve; });
  const router = new PhotoRouter({deliver: async photo => {
    held = photo.bytes;
    await gate;
  }}, {maxPending: 1});
  const first = router.deliver({bytes: jpeg(), captureId: 'a', capturedAt: 1});
  await assert.rejects(router.deliver({bytes: jpeg(), captureId: 'b', capturedAt: 2}), /queue is full/);
  release();
  await first;
  assert.equal(held.every(byte => byte === 0), true);
  assert.equal(router.pending, 0);
});
