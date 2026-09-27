/* Optional EV0.play hook. It buffers only a turn explicitly armed by the
 * replacement session. Every other stream calls Stella's original method.
 * The synthetic OutputStream speaks the same Java interface as EV0.play.
 */
'use strict';

(function (root) {
  const CUSTOM_PREFIX = 'rayban-proxy:';
  const streams = new Map();
  let nextToken = 1;
  let StreamType = null;

  function bufferBytes(buffer, maxBytes) {
    const copy = buffer.duplicate();
    const size = Number(copy.remaining());
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error('audio frame too large');
    }
    const array = Java.array('byte', new Array(size).fill(0));
    copy.get(array);
    return Uint8Array.from(array, value => value & 255);
  }

  function classForStream() {
    if (StreamType) return StreamType;
    StreamType = Java.registerClass({
      name: 'com.raybanproxy.BufferedReplyStream',
      implements: [Java.use('com.meta.air.streams.OutputStream')],
      fields: {token: 'int'},
      methods: {
        write(buffer) {
          const entry = streams.get(this.token.value);
          if (!entry) return;
          let bytes;
          try { bytes = bufferBytes(buffer, entry.maxBytes); }
          catch (_) { entry.direct(buffer); return; }
          entry.write(bytes);
        },
        close() {
          const token = this.token.value;
          const entry = streams.get(token);
          streams.delete(token);
          if (entry) entry.close();
        }
      }
    });
    return StreamType;
  }

  function install(gate) {
    if (!gate || typeof gate.open !== 'function' || typeof gate.has !== 'function') {
      throw new Error('audio gate required');
    }
    const target = Java.use('X.EV0');
    const original = target.play.overload('com.meta.air.audio.AudioDesc',
      'com.meta.air.audio.AudioPlayerCallback');
    let enabled = true;
    original.implementation = function (desc, callback) {
      const self = this;
      const id = desc === null ? '' : String(desc.getInteractionId());
      if (!enabled || !id || id.startsWith(CUSTOM_PREFIX)) {
        return original.call(self, desc, callback);
      }
      if (!gate.has(id)) {
        gate.observeOriginal(id);
        return original.call(self, desc, callback);
      }
      let nativeStream = null;
      const openOriginal = () => {
        if (nativeStream === null) Java.performNow(() => {
          nativeStream = original.call(self, desc, callback);
        });
        return {
          write(bytes) {
            Java.performNow(() => {
              const signed = Java.array('byte', Array.from(bytes,
                value => value > 127 ? value - 256 : value));
              nativeStream.write(Java.use('java.nio.ByteBuffer').wrap(signed));
            });
          },
          close() { Java.performNow(() => nativeStream.close()); }
        };
      };
      const stream = gate.open(id, openOriginal,
        () => Java.performNow(() => callback.onComplete()));
      const proxy = classForStream().$new();
      const token = nextToken++;
      proxy.token.value = token;
      streams.set(token, {write: bytes => stream.write(bytes),
        close: () => stream.close(), direct: buffer => {
          if (gate.status(id) === 'custom') return;
          gate.release(id);
          if (nativeStream === null) openOriginal();
          nativeStream.write(buffer);
        },
        maxBytes: gate.maxBytes});
      return proxy;
    };
    return {disable() { enabled = false; gate.disable(); },
      enable() { enabled = true; }};
  }

  const api = {install, CUSTOM_PREFIX};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidReplyGate = api;
})(globalThis);
