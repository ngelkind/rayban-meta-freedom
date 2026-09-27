/* Read-only assistant route trace for the already-provisioned research app.
 * Records method names, sizes and timestamps only. No transcript, audio, model
 * reply or authentication material is written to the capture.
 */
'use strict';

Java.perform(function () {
  const Native = Java.use('com.facebook.assistant.sdk.apis.interaction.NativeInteractionListener');
  const Rpc = Java.use('com.facebook.assistant.stella.platform.network.RpcDispatcherImpl');
  const Audio = Java.use('com.facebook.assistant.sdk.io.impl.NativeAudioOutput');
  function emit(name, extra) {
    send({kind: 'assistant-boundary', name, atMs: Date.now(), ...extra});
  }
  function remaining(buffer) {
    try { return buffer === null ? null : Number(buffer.remaining()); }
    catch (_) { return null; }
  }
  const transcription = Native.onTranscription.overload('java.nio.ByteBuffer');
  transcription.implementation = function (buffer) {
    emit('onTranscription', {bytes: remaining(buffer)});
    return transcription.call(this, buffer);
  };
  const tts = Native.onTtsMessage.overload('java.lang.String', 'java.lang.String');
  tts.implementation = function (first, second) {
    emit('onTtsMessage', {firstLength: first === null ? null : String(first).length,
      secondLength: second === null ? null : String(second).length});
    return tts.call(this, first, second);
  };
  const complete = Native.interactionCompleted.overload('java.nio.ByteBuffer');
  complete.implementation = function (buffer) {
    emit('interactionCompleted', {bytes: remaining(buffer)});
    return complete.call(this, buffer);
  };
  const rpc = Rpc.send.overload('java.nio.ByteBuffer');
  rpc.implementation = function (buffer) {
    emit('rpcSend', {bytes: remaining(buffer)});
    return rpc.call(this, buffer);
  };
  const play = Audio.startPlaying.overload('java.nio.ByteBuffer', 'java.lang.String',
    'com.facebook.assistant.oacr.utils.OacrPromise');
  play.implementation = function (buffer, id, promise) {
    emit('audioStartPlaying', {bytes: remaining(buffer), hasId: id !== null});
    return play.call(this, buffer, id, promise);
  };
  emit('traceReady', {});
});
