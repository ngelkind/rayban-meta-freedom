/* Reply replacement inside Meta's own reply stream.
 *
 * Meta's server reply reaches the glasses through X.EUx (DeviceOutputStream,
 * created by X.EV0.play): EUx.write(ByteBuffer) carries framed Opus
 * ([uint32 LE length][packet]) and EUx.close() ends the reply. Per turn:
 *   1. The first write is replaced by an empty buffer. It opens the BLE stream
 *      and sends the stream header, so the glasses show "thinking".
 *   2. Every Meta audio write is dropped, and Meta's close is held back.
 *   3. Our reply (respond(transcript), or the fixed text) is synthesized and
 *      encoded to framed Opus by the Java encoder, then written into the same
 *      stream, and only then is the stream closed.
 * The glasses play our reply exactly like Meta's: same channel, same volume,
 * normal end of turn. If encoding fails the stream is closed and the phrase
 * is spoken through the fallback speaker (Android TTS over Bluetooth media).
 * Replies the glasses resolve on-frame (e.g. IN:GET_TIME) never reach EUx.
 */
'use strict';

(function (root) {
  const MAX_TURNS = 32;
  const FRESH_MS = 8000;
  const TRANSCRIPT_WAIT_MS = 1500;
  const MAX_REPLY_CHARS = 3000;
  const HOLD_MS = 25000;          // longest we keep Meta's stream open
  const ENCODE_WAIT_MS = 15000;
  const PACKETS_PER_TICK = 4;     // 80 ms of audio every 40 ms: 2x real time
  const TICK_MS = 40;

  function install({text, encoder, fallback = null, respond = null,
    onState = () => {}, now = () => Date.now(),
    sleep = ms => new Promise(r => setTimeout(r, ms)), onJava = fn => fn()}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200) {
      throw new Error('fixed reply text invalid');
    }
    if (!encoder || typeof encoder.encode !== 'function') {
      throw new Error('reply encoder missing');
    }
    if (respond !== null && typeof respond !== 'function') {
      throw new Error('fixed reply responder invalid');
    }
    const EUx = Java.use('X.EUx');
    const write = EUx.write.overload('java.nio.ByteBuffer');
    const close = EUx.close.overload();
    const turns = new Map();
    let enabled = true;
    let spoken = 0;
    // Frida reaches the original method only from inside a replacement. Our
    // own writes/closes, made later from a timer, re-enter these hooks; the
    // injecting thread is recognized and passed through to Meta's original.
    let injectingThread = null;
    const threadId = () => (typeof Process !== 'undefined' ?
      Process.getCurrentThreadId() : 'test-thread');
    function inject(fn) {
      onJava(() => {
        injectingThread = threadId();
        try { fn(); } finally { injectingThread = null; }
      });
    }
    const ours = () => injectingThread !== null && injectingThread === threadId();

    // Latest transcript per interaction id (Meta's reply stream carries the
    // same id). A final version wins; otherwise the latest partial is used,
    // because follow-up turns often get no final before the reply starts.
    const transcripts = new Map();
    function onTranscript(event) {
      if (!enabled || !event || typeof event.text !== 'string' || !event.text.trim()) return;
      const id = String(event.requestId || '');
      const old = transcripts.get(id);
      if (old && old.final && !event.final) return;
      transcripts.delete(id);
      transcripts.set(id, {text: event.text, final: !!event.final, at: now()});
      while (transcripts.size > MAX_TURNS) {
        transcripts.delete(transcripts.keys().next().value);
      }
    }

    async function takeTranscript(id) {
      const deadline = now() + TRANSCRIPT_WAIT_MS;
      while (true) {
        const item = transcripts.get(id);
        if (item && item.final) { transcripts.delete(id); return item.text; }
        if (now() >= deadline) break;
        await sleep(100);
      }
      const partial = transcripts.get(id);
      if (partial) { transcripts.delete(id); return partial.text; }
      // Unknown or mismatched id: the most recent fresh transcript, if any.
      let latest = null;
      for (const [key, item] of transcripts) {
        if (now() - item.at <= FRESH_MS && (!latest || item.at >= latest.item.at)) {
          latest = {key, item};
        }
      }
      if (!latest) return null;
      transcripts.delete(latest.key);
      return latest.item.text;
    }

    async function replyFor(id) {
      if (respond === null) return {text, source: 'fixed'};
      const transcript = await takeTranscript(id);
      if (transcript === null) return {text, source: 'no-transcript'};
      try {
        const answer = await respond({requestId: id, text: transcript});
        if (typeof answer === 'string' && answer.trim()) {
          return {text: answer.slice(0, MAX_REPLY_CHARS), source: 'respond'};
        }
        return {text, source: 'empty-reply'};
      } catch (error) {
        return {text, source: 'respond-failed: ' +
          String(error && error.message || error).slice(0, 160)};
      }
    }

    function finishTurn(turn) {
      if (turn.finished) return;
      turn.finished = true;
      if (turn.timer) clearTimeout(turn.timer);
      if (turn.closeRequested) inject(() => close.call(turn.stream));
    }

    async function run(turn) {
      onState('replying');
      const reply = await replyFor(turn.id);
      if (turn.finished) return;
      onState('encoding (' + reply.source + ')');
      let packets = null;
      try {
        packets = await encoder.encode({requestId: 'reply-' + turn.id, text: reply.text,
          sampleRate: turn.sampleRate, bitrate: turn.bitrate, timeoutMs: ENCODE_WAIT_MS});
      } catch (error) {
        onState('encode-failed: ' + String(error && error.message || error).slice(0, 160));
      }
      if (turn.finished) return;
      if (!packets || packets.length === 0) {
        finishTurn(turn);
        if (fallback) {
          try { await fallback.speak({requestId: 'fallback-' + turn.id, text: reply.text}); }
          catch (_) {}
        }
        return;
      }
      for (let i = 0; i < packets.length && !turn.finished; i += PACKETS_PER_TICK) {
        const batch = packets.slice(i, i + PACKETS_PER_TICK);
        inject(() => { for (const packet of batch) write.call(turn.stream, packet); });
        await sleep(TICK_MS);
      }
      spoken++;
      onState('spoke-' + spoken + ' (' + reply.source + ', ' + packets.length + ' packets)');
      if (turn.closeRequested) finishTurn(turn);
      else turn.delivered = true;
    }

    function idOf(stream) {
      try {
        const desc = stream.A01.value;
        return desc === null ? '' : String(desc.getInteractionId());
      } catch (_) { return ''; }
    }

    function describe(stream) {
      let sampleRate = 24000;
      let bitrate = 32000;
      try {
        const desc = stream.A01.value;
        const rate = Number(desc.getSamplingRate());
        const bps = Number(desc.getOpusCeltCbrBitrateBps());
        if (rate >= 8000 && rate <= 48000) sampleRate = rate;
        if (bps >= 16000 && bps <= 128000) bitrate = bps;
      } catch (_) {}
      return {sampleRate, bitrate};
    }

    write.implementation = function (buffer) {
      if (!enabled || ours()) return write.call(this, buffer);
      const id = idOf(this) || 'unknown-' + Math.floor(now() / 15000);
      if (turns.has(id)) return;   // Meta's audio: dropped
      const turn = Object.assign({id, stream: Java.retain(this), closeRequested: false,
        delivered: false, finished: false, timer: null}, describe(this));
      turns.set(id, turn);
      while (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value);
      // Opens the BLE stream and sends the header; carries no audio.
      try { write.call(this, Java.use('java.nio.ByteBuffer').allocate(0)); }
      catch (_) { onState('stream-start-failed'); }
      turn.timer = setTimeout(() => {
        if (!turn.finished) { onState('hold-timeout'); finishTurn(turn); }
      }, HOLD_MS);
      setImmediate(() => run(turn).catch(error => {
        onState('reply-failed: ' + String(error && error.message || error).slice(0, 160));
        finishTurn(turn);
      }));
    };

    close.implementation = function () {
      if (!enabled || ours()) return close.call(this);
      const turn = turns.get(idOf(this));
      if (!turn || turn.finished || turn.delivered) {
        if (turn) turn.finished = true;
        return close.call(this);
      }
      turn.closeRequested = true;   // closed after our audio is written
    };

    onState('ready');
    return {onTranscript, onFinal: onTranscript, disable() {
      enabled = false;
      transcripts.clear();
      for (const turn of turns.values()) finishTurn(turn);
    }, enable() { enabled = true; }};
  }

  // Java encoder bridge: framed Opus bytes split into one ByteBuffer per
  // packet (4-byte length prefix included), as Meta's writes are framed.
  function encoderFromAndroid() {
    let helper;
    let app;
    let ByteBuffer;
    let Arrays;
    Java.performNow(() => {
      app = Java.use('android.app.ActivityThread').currentApplication();
      if (app === null) throw new Error('application context unavailable');
      helper = Java.use('dev.raybanfreedom.ttstest.HeadlessSpeakerOpus');
      ByteBuffer = Java.use('java.nio.ByteBuffer');
      Arrays = Java.use('java.util.Arrays');
    });
    return {
      async encode({requestId, text, sampleRate, bitrate, timeoutMs}) {
        let started = false;
        Java.performNow(() => {
          started = helper.start(app, text, requestId, sampleRate, bitrate);
        });
        if (!started) throw new Error('encoder busy or rejected input');
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          let stage = 'unknown';
          Java.performNow(() => { stage = String(helper.status(requestId)); });
          if (stage === 'ready') break;
          if (stage === 'failed' || stage === 'unknown' || stage === 'cancelled') {
            throw new Error('encoder ' + stage);
          }
          await new Promise(r => setTimeout(r, 50));
        }
        const packets = [];
        Java.performNow(() => {
          const bytes = helper.take(requestId);
          if (bytes === null) return;
          const total = bytes.length;
          let offset = 0;
          while (offset + 4 <= total) {
            const size = (bytes[offset] & 255) | ((bytes[offset + 1] & 255) << 8) |
              ((bytes[offset + 2] & 255) << 16) | ((bytes[offset + 3] & 255) << 24);
            if (size <= 0 || size > 960 || offset + 4 + size > total) break;
            packets.push(Java.retain(ByteBuffer.wrap(
              Arrays.copyOfRange(bytes, offset, offset + 4 + size))));
            offset += 4 + size;
          }
        });
        if (packets.length === 0) {
          Java.performNow(() => helper.cancel(requestId));
          throw new Error('encoder timed out or produced no audio');
        }
        return packets;
      }
    };
  }

  const api = {install, encoderFromAndroid, FRESH_MS, TRANSCRIPT_WAIT_MS, HOLD_MS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidFixedReply = api;
})(globalThis);
