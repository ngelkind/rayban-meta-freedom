/* One-turn diagnostic: keep glasses mic frames from Meta's Java input path.
 * This does not record audio. It proves whether ENk.A06 is a controlling
 * boundary before wiring frames to an independent recognizer. */
'use strict';

(function (root) {
  const WINDOW_MS = 15000;

  function install({token, onState = () => {}, now = () => Date.now()} = {}) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(token)) {
      throw new Error('mic probe token invalid');
    }
    const app = Java.use('android.app.ActivityThread').currentApplication();
    if (app === null) throw new Error('application context unavailable');
    const prefs = app.getSharedPreferences('rayban-proxy-diagnostics', 0);
    if (String(prefs.getString('micProbeId', '')) === token) {
      onState('already-attempted');
      return {disable() {}};
    }
    const voice = Java.use('com.meta.air.SgOacrApi').executeVoiceRequest.overload(
      'java.lang.String', 'java.lang.String',
      'com.facebook.assistant.thrift.VoiceRequestOptions',
      'com.meta.air.InteractionStartCallback');
    const mic = Java.use('X.ENk').A06.overload('X.ENk', 'java.nio.ByteBuffer');
    let enabled = true;
    let until = 0;
    let dropped = 0;
    voice.implementation = function (a, b, options, callback) {
      if (enabled && !until &&
          prefs.edit().putString('micProbeId', token).commit()) {
        until = now() + WINDOW_MS;
        onState('armed-turn');
      }
      return voice.call(this, a, b, options, callback);
    };
    mic.implementation = function (handler, buffer) {
      if (enabled && until && now() < until) {
        dropped++;
        if (dropped === 1 || dropped % 100 === 0) onState('dropped-' + dropped);
        return;
      }
      return mic.call(this, handler, buffer);
    };
    onState('waiting-for-turn');
    return {disable() { enabled = false; }, count() { return dropped; }};
  }

  const api = {install, WINDOW_MS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidMicProbe = api;
})(globalThis);
