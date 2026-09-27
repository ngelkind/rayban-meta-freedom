/* One-turn diagnostic at the Java DataX dispatcher. Drop only service 15
 * audio frames, never control packets or other services. No payload is read. */
'use strict';

(function (root) {
  const WINDOW_MS = 15000;

  function install({token, onState = () => {}, now = () => Date.now()} = {}) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(token)) {
      throw new Error('DataX probe token invalid');
    }
    const app = Java.use('android.app.ActivityThread').currentApplication();
    if (app === null) throw new Error('application context unavailable');
    const prefs = app.getSharedPreferences('rayban-proxy-diagnostics', 0);
    if (String(prefs.getString('dataxProbeId', '')) === token) {
      onState('already-attempted');
      return {disable() {}};
    }
    const voice = Java.use('com.meta.air.SgOacrApi').executeVoiceRequest.overload(
      'java.lang.String', 'java.lang.String',
      'com.facebook.assistant.thrift.VoiceRequestOptions',
      'com.meta.air.InteractionStartCallback');
    const receive = Java.use('com.facebook.wearable.datax.LocalChannel')
      .handleReceived.overload('int', 'java.nio.ByteBuffer');
    let enabled = true;
    let until = 0;
    let dropped = 0;
    voice.implementation = function (a, b, options, callback) {
      if (enabled && !until &&
          prefs.edit().putString('dataxProbeId', token).commit()) {
        until = now() + WINDOW_MS;
        onState('armed-turn');
      }
      return voice.call(this, a, b, options, callback);
    };
    receive.implementation = function (opcode, buffer) {
      if (enabled && until && now() < until && Number(this.service.value) === 15 &&
          (Number(opcode) === 5003 || Number(opcode) === 6003)) {
        dropped++;
        if (dropped === 1 || dropped % 100 === 0) onState('dropped-' + dropped);
        return;
      }
      return receive.call(this, opcode, buffer);
    };
    onState('waiting-for-turn');
    return {disable() { enabled = false; }, count() { return dropped; }};
  }

  const api = {install, WINDOW_MS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidDataxInputProbe = api;
})(globalThis);
