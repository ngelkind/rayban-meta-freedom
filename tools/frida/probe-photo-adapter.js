/* One-shot read-only proof that AndroidPhoto adapters can read full media.
 * Send counts, size and format only; never export photo bytes or file paths.
 */
'use strict';

(async function () {
  try {
    const maximum = await RaybanAndroidPhoto.database.maxPhotoId();
    const rows = await RaybanAndroidPhoto.database.query(RaybanPhotoSource.QUERY, [0]);
    const first = rows[0];
    if (!first) { send({kind: 'photo-adapter', maxId: maximum, rows: 0}); return; }
    const bytes = await RaybanAndroidPhoto.files.read(first.uri, 30 * 1024 * 1024);
    const mime = RaybanMedia.format(bytes);
    send({kind: 'photo-adapter', maxId: maximum, rows: rows.length,
      sizeMatches: bytes.length === first.size, expectedBytes: first.size,
      actualBytes: bytes.length, mime: mime});
    bytes.fill(0);
  } catch (error) {
    send({kind: 'photo-adapter', error: String(error)});
  }
})();
