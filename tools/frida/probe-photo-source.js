/* Read-only end-to-end source check on the research app. The mock destination
 * observes only byte counts; no photo content leaves the process.
 */
'use strict';

(async function () {
  let photos = 0;
  let totalBytes = 0;
  const destination = new RaybanMedia.PhotoRouter({deliver: async photo => {
    if (photo.mime !== 'image/jpeg') throw new Error('unexpected image format');
    photos++;
    totalBytes += photo.bytes.length;
  }});
  const source = new RaybanPhotoSource.PhotoSource({
    database: RaybanAndroidPhoto.database,
    files: RaybanAndroidPhoto.files,
    ledger: {baseline: () => 0, initialize: () => {}, status: () => null,
      transition: () => {}}, // do not alter the phone
    destination
  });
  try {
    const result = await source.poll();
    send({kind: 'photo-source-proof', photos: photos, totalBytes: totalBytes,
      delivered: result.delivered});
  } catch (error) {
    send({kind: 'photo-source-proof', error: String(error), photos: photos});
  }
})();
