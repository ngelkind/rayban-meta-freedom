/* Android framework speech from inside the companion process. No Activity,
 * service, separate package or Meta-private coroutine is involved. */
'use strict';

(function (root) {
  const MAX_SPOKEN_CHARS = 3000;
  const POLL_MS = 200;
  const TIMEOUT_MS = 60000;

  class SystemSpeaker {
    constructor({bridge, onStage = () => {}, pollMs = POLL_MS,
      timeoutMs = TIMEOUT_MS}) {
      if (!bridge || typeof bridge.start !== 'function' ||
          typeof bridge.status !== 'function' ||
          typeof bridge.cancel !== 'function') {
        throw new Error('system speech bridge incomplete');
      }
      this.bridge = bridge;
      this.onStage = onStage;
      this.pollMs = pollMs;
      this.timeoutMs = timeoutMs;
    }

    async speak({requestId, text, signal}) {
      if (signal?.aborted) throw new Error('speech cancelled');
      if (typeof requestId !== 'string' || !requestId || requestId.length > 160 ||
          typeof text !== 'string' || !text.trim() || text.length > MAX_SPOKEN_CHARS) {
        throw new Error('invalid speech request');
      }
      if (!this.bridge.start(text, requestId)) {
        throw new Error('glasses not selected or speech busy');
      }
      this.onStage('initializing');
      const started = Date.now();
      try {
        while (Date.now() - started < this.timeoutMs) {
          if (signal?.aborted) throw new Error('speech cancelled');
          const stage = this.bridge.status(requestId);
          if (stage === 'completed') {
            this.onStage('played');
            return;
          }
          if (stage === 'failed' || stage === 'cancelled' || stage === 'unknown') {
            throw new Error('system speech ' + stage);
          }
          this.onStage(stage);
          await new Promise(resolve => setTimeout(resolve, this.pollMs));
        }
        throw new Error('system speech timed out');
      } catch (error) {
        this.bridge.cancel(requestId);
        throw error;
      }
    }
  }

  function fromAndroid({onStage = () => {}} = {}) {
    let helper;
    let app;
    Java.performNow(() => {
      app = Java.use('android.app.ActivityThread').currentApplication();
      if (app === null) throw new Error('application context unavailable');
      helper = Java.use('dev.raybanfreedom.ttstest.HeadlessSpeaker');
    });
    const bridge = {
      start(text, id) {
        let started = false;
        Java.performNow(() => { started = helper.start(app, text, id); });
        return started;
      },
      status(id) {
        let stage = 'unknown';
        Java.performNow(() => { stage = String(helper.status(id)); });
        return stage;
      },
      cancel(id) {
        Java.performNow(() => { helper.cancel(id); });
      }
    };
    return new SystemSpeaker({bridge, onStage});
  }

  const api = {SystemSpeaker, fromAndroid, MAX_SPOKEN_CHARS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidSystemTts = api;
})(globalThis);
