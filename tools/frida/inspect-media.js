/* Read-only inspection of the user's installed research app. Outputs database
 * names and media table schemas/counts only; never media URIs or bytes.
 */
'use strict';

Java.perform(function () {
  const app = Java.use('android.app.ActivityThread').currentApplication();
  if (app === null) { send({kind: 'media-inspect', error: 'no application'}); return; }
  const directory = app.getDatabasePath('placeholder').getParentFile();
  const names = directory.list();
  const SQLiteDatabase = Java.use('android.database.sqlite.SQLiteDatabase');
  const results = [];
  for (let i = 0; names !== null && i < names.length; i++) {
    const name = String(names[i]);
    if (name.endsWith('-journal') || name.endsWith('-wal') || name.endsWith('-shm')) continue;
    if (!directory.getPath()) continue;
    let db = null;
    let cursor = null;
    try {
      db = SQLiteDatabase.openDatabase(directory.getPath() + '/' + name, null, 1);
      cursor = db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%media%' OR name LIKE '%capture%')", null);
      const tables = [];
      while (cursor.moveToNext()) tables.push(String(cursor.getString(0)));
      cursor.close();
      cursor = null;
      const summary = {};
      if (name === 'StellaDatabase') {
        for (const table of ['media_file', 'media_item', 'capture', 'media_item_to_media_file', 'media_item_display']) {
          cursor = db.rawQuery('PRAGMA table_info(' + table + ')', null);
          const columns = [];
          while (cursor.moveToNext()) columns.push(String(cursor.getString(1)));
          cursor.close();
          cursor = db.rawQuery('SELECT COUNT(*) FROM ' + table, null);
          cursor.moveToFirst();
          summary[table] = {columns: columns, rows: cursor.getLong(0)};
          cursor.close();
          cursor = null;
        }
        cursor = db.rawQuery('SELECT type,is_ready,current_file_size,uri FROM media_file ORDER BY media_file_id DESC LIMIT 10', null);
        const Uri = Java.use('android.net.Uri');
        const recent = [];
        while (cursor.moveToNext()) {
          const uriText = cursor.isNull(3) ? null : String(cursor.getString(3));
          const uri = uriText === null ? null : Uri.parse(uriText);
          recent.push({type: String(cursor.getString(0)), ready: cursor.getInt(1) !== 0,
            size: cursor.getLong(2).toString(), scheme: uri === null ? null : String(uri.getScheme()),
            authority: uri === null ? null : String(uri.getAuthority())});
        }
        cursor.close();
        cursor = null;
        summary.recent = recent;
        cursor = db.rawQuery("SELECT COUNT(*) FROM media_item_display mid JOIN media_item mi ON mi.media_item_id=mid.media_item_id JOIN media_file mf ON mf.media_file_id=mid.display_full_media_file_id WHERE mi.type='photo' AND mf.is_ready=1 AND mf.uri IS NOT NULL", null);
        cursor.moveToFirst();
        summary.readyFullPhotos = cursor.getLong(0).toString();
        cursor.close();
        cursor = null;
        cursor = db.rawQuery("SELECT mf.uri,mf.current_file_size FROM media_item_display mid JOIN media_item mi ON mi.media_item_id=mid.media_item_id JOIN media_file mf ON mf.media_file_id=mid.display_full_media_file_id WHERE mi.type='photo' AND mf.is_ready=1 AND mf.uri IS NOT NULL ORDER BY mi.originally_created_timestamp_ms DESC LIMIT 1", null);
        if (cursor.moveToFirst()) {
          const uri = Uri.parse(String(cursor.getString(0)));
          const file = Java.use('java.io.File').$new(String(uri.getPath()));
          const report = {exists: file.exists(), dbSize: cursor.getLong(1).toString(),
            fileSize: file.exists() ? file.length().toString() : null};
          if (file.exists() && file.length() > 4) {
            const stream = Java.use('java.io.RandomAccessFile').$new(file, 'r');
            try {
              const first = stream.readUnsignedByte();
              const second = stream.readUnsignedByte();
              stream.seek(file.length() - 2);
              const last = stream.readUnsignedByte();
              const end = stream.readUnsignedByte();
              report.jpegComplete = first === 255 && second === 216 && last === 255 && end === 217;
            } finally { stream.close(); }
          }
          summary.sampleFullPhoto = report;
        }
        cursor.close();
        cursor = null;
      }
      results.push({database: name, tables: tables.slice(0, 40), summary: summary});
    } catch (error) {
      results.push({database: name, error: 'not readable as SQLite'});
    } finally {
      if (cursor !== null) cursor.close();
      if (db !== null) db.close();
    }
  }
  send({kind: 'media-inspect', databases: results});
});
