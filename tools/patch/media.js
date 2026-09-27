/* Complete-media boundary for future verified import hooks. A DataX capture
 * notification is deliberately not accepted as a photo.
 */
'use strict';

(function (root) {
  function format(bytes) {
    if (bytes.length >= 100 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
        bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
      let offset = 2;
      let frame = false;
      while (offset + 4 < bytes.length && bytes[offset] === 0xff) {
        const marker = bytes[offset + 1];
        if (marker === 0xda) return frame ? 'image/jpeg' : null;
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (length < 2 || offset + 2 + length > bytes.length) return null;
        if (marker >= 0xc0 && marker <= 0xc3) frame = true;
        offset += 2 + length;
      }
    }
    if (bytes.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10]
      .every((value, index) => bytes[index] === value) &&
        bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 13 &&
        bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82 &&
        bytes[bytes.length - 8] === 73 && bytes[bytes.length - 7] === 69 &&
        bytes[bytes.length - 6] === 78 && bytes[bytes.length - 5] === 68) return 'image/png';
    return null;
  }

  function rejected(message, outcome) {
    const error = new Error(message);
    error.outcome = outcome;
    return error;
  }

  class PhotoRouter {
    constructor(destination, options = {}) {
      if (!destination || typeof destination.deliver !== 'function') {
        throw new Error('photo destination must implement deliver');
      }
      this.destination = destination;
      this.maxBytes = options.maxBytes || 30 * 1024 * 1024;
      this.maxPending = options.maxPending || 2;
      this.pending = 0;
    }

    async deliver(photo) {
      if (!photo || !(photo.bytes instanceof Uint8Array) || !photo.captureId ||
          !Number.isFinite(photo.capturedAt)) throw new Error('incomplete photo metadata');
      if (photo.bytes.length > this.maxBytes) throw rejected('photo exceeds limit', 'failed');
      const mime = format(photo.bytes);
      // The gallery can advertise a full file before its final JPEG bytes are
      // durable. PhotoSource caps retries, so a permanently corrupt file still
      // stops after maxAttempts instead of being sent or retried forever.
      if (!mime) throw rejected('payload is not a complete supported image', 'retry');
      if (this.pending >= this.maxPending) throw rejected('photo queue is full', 'deferred');
      this.pending++;
      const owned = new Uint8Array(photo.bytes);
      try {
        return await this.destination.deliver({captureId: photo.captureId,
          capturedAt: photo.capturedAt, mime, bytes: owned});
      } finally {
        owned.fill(0);
        this.pending--;
      }
    }
  }

  const api = { PhotoRouter, format };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanMedia = api;
})(globalThis);
