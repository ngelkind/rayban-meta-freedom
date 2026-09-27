'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {PhotoSource, QUERY} = require('../tools/patch/photo-source');
const {PhotoRouter} = require('../tools/patch/media');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

function fixture(initial = null) {
  let baseline = initial;
  let rows = [];
  let fail = false;
  const states = new Map();
  const delivered = [];
  const ledger = {
    baseline: async () => baseline,
    initialize: async id => { baseline = id; },
    status: async id => states.get(id) ?? null,
    transition: async (id, state) => { states.set(id, state); }
  };
  const source = new PhotoSource({
    database: {
      maxPhotoId: async () => 7,
      query: async (sql, args) => {
        assert.match(sql, /mid\.display_full_media_file_id/);
        return rows.filter(r => r.id > args[0] && r.id > args[1])
          .sort((a, b) => a.id - b.id).slice(0, 10);
      }
    },
    files: {read: async () => Uint8Array.from([255, 216, 1, 255, 217])},
    ledger,
    destination: {deliver: async photo => {
      delivered.push(photo.captureId);
      if (fail) throw new Error('remote uncertain');
    }}
  });
  return {source, ledger, states, delivered, add: id => rows.push({
    id, captureId: 'capture-' + id, capturedAt: 123, uri: 'file:///app/photo.jpg', size: 5
  }), fail: () => { fail = true; }};
}

test('queries ready full photos and keeps existing history on first enable', async () => {
  assert.match(QUERY, /mi\.type='photo'/);
  assert.match(QUERY, /mf\.is_ready=1/);
  const f = fixture();
  assert.deepEqual(await f.source.poll(), {initialized: true, baseline: 7});
  f.add(8);
  assert.deepEqual(await f.source.poll(), {delivered: 1, held: 0});
  assert.equal(f.states.get(8), 'acknowledged');
  assert.deepEqual(await f.source.poll(), {delivered: 0, held: 0});
});

test('a late-ready lower id is not lost after a higher id is delivered', async () => {
  const f = fixture(0);
  f.add(2);
  await f.source.poll();
  f.add(1);
  await f.source.poll();
  assert.deepEqual(f.delivered, ['capture-2', 'capture-1']);
});

test('an uncertain send is held across a new source instance', async () => {
  const f = fixture(7);
  f.add(8);
  f.fail();
  assert.deepEqual(await f.source.poll(), {delivered: 0, held: 1});
  assert.equal(f.states.get(8), 'uncertain');
  assert.deepEqual(await f.source.poll(), {delivered: 0, held: 1});
  assert.equal(f.delivered.length, 1);
});

test('a crash after starting a send is not replayed automatically', async () => {
  const f = fixture(7);
  f.add(8);
  f.states.set(8, 'sending');
  assert.deepEqual(await f.source.poll(), {delivered: 0, held: 1});
  assert.deepEqual(f.delivered, []);
});

test('a failed photo does not prevent a later ready photo', async () => {
  const f = fixture(7);
  f.add(8);
  f.add(9);
  f.fail();
  assert.deepEqual(await f.source.poll(), {delivered: 0, held: 2});
  assert.deepEqual(f.delivered, ['capture-8', 'capture-9']);
  assert.equal(f.states.get(9), 'uncertain');
});

test('an incomplete gallery row waits without starving a later photo', async () => {
  const f = fixture(7);
  f.add(8);
  f.add(9);
  // Capture metadata may arrive after the ready flag.
  f.add(10);
  const originalQuery = f.source.database.query;
  f.source.database.query = async (sql, args) => (await originalQuery(sql, args))
    .map(row => row.id === 8 ? {...row, captureId: null} : row);
  assert.deepEqual(await f.source.poll(), {delivered: 2, held: 1});
  assert.deepEqual(f.delivered, ['capture-9', 'capture-10']);
});

test('stop prevents the next poll and skips any later item', async () => {
  const f = fixture(7);
  f.add(8);
  f.source.stop();
  assert.deepEqual(await f.source.poll(), {stopped: true});
  assert.deepEqual(f.delivered, []);
});

