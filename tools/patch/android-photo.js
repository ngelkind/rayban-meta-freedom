/* Android adapters for PhotoSource. StellaDatabase and file:// full-photo URIs
 * were inspected read-only on the provisioned OnePlus 13. This code is dormant
 * until a destination is configured and the watcher is explicitly enabled.
 */
'use strict';

(function (root) {
  const DB_NAME = 'StellaDatabase';
  const PREFS_NAME = 'rayban-proxy';
  const PREF_BASELINE = 'photoBaselineV2';
  const PREF_STATE = 'photoStateV2:';
  const PREF_ERROR = 'photoErrorV1:';
  const IMPORT_PATH = 'Download/Meta AI/';
  const IMPORT_WINDOW_MS = 3000;

  // Stella removes its private full-file row after import. Android's media
  // library keeps the file with a capture timestamp about 1-2 seconds later.
  // A timestamp alone may be ambiguous; never choose among multiple matches.
  function resolveImported(rows, candidates) {
    const output = rows.map(row => Object.assign({}, row));
    const choices = new Map();
    const claims = new Map();
    for (const row of output) {
      if (row.uri || !Number.isSafeInteger(row.importedAt) ||
          !Number.isSafeInteger(row.capturedAt)) continue;
      const matches = candidates.filter(item => item.path === IMPORT_PATH &&
        ['image/jpeg', 'image/png'].includes(item.mime) &&
        Number.isSafeInteger(item.id) && Number.isSafeInteger(item.size) && item.size > 0 &&
        Math.abs(item.takenAt - row.capturedAt) <= IMPORT_WINDOW_MS);
      if (matches.length !== 1) continue;
      choices.set(row.id, matches[0]);
      claims.set(matches[0].id, (claims.get(matches[0].id) || 0) + 1);
    }
    for (const row of output) {
      const item = choices.get(row.id);
      if (!item || claims.get(item.id) !== 1) continue;
      row.uri = 'content://media/external/images/media/' + item.id;
      row.size = item.size;
    }
    return output;
  }

  function onJava(fn) {
    return new Promise((resolve, reject) => {
      Java.perform(() => {
        try { resolve(fn()); } catch (error) { reject(error); }
      });
    });
  }

  function app() {
    const instance = Java.use('android.app.ActivityThread').currentApplication();
    if (instance === null) throw new Error('application context unavailable');
    return instance;
  }

  function openDb() {
    const file = app().getDatabasePath(DB_NAME);
    return Java.use('android.database.sqlite.SQLiteDatabase')
      .openDatabase(String(file.getPath()), null, 1); // OPEN_READONLY
  }

  function importedCandidates(rows) {
    const wanted = rows.filter(row => !row.uri && Number.isSafeInteger(row.importedAt) &&
      Number.isSafeInteger(row.capturedAt));
    if (!wanted.length) return [];
    const earliest = Math.min(...wanted.map(row => row.capturedAt)) - IMPORT_WINDOW_MS;
    const latest = Math.max(...wanted.map(row => row.capturedAt)) + IMPORT_WINDOW_MS;
    const uri = Java.use('android.net.Uri').parse('content://media/external/images/media');
    const strings = Java.array('java.lang.String', [
      '_id', 'datetaken', 'relative_path', 'mime_type', '_size']);
    const values = Java.array('java.lang.String', [IMPORT_PATH, String(earliest), String(latest)]);
    const cursor = app().getContentResolver().query(uri, strings,
      'relative_path = ? AND datetaken >= ? AND datetaken <= ? AND _size > 0',
      values, 'datetaken ASC');
    if (cursor === null) throw new Error('imported media query unavailable');
    try {
      const candidates = [];
      while (cursor.moveToNext()) {
        if (candidates.length >= 100) throw new Error('too many imported media candidates');
        candidates.push({
          id: Number(cursor.getLong(0).toString()),
          takenAt: Number(cursor.getLong(1).toString()),
          path: String(cursor.getString(2)),
          mime: String(cursor.getString(3)),
          size: Number(cursor.getLong(4).toString())
        });
      }
      return candidates;
    } finally { cursor.close(); }
  }

  const database = {
    maxPhotoId: () => onJava(() => {
      const db = openDb();
      let cursor = null;
      try {
        cursor = db.rawQuery("SELECT COALESCE(MAX(media_item_id),0) FROM media_item WHERE type='photo'", null);
        cursor.moveToFirst();
        return Number(cursor.getLong(0).toString());
      } finally {
        if (cursor !== null) cursor.close();
        db.close();
      }
    }),
    query: async (sql, args) => {
      const rows = await onJava(() => {
        const db = openDb();
        let cursor = null;
        try {
          cursor = db.rawQuery(sql, Java.array('java.lang.String', args.map(String)));
          const rows = [];
          while (cursor.moveToNext()) {
            rows.push({id: Number(cursor.getLong(0).toString()),
              captureId: cursor.isNull(1) ? null : String(cursor.getString(1)),
              capturedAt: Number(cursor.getLong(2).toString()),
              uri: cursor.isNull(3) ? null : String(cursor.getString(3)),
              size: cursor.isNull(4) ? null : Number(cursor.getLong(4).toString()),
              importedAt: cursor.isNull(5) ? null : Number(cursor.getLong(5).toString())});
          }
          return rows;
        } finally {
          if (cursor !== null) cursor.close();
          db.close();
        }
      });
      if (!rows.some(row => !row.uri && row.importedAt !== null)) return rows;
      const candidates = await onJava(() => importedCandidates(rows));
      return resolveImported(rows, candidates);
    }
  };

  function decodedFile(file, maxBytes) {
      if (!file.isFile() || file.length() <= 0) {
        // Stella can publish the gallery row before the user imports the full
        // image. This is not a failed delivery attempt; it may take minutes.
        const error = new Error('full photo is not imported yet');
        error.outcome = 'deferred';
        throw error;
      }
      if (file.length() > maxBytes) {
        const error = new Error('photo exceeds size limit');
        error.outcome = 'failed';
        throw error;
      }
      const BitmapFactory = Java.use('android.graphics.BitmapFactory');
      const Options = Java.use('android.graphics.BitmapFactory$Options');
      const options = Options.$new();
      options.inJustDecodeBounds.value = true;
      BitmapFactory.decodeFile.overload('java.lang.String', 'android.graphics.BitmapFactory$Options')
        .call(BitmapFactory, String(file.getPath()), options);
      const width = options.outWidth.value;
      const height = options.outHeight.value;
      if (width <= 0 || height <= 0 || width > 16000 || height > 16000 ||
          width * height > 100000000) throw new Error('photo dimensions invalid');
      options.inJustDecodeBounds.value = false;
      options.inSampleSize.value = 8;
      const decoded = BitmapFactory.decodeFile.overload('java.lang.String', 'android.graphics.BitmapFactory$Options')
        .call(BitmapFactory, String(file.getPath()), options);
      if (decoded === null) throw new Error('photo decoder rejected file');
      decoded.recycle();
      // Frida's native File API copies the whole file into one ArrayBuffer.
      // Iterating a multi-megabyte Java byte[] through the bridge held the
      // phone's app thread at 100% CPU for tens of seconds in the live probe.
      return new Uint8Array(File.readAllBytes(String(file.getPath())));
  }

  function readImported(uri, maxBytes) {
    const JFile = Java.use('java.io.File');
    const stage = JFile.createTempFile.overload('java.lang.String', 'java.lang.String', 'java.io.File')
      .call(JFile, 'rayban-import-', '.part', app().getCacheDir());
    let input = null;
    let output = null;
    try {
      input = app().getContentResolver().openInputStream(uri);
      if (input === null) {
        const error = new Error('imported photo is not readable yet');
        error.outcome = 'deferred';
        throw error;
      }
      output = Java.use('java.io.FileOutputStream').$new(stage);
      const buffer = Java.array('byte', new Array(64 * 1024).fill(0));
      let size = 0;
      let emptyReads = 0;
      while (true) {
        const count = input.read(buffer, 0, buffer.length);
        if (count < 0) break;
        if (count === 0) {
          if (++emptyReads > 3) throw new Error('imported photo read stalled');
          continue;
        }
        emptyReads = 0;
        size += count;
        if (size > maxBytes) {
          const error = new Error('imported photo exceeds size limit');
          error.outcome = 'failed';
          throw error;
        }
        output.write(buffer, 0, count);
      }
      output.close();
      output = null;
      return decodedFile(stage, maxBytes);
    } finally {
      if (output !== null) try { output.close(); } catch (_) {}
      if (input !== null) try { input.close(); } catch (_) {}
      try { stage.delete(); } catch (_) {}
    }
  }

  const files = {
    read: (uriText, maxBytes) => onJava(() => {
      const uri = Java.use('android.net.Uri').parse(uriText);
      const scheme = String(uri.getScheme());
      if (scheme === 'file') {
        const file = Java.use('java.io.File').$new(String(uri.getPath()));
        return decodedFile(file, maxBytes);
      }
      if (scheme === 'content' &&
          /^content:\/\/media\/external\/images\/media\/[0-9]+$/.test(uriText)) {
        return readImported(uri, maxBytes);
      }
      throw new Error('unsupported photo URI');
    })
  };

  const ledger = {
    baseline: () => onJava(() => {
      const prefs = app().getSharedPreferences(PREFS_NAME, 0);
      if (!prefs.contains(PREF_BASELINE)) return null;
      return Number(prefs.getLong(PREF_BASELINE, -1).toString());
    }),
    initialize: value => onJava(() => {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid photo ledger value');
      const prefs = app().getSharedPreferences(PREFS_NAME, 0);
      if (prefs.contains(PREF_BASELINE)) return;
      if (!prefs.edit().putLong(PREF_BASELINE, value).commit()) throw new Error('photo baseline write failed');
    }),
    status: id => onJava(() => {
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid photo id');
      const prefs = app().getSharedPreferences(PREFS_NAME, 0);
      return prefs.contains(PREF_STATE + id) ? String(prefs.getString(PREF_STATE + id, '')) : null;
    }),
    transition: (id, state) => onJava(() => {
      if (!Number.isSafeInteger(id) || id < 0 ||
          !(['sending', 'acknowledged', 'uncertain', 'failed'].includes(state) ||
            /^retry:\d{1,3}$/.test(state))) throw new Error('invalid photo state');
      const prefs = app().getSharedPreferences(PREFS_NAME, 0);
      if (!prefs.edit().putString(PREF_STATE + id, state).commit()) {
        throw new Error('photo state write failed');
      }
    }),
    note: (id, message) => onJava(() => {
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid photo id');
      // Keep diagnostics app-private and bounded. Never include bytes or URLs.
      const safe = String(message).replace(/https?:\/\/\S+/g, '[url]')
        .replace(/\/data\/\S+/g, '[file]').slice(0, 200);
      app().getSharedPreferences(PREFS_NAME, 0).edit()
        .putString(PREF_ERROR + id, safe).apply();
    })
  };

  const api = {database, files, ledger, resolveImported, IMPORT_PATH};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidPhoto = api;
})(globalThis);
