/* Observe-only assistant boundary trace. It never records audio, text, IDs,
 * or request bodies. Hooks always call the original exactly once. The entire
 * module is disabled unless trace.assistant is explicitly enabled.
 */
'use strict';

(function (root) {
  const TAG = 'RaybanTrace';
  const MAX_EVENTS = 300;
  const FRAME_BATCH = 100;
  const HOOKS = Object.freeze([
    {klass: 'X.ENk', method: 'A07', args: ['X.ENk', 'java.nio.ByteBuffer'], name: 'micHeader', buffer: 1},
    {klass: 'X.ENk', method: 'A06', args: ['X.ENk', 'java.nio.ByteBuffer'], name: 'micFrame', buffer: 1},
    {klass: 'X.ELc', method: 'A0W', args: ['X.ELh', 'java.lang.String'], name: 'turnEntryW'},
    {klass: 'X.ELc', method: 'A0M', args: ['com.facebook.assistant.thrift.InteractionRequest', 'java.lang.String'], name: 'turnEntryM'},
    {klass: 'com.meta.air.SgOacrApi', method: 'executeVoiceRequest', args: [
      'java.lang.String', 'java.lang.String', 'com.facebook.assistant.thrift.VoiceRequestOptions',
      'com.meta.air.InteractionStartCallback'], name: 'nativeHandoff'},
    {klass: 'com.facebook.assistant.sdk.apis.interaction.NativeInteractionListener',
      method: 'onTranscription', args: ['java.nio.ByteBuffer'], name: 'transcription', buffer: 0},
    {klass: 'com.facebook.assistant.sdk.apis.interaction.NativeInteractionListener',
      method: 'onTtsMessage', args: ['java.lang.String', 'java.lang.String'], name: 'ttsText'},
    {klass: 'com.facebook.assistant.sdk.apis.interaction.NativeInteractionListener',
      method: 'onAction', args: ['java.lang.String', 'java.nio.ByteBuffer', 'java.lang.String',
        'boolean', 'boolean', 'boolean', 'java.lang.String'], name: 'action', buffer: 1},
    {klass: 'X.ERC', method: 'Bt8', args: ['X.Gcf', 'java.lang.String', '[B', 'int', 'int',
      'long', 'boolean', 'boolean', 'boolean', 'boolean', 'boolean'],
    name: 'replyAudioLegacy', array: 2},
    {klass: 'X.ERB', method: 'Bt8', args: ['X.Gcf', 'java.lang.String', '[B', 'int', 'int',
      'long', 'boolean', 'boolean', 'boolean', 'boolean', 'boolean'],
    name: 'replyAudioConnectivity', array: 2},
    {klass: 'com.meta.air.services.impl.TtsApiImpl', method: 'BrE', args: [
      'com.meta.air.audio.AudioPlayer', 'X.Gcf', 'java.lang.String', 'java.lang.String',
      'java.lang.String', 'java.lang.String', 'X.0FW', 'byte', 'int', 'int', 'boolean'],
    name: 'ttsSpeak'},
    {klass: 'X.EV0', method: 'play', args: [
      'com.meta.air.audio.AudioDesc', 'com.meta.air.audio.AudioPlayerCallback'],
    name: 'audioPlay'},
    {klass: 'X.EUx', method: 'write', args: ['java.nio.ByteBuffer'],
      name: 'audioWrite', buffer: 0},
    {klass: 'com.facebook.wearable.datax.LocalChannel', method: 'send',
      args: ['com.facebook.wearable.datax.TypedBuffer'], name: 'dataxSend'},
    {klass: 'com.facebook.wearable.datax.LocalChannel', method: 'handleReceived',
      args: ['int', 'java.nio.ByteBuffer'], name: 'dataxReceive'},
    {klass: 'android.media.AudioTrack', method: 'play', args: [], name: 'trackPlay'},
    {klass: 'android.media.AudioTrack', method: 'write',
      args: ['java.nio.ByteBuffer', 'int', 'int'], name: 'trackWrite', buffer: 0},
    {klass: 'android.media.AudioTrack', method: 'write',
      args: ['[B', 'int', 'int'], name: 'trackWriteBytes', array: 0}
  ]);

  class FrameCounter {
    constructor(emit, batch = FRAME_BATCH, eventName = 'micFrames') {
      this.emit = emit;
      this.batch = batch;
      this.eventName = eventName;
      this.frames = 0;
      this.bytes = 0;
      this.firstMs = 0;
    }
    add(bytes, now = Date.now()) {
      if (this.frames === 0) this.firstMs = now;
      this.frames++;
      this.bytes += Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
      if (this.frames >= this.batch) this.flush('batch', now);
    }
    flush(reason, now = Date.now()) {
      if (!this.frames) return;
      this.emit(this.eventName, {reason, frames: this.frames, bytes: this.bytes,
        durationMs: Math.max(0, now - this.firstMs)});
      this.frames = 0;
      this.bytes = 0;
      this.firstMs = 0;
    }
  }

  function install(options = {}) {
    let active = true;
    let events = 0;
    const installed = [];
    const faults = [];
    const log = Java.use('android.util.Log');
    function emit(name, fields = {}) {
      if (!active || events >= MAX_EVENTS) return;
      events++;
      try { log.i(TAG, JSON.stringify(Object.assign({event: name, atMs: Date.now()}, fields))); }
      catch (_) { /* Trace must never affect the original app. */ }
    }
    const mic = new FrameCounter(emit);
    const output = new FrameCounter(emit, FRAME_BATCH, 'audioWrites');
    const dataxAudio = new FrameCounter(emit, FRAME_BATCH, 'dataxAudioFrames');
    const incomingAudio = new FrameCounter(emit, FRAME_BATCH, 'incomingAudioFrames');
    const trackAudio = new FrameCounter(emit, FRAME_BATCH, 'trackAudioWrites');
    for (const spec of HOOKS) {
      try {
        const target = Java.use(spec.klass);
        const original = target[spec.method].overload.apply(target[spec.method], spec.args);
        original.implementation = function () {
          const args = Array.from(arguments);
          if (active) {
            try {
              if (spec.name === 'micFrame') {
                mic.add(args[spec.buffer] === null ? 0 : Number(args[spec.buffer].remaining()));
              } else if (spec.name === 'audioWrite') {
                output.add(args[spec.buffer] === null ? 0 : Number(args[spec.buffer].remaining()));
              } else if (spec.name === 'trackWrite' || spec.name === 'trackWriteBytes') {
                const item = args[spec.buffer === undefined ? spec.array : spec.buffer];
                trackAudio.add(item === null ? 0 : spec.buffer === undefined ?
                  Number(args[2]) : Number(args[1]));
              } else if (spec.name === 'dataxSend') {
                const typed = args[0];
                const service = Number(this.service.value);
                const opcode = Number(typed.type.value);
                const bytes = Number(typed.bytes.value.remaining());
                if (opcode === 5003 || opcode === 6003) {
                  dataxAudio.add(bytes);
                } else if (service === 15 || [5002, 6000, 6002, 6004].includes(opcode)) {
                  dataxAudio.flush('boundary');
                  emit(spec.name, {service, opcode, bytes});
                }
              } else if (spec.name === 'dataxReceive') {
                const service = Number(this.service.value);
                const opcode = Number(args[0]);
                const bytes = args[1] === null ? 0 : Number(args[1].remaining());
                if (service === 15) {
                  if (opcode === 5003 || opcode === 6003) incomingAudio.add(bytes);
                  else {
                    incomingAudio.flush('boundary');
                    emit(spec.name, {service, opcode, bytes});
                  }
                }
              } else {
                const detail = {};
                if (spec.buffer !== undefined) {
                  detail.bytes = args[spec.buffer] === null ? null : Number(args[spec.buffer].remaining());
                }
                if (spec.array !== undefined) {
                  detail.bytes = args[spec.array] === null ? null : Number(args[spec.array].length);
                }
                if (spec.name === 'ttsText') detail.textLength = args[0] === null ? null : String(args[0]).length;
                if (spec.name === 'micHeader' || spec.name === 'turnEntryW' ||
                    spec.name === 'turnEntryM') mic.flush('boundary');
                if (spec.name === 'audioPlay' || spec.name === 'ttsSpeak' ||
                    spec.name === 'trackPlay') {
                  output.flush('boundary');
                  trackAudio.flush('boundary');
                }
                emit(spec.name, detail);
              }
            } catch (_) { /* A trace error cannot change a voice turn. */ }
          }
          return original.call(this, ...args);
        };
        installed.push(spec.name);
      } catch (error) {
        const fault = spec.name + ': ' + String(error).slice(0, 160);
        faults.push(fault);
        if (typeof options.onFault === 'function') options.onFault(fault);
      }
    }
    emit('traceInstalled', {hooks: installed, missing: faults.map(item => item.split(':')[0])});
    return {
      setEnabled(value) {
        if (active && !value) {
          mic.flush('disabled'); output.flush('disabled');
          dataxAudio.flush('disabled'); incomingAudio.flush('disabled');
          trackAudio.flush('disabled');
        }
        active = !!value;
      },
      status() { return {active, events, installed: installed.slice(), faults: faults.slice()}; }
    };
  }

  const api = {install, FrameCounter, HOOKS, MAX_EVENTS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAssistantTrace = api;
})(globalThis);