function failing(outcome, times = Infinity) {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= times) {
      const error = new Error('destination ' + outcome);
      error.outcome = outcome;
      throw error;
    }
  };
}

test('a definitely-unsent photo is retried until it is delivered', async () => {
  const f = fixture(7);
  f.add(8);
  const deliver = failing('retry', 2);
  f.source.destination = {deliver: async photo => { await deliver(); f.delivered.push(photo.captureId); }};
  await f.source.poll();
  assert.equal(f.states.get(8), 'retry:1');
  await f.source.poll();
  assert.equal(f.states.get(8), 'retry:2');
  assert.deepEqual(await f.source.poll(), {delivered: 1, held: 0});
  assert.equal(f.states.get(8), 'acknowledged');
  assert.deepEqual(f.delivered, ['capture-8']);
});

test('retries stop at the attempt limit and a permanent rejection is not retried', async () => {
  const f = fixture(7);
  f.source.maxAttempts = 2;
  f.add(8);
  f.source.destination = {deliver: failing('retry')};
  await f.source.poll();
  await f.source.poll();
  assert.equal(f.states.get(8), 'failed');
  f.add(9);
  f.source.destination = {deliver: failing('failed')};
  await f.source.poll();
  assert.equal(f.states.get(9), 'failed');
});

test('a file read error is retryable because nothing left the phone', async () => {
  const f = fixture(7);
  f.add(8);
  f.source.files = {read: async () => { throw new Error('decoder rejected file'); }};
  await f.source.poll();
  assert.equal(f.states.get(8), 'retry:1');
});

test('a gallery row awaiting full import does not exhaust delivery attempts', async () => {
  const f = fixture(7);
  f.add(8);
  f.source.maxAttempts = 2;
  let imported = false;
  f.source.files = {read: async () => {
    if (!imported) {
      const error = new Error('full photo is not imported yet');
      error.outcome = 'deferred';
      throw error;
    }
    return new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample-photo.jpg')));
  }};
  f.source.destination = new PhotoRouter({deliver: async photo => { f.delivered.push(photo.captureId); }});
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(await f.source.poll(), {delivered: 0, held: 1});
    assert.equal(f.states.get(8), 'retry:0');
  }
  imported = true;
  assert.deepEqual(await f.source.poll(), {delivered: 1, held: 0});
  assert.equal(f.states.get(8), 'acknowledged');
});

test('a full-gallery row still writing its JPEG succeeds on a later poll', async () => {
  const f = fixture(7);
  f.add(8);
  let reads = 0;
  const complete = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'sample-photo.jpg')));
  f.source.files = {read: async () => ++reads === 1 ? complete.slice(0, 20) : complete};
  f.source.destination = new PhotoRouter({deliver: async photo => { f.delivered.push(photo.captureId); }});
  assert.deepEqual(await f.source.poll(), {delivered: 0, held: 1});
  assert.equal(f.states.get(8), 'retry:1');
  assert.deepEqual(await f.source.poll(), {delivered: 1, held: 0});
  assert.equal(f.states.get(8), 'acknowledged');
  assert.deepEqual(f.delivered, ['capture-8']);
});

test('pausing during a read defers the photo without counting an attempt', async () => {
  const f = fixture(7);
  f.add(8);
  f.source.files = {read: async () => { f.source.stop(); return Uint8Array.from([255, 216, 255, 217]); }};
  await f.source.poll();
  assert.equal(f.states.get(8), 'retry:0');
  assert.deepEqual(f.delivered, []);
});

test('pausing after an upload starts lets that upload finish but starts no next item', async () => {
  const f = fixture(7);
  f.add(8);
  f.add(9);
  let release;
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.source.destination = {deliver: async photo => {
    f.delivered.push(photo.captureId);
    started();
    await blocked;
  }};
  const polling = f.source.poll();
  await begun;
  f.source.stop();
  release();
  assert.deepEqual(await polling, {delivered: 1, held: 0});
  assert.deepEqual(f.delivered, ['capture-8']);
  assert.equal(f.states.get(8), 'acknowledged');
  assert.equal(f.states.get(9), undefined);
});
