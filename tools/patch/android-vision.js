/* Photo for camera questions ("what am I looking at"). When the glasses
 * deliver a capture, Stella passes the JPEG to
 * com.meta.air.MultimodalApi.onImageFrameReceived(interactionId, ByteBuffer,
 * int, int, int). We call the original first, then keep a base64 copy of the
 * latest photo in memory only (never on disk) for the reply step, which sends
 * it with the question to a vision model and then drops it.
 */
'use strict';

(function (root) {
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

  function install({onState = () => {}, now = () => Date.now()} = {}) {
    const api = Java.use('com.meta.air.MultimodalApi');
    const frame = api.onImageFrameReceived.overload('java.lang.String',
      'java.nio.ByteBuffer', 'int', 'int', 'int');
    const Base64 = Java.use('android.util.Base64');
    let latest = null;
    let count = 0;

    frame.implementation = function (id, buffer, a, b, c) {
      const result = frame.call(this, id, buffer, a, b, c);
      try {
        const copy = buffer.duplicate();
        const size = Number(copy.remaining());
        if (size > 0 && size <= MAX_IMAGE_BYTES) {
          const bytes = Java.array('byte', new Array(size).fill(0));
          copy.get(bytes);
          latest = {id: id === null ? '' : String(id), at: now(),
            base64: String(Base64.encodeToString(bytes, 2 /* NO_WRAP */)), size};
          count++;
          onState('photo-' + count + ' (' + Math.round(size / 1024) + ' KB)');
        }
      } catch (error) {
        onState('photo copy failed: ' + String(error && error.message || error).slice(0, 120));
      }
      return result;
    };

    // The photo for this turn: same interaction id, or the most recent one
    // when ids differ (capture and reply can use different sub-interaction ids).
    function take(id, maxAgeMs) {
      const item = latest;
      if (!item || now() - item.at > maxAgeMs) return null;
      if (item.id && id && item.id !== id && now() - item.at > 5000) return null;
      latest = null;
      return item.base64;
    }

    onState('waiting for photos');
    return {take};
  }

  const exported = {install};
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.RaybanAndroidVision = exported;
})(globalThis);
