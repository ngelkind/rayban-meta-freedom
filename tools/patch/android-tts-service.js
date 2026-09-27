/* Stella's own TTS service is a candidate speaker for the glasses. It accepts
 * text and an AudioPlayer; the saved app constructs EV0 with ERB/ERC, whose
 * output flows to DataX. Kept independent of transcription and model choice.
 * This binding is NOT physically verified and is not enabled in agent.js.
 */
'use strict';

(function (root) {
  const MAX_SPOKEN_CHARS = 3000;

  class TtsSpeaker {
    constructor({api, player, useCase, suspend, locale = 'en_US',
      onStage = () => {}}) {
      if (!api || typeof api.BrE !== 'function' || !player ||
          typeof suspend !== 'function') throw new Error('TTS adapter incomplete');
      this.api = api;
      this.player = player;
      this.useCase = useCase;
      this.suspend = suspend;
      this.locale = locale;
      this.onStage = onStage;
    }

    async speak({requestId, text, signal}) {
      if (signal?.aborted) throw new Error('speech cancelled');
      if (typeof requestId !== 'string' || !requestId || requestId.length > 160 ||
          typeof text !== 'string' || !text.trim() || text.length > MAX_SPOKEN_CHARS) {
        throw new Error('invalid speech request');
      }
      // BrE is TtsApiImpl.speak. A00 on its result awaits playback completion.
      // Parameters mirror the app's MlServicePlayground speakAndVerify call,
      // except we choose the ASSISTANT use case instead of UNSPECIFIED.
      this.onStage('requesting');
      const pending = await this.suspend(continuation => this.api.BrE(
        this.player, this.useCase, text, this.locale, 'rayban-proxy:' + requestId, null,
        continuation, 4, 100, 100, false), signal);
      if (!pending || typeof pending.A00 !== 'function') {
        throw new Error('TTS service returned no playback handle');
      }
      try {
        this.onStage('awaiting-playback');
        await this.suspend(continuation => pending.A00(continuation), signal);
        this.onStage('played');
      } catch (error) {
        if (signal?.aborted && typeof this.player.stop === 'function') {
          try { this.player.stop(); } catch (_) {}
        }
        throw error;
      }
    }
  }

  let continuationClass = null;
  let nextToken = 1;
  const waiting = new Map();

  function continuationType() {
    if (continuationClass !== null) return continuationClass;
    const Empty = Java.use('X.0FQ');
    const Failure = Java.use('X.0Fz');
    continuationClass = Java.registerClass({
      name: 'com.raybanproxy.VoiceContinuation',
      implements: [Java.use('X.0FW')],
      fields: {token: 'int'},
      methods: {
        getContext() { return Empty.A00.value; },
        resumeWith(result) {
          const entry = waiting.get(this.token.value);
          if (!entry) return;
          try { Failure.A01(result); entry.resolve(result); }
          catch (error) { entry.reject(new Error('TTS service failed: ' + String(error))); }
        }
      }
    });
    return continuationClass;
  }

  function suspend(call, signal, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let token = 0;
      let timer = null;
      let settled = false;
      function finish(error, result) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancelled);
        waiting.delete(token);
        if (error) reject(error); else resolve(result);
      }
      function cancelled() { finish(new Error('speech cancelled')); }
      if (signal?.aborted) { cancelled(); return; }
      timer = setTimeout(() => finish(new Error('TTS service timed out')), timeoutMs);
      if (signal) signal.addEventListener('abort', cancelled, {once: true});
      setImmediate(() => Java.perform(() => {
        if (settled) return;
        try {
          const Type = continuationType();
          const continuation = Type.$new();
          token = nextToken++;
          continuation.token.value = token;
          waiting.set(token, {resolve: value => finish(null, value),
            reject: error => finish(error)});
          const result = call(continuation);
          if (result === null || String(result) !== 'COROUTINE_SUSPENDED') {
            Java.use('X.0Fz').A01(result);
            finish(null, result);
          }
        } catch (error) {
          finish(new Error('TTS service call failed: ' + String(error)));
        }
      }));
    });
  }

  function findPlayer() {
    const players = [];
    for (const klass of ['X.12D', 'X.ER8']) {
      try {
        Java.choose(klass, {onMatch(instance) {
          const field = klass === 'X.12D' ? 'A04' : 'A06';
          const player = instance[field].value;
          if (player !== null) players.push(Java.retain(player));
        }, onComplete() {}});
      } catch (_) { /* A device stack may not be present in this build. */ }
    }
    if (players.length !== 1) throw new Error('one connected device player required');
    return players[0];
  }

  function fromAndroid({onStage = () => {}, useCase = 'assistant'} = {}) {
    let result = null;
    Java.performNow(() => {
      const app = Java.use('android.app.ActivityThread').currentApplication();
      if (app === null) throw new Error('application context unavailable');
      const caseName = useCase === 'unspecified' ?
        'TTS_USE_CASE_UNSPECIFIED' : 'TTS_USE_CASE_ASSISTANT';
      const selectedCase = Java.retain(Java.use('X.Gcf').valueOf(caseName));
      if (selectedCase === null) throw new Error('TTS use case unavailable');
      result = new TtsSpeaker({
        api: Java.retain(Java.use('X.El6').A00(app)), player: findPlayer(),
        useCase: selectedCase,
        suspend, onStage
      });
    });
    return result;
  }

  const api = {TtsSpeaker, fromAndroid, suspend, MAX_SPOKEN_CHARS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidTtsService = api;
})(globalThis);
