'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {resolveImported, IMPORT_PATH} = require('../tools/patch/android-photo');

const row = (id, capturedAt, importedAt = 123) =>
  ({id, capturedAt, importedAt, uri: null, size: null});
const media = (id, takenAt, extra = {}) => ({id, takenAt, path: IMPORT_PATH,
  mime: 'image/jpeg', size: 2000000, ...extra});

test('matches two imported photos by unique close capture times', () => {
  const rows = [row(5, 100000), row(6, 120000)];
  const result = resolveImported(rows, [media(50, 101391), media(60, 121314)]);
  assert.equal(result[0].uri, 'content://media/external/images/media/50');
  assert.equal(result[1].uri, 'content://media/external/images/media/60');
  assert.equal(result[0].size, 2000000);
  assert.equal(rows[0].uri, null); // caller's SQLite result is unchanged
});

test('holds ambiguous, foreign-folder and pre-import rows', () => {
  assert.equal(resolveImported([row(5, 100000)],
    [media(50, 101000), media(51, 101100)])[0].uri, null);
  assert.equal(resolveImported([row(5, 100000)],
    [media(50, 101000, {path: 'DCIM/Camera/'})])[0].uri, null);
  assert.equal(resolveImported([row(5, 100000, null)],
    [media(50, 101000)])[0].uri, null);
  assert.equal(resolveImported([row(5, 100000), row(6, 100500)],
    [media(50, 101000)])[0].uri, null);
});
