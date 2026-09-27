/* Stella's final transcription callback. This observer always calls the
 * original first and only then queues work; it cannot suppress Meta's reply.
 * HyperThrift indexes are from EOc.onTranscription in Stella 289.0.0.25.162.
 */
'use strict';

(function (root) {
  function finalTranscript(desc) {
    if (!desc || typeof desc.A01 !== 'function') return null;
    const final = desc.A01(8);
    const text = desc.A01(0);
    const requestId = desc.A01(4);
    if (String(final) !== 'true' || text === null || requestId === null) return null;
    const value = String(text);
    const id = String(requestId);
    if (!value.trim() || value.length > 3000 || !id || id.length > 160) return null;
    return {requestId: id, text: value, final: true};
  }

  // Any transcription update, partial or final. Follow-up turns in one
  // conversation often start Meta's reply without a final transcript.
  function transcriptEvent(desc) {
    if (!desc || typeof desc.A01 !== 'function') return null;
    const text = desc.A01(0);
    const requestId = desc.A01(4);
    if (text === null || requestId === null) return null;
    const value = String(text);
    const id = String(requestId);
    if (!value.trim() || value.length > 3000 || !id || id.length > 160) return null;
    return {requestId: id, text: value, final: String(desc.A01(8)) === 'true'};
  }

  function install(onFinal, onFault = () => {}, {partials = false} = {}) {
    if (typeof onFinal !== 'function') throw new Error('transcript consumer required');
    const target = Java.use('X.EOc');
    const original = target.onTranscription.overload(
      'com.facebook.assistant.sdk.thrift.TranscriptionDesc');
    let enabled = true;
    original.implementation = function (desc) {
      const result = original.call(this, desc);
      if (enabled) {
        let event = null;
        try { event = partials ? transcriptEvent(desc) : finalTranscript(desc); }
        catch (_) { onFault('transcript parse failed'); }
        if (event) setImmediate(() => {
          if (!enabled) return;
          try { Promise.resolve(onFinal(event)).catch(() => onFault('turn consumer failed')); }
          catch (_) { onFault('turn consumer failed'); }
        });
      }
      return result;
    };
    return {disable() { enabled = false; }, enable() { enabled = true; }};
  }

  const api = {finalTranscript, transcriptEvent, install};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidTranscript = api;
})(globalThis);
