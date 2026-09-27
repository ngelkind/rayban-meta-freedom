/* One voice turn, with replaceable transcript/model/speaker boundaries.
 * No transcript or reply is persisted. The original app is not suppressed by
 * this module; a verified output interceptor must do that separately.
 */
'use strict';

(function (root) {
  class TurnEngine {
    constructor({model, speaker = null, mode = 'shadow', onState = () => {},
      timeoutMs = 45000, maxInputChars = 3000, maxOutputChars = 3000}) {
      if (!model || typeof model.ask !== 'function') throw new Error('model adapter required');
      if (!['shadow', 'replace'].includes(mode)) throw new Error('invalid turn mode');
      if (mode === 'replace' && (!speaker || typeof speaker.speak !== 'function')) {
        throw new Error('replace mode needs a speaker');
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
        throw new Error('invalid turn timeout');
      }
      this.model = model;
      this.speaker = speaker;
      this.mode = mode;
      this.onState = onState;
      this.timeoutMs = timeoutMs;
      this.maxInputChars = maxInputChars;
      this.maxOutputChars = maxOutputChars;
      this.active = null;
      this.seen = new Set();
      this.enabled = true;
    }

    _state(phase) {
      try { this.onState({phase, mode: this.mode}); } catch (_) {}
    }

    disable() {
      this.enabled = false;
      if (this.active) this.active.controller.abort();
    }

    enable() { this.enabled = true; }

    async accept({requestId, text, final = true}) {
      if (!this.enabled || !final) return {status: 'ignored'};
      if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 160 ||
          typeof text !== 'string' || !text.trim() || text.length > this.maxInputChars) {
        return {status: 'invalid'};
      }
      if (this.seen.has(requestId)) return {status: 'duplicate'};
      if (this.active) return {status: 'busy'};
      this.seen.add(requestId);
      // Only turn IDs are retained, and only a small rolling window.
      if (this.seen.size > 32) this.seen.delete(this.seen.values().next().value);
      const controller = new AbortController();
      const turn = {controller};
      this.active = turn;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this._state('model');
        const answer = await this.model.ask({requestId, text, signal: controller.signal});
        if (controller.signal.aborted) throw new Error('turn cancelled');
        if (!answer || answer.requestId !== requestId || typeof answer.text !== 'string' ||
            !answer.text.trim() || answer.text.length > this.maxOutputChars) {
          throw new Error('model reply invalid');
        }
        if (this.mode === 'replace') {
          this._state('speaking');
          await this.speaker.speak({requestId, text: answer.text, signal: controller.signal});
          if (controller.signal.aborted) throw new Error('turn cancelled');
        }
        this._state('complete');
        return {status: 'complete', mode: this.mode};
      } catch (_) {
        // Do not return an exception containing a transcript, answer, or key.
        this._state(controller.signal.aborted ? 'cancelled' : 'failed');
        return {status: controller.signal.aborted ? 'cancelled' : 'failed'};
      } finally {
        clearTimeout(timer);
        if (this.active === turn) this.active = null;
      }
    }
  }

  const api = {TurnEngine};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAssistantTurn = api;
})(globalThis);
