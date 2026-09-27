/* Bounded decision point for an original spoken reply. The Android hook can
 * map EV0.play to this gate; a model/speaker can claim the same turn. If the
 * model is late, fails, or the buffer fills, the original reply is released.
 */
'use strict';

(function (root) {
  class AudioGate {
    constructor({maxBytes = 2 * 1024 * 1024, waitMs = 10000} = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8 * 1024 * 1024 ||
          !Number.isSafeInteger(waitMs) || waitMs < 100 || waitMs > 30000) {
        throw new Error('invalid audio gate limits');
      }
      this.maxBytes = maxBytes;
      this.waitMs = waitMs;
      this.entries = new Map();
    }

    _put(id, entry) {
      this.entries.set(id, entry);
      while (this.entries.size > 32) {
        const [oldId, old] = this.entries.entries().next().value;
        if (old.timer) clearTimeout(old.timer);
        if (old.status === 'pending') this.release(oldId);
        this.entries.delete(oldId);
      }
    }

    arm(id) {
      if (typeof id !== 'string' || !id || id.length > 160) return false;
      const old = this.entries.get(id);
      if (old) return old.status === 'pending';
      const entry = {status: 'pending', streams: [], timer: null};
      entry.timer = setTimeout(() => this.release(id), this.waitMs);
      this._put(id, entry);
      return true;
    }

    // A reply that began before its transcript cannot be pulled back.
    observeOriginal(id) {
      if (typeof id !== 'string' || !id || id.length > 160 || this.entries.has(id)) return;
      this._put(id, {status: 'released', streams: [], timer: null});
    }

    has(id) { return this.entries.has(id) && this.entries.get(id).status !== 'released'; }

    status(id) { return this.entries.get(id)?.status || null; }

    open(id, openOriginal, onComplete) {
      const entry = this.entries.get(id);
      if (!entry || entry.status === 'released') return openOriginal();
      const stream = {bytes: 0, chunks: [], closed: false, original: null,
        openOriginal, onComplete};
      entry.streams.push(stream);
      const releaseStream = () => {
        if (stream.original === null) stream.original = openOriginal();
        for (const chunk of stream.chunks) stream.original.write(chunk);
        stream.chunks = [];
        if (stream.closed) stream.original.close();
      };
      const completeCustom = () => {
        stream.chunks = [];
        if (stream.closed) onComplete();
      };
      stream.release = releaseStream;
      stream.completeCustom = completeCustom;
      if (entry.status === 'custom') completeCustom();
      return {
        write: chunk => {
          if (!(chunk instanceof Uint8Array)) throw new Error('audio chunk invalid');
          if (stream.closed) throw new Error('audio stream closed');
          if (entry.status === 'released') { releaseStream(); stream.original.write(chunk); return; }
          if (entry.status === 'custom') return;
          stream.bytes += chunk.length;
          if (stream.bytes > this.maxBytes) {
            this.release(id);
            stream.original.write(chunk);
            return;
          }
          stream.chunks.push(chunk.slice());
        },
        close: () => {
          if (stream.closed) return;
          stream.closed = true;
          if (entry.status === 'released') releaseStream();
          else if (entry.status === 'custom') completeCustom();
        }
      };
    }

    claim(id) {
      const entry = this.entries.get(id);
      if (!entry || entry.status !== 'pending') return false;
      entry.status = 'custom';
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      for (const stream of entry.streams) stream.completeCustom();
      return true;
    }

    release(id) {
      const entry = this.entries.get(id);
      if (!entry || entry.status !== 'pending') return false;
      entry.status = 'released';
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      for (const stream of entry.streams) stream.release();
      return true;
    }

    disable() {
      for (const id of this.entries.keys()) this.release(id);
    }
  }

  const api = {AudioGate};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAssistantAudioGate = api;
})(globalThis);
