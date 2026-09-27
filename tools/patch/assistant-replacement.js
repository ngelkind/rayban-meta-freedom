/* Compose the independent final-transcript, model, audio-gate and speaker
 * parts. Runtime hooks are installed by the caller only after explicit opt-in.
 */
'use strict';

(function (root) {
  class ReplacementSession {
    constructor({TurnEngine, AudioGate, model, speaker, mode = 'shadow',
      onState = () => {}}) {
      if (!TurnEngine || !AudioGate || !model) throw new Error('assistant parts missing');
      if (mode === 'replace' && (!speaker || typeof speaker.speak !== 'function')) {
        throw new Error('replacement speaker missing');
      }
      this.mode = mode;
      this.gate = new AudioGate();
      this.turns = new TurnEngine({model, mode,
        speaker: mode === 'replace' ? {speak: async request => {
          if (!this.gate.claim(request.requestId)) {
            throw new Error('original audio already released');
          }
          await speaker.speak(request);
        }} : null,
        onState});
    }

    async onFinal(event) {
      if (!event || !event.final) return {status: 'ignored'};
      if (this.mode === 'replace' && !this.gate.arm(event.requestId)) {
        return {status: 'original-already-started'};
      }
      const result = await this.turns.accept(event);
      if (this.mode === 'replace' && result.status !== 'complete') {
        this.gate.release(event.requestId);
      }
      return result;
    }

    disable() { this.turns.disable(); this.gate.disable(); }

    enable() { this.turns.enable(); }
  }

  const api = {ReplacementSession};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAssistantReplacement = api;
})(globalThis);
