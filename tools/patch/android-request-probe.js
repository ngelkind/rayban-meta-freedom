/* One diagnostic voice-request suppression. This is never used for the AI
 * replacement: it only proves whether this native handoff controls Meta's
 * answer. No transcript or interaction identifier is recorded. */
'use strict';

(function (root) {
  const WINDOW_MS = 15000;

  class OneTurnWindow {
    constructor(now = () => Date.now()) {
      this.now = now;
      this.until = 0;
      this.used = false;
    }
    decision() {
      const now = this.now();
      if (this.until && now >= this.until) return 'pass';
      if (this.until) return 'suppress';
      if (this.used) return 'pass';
      return 'first';
    }
    begin() {
      this.used = true;
      this.until = this.now() + WINDOW_MS;
    }
  }

  function install({token, onState = () => {}, now} = {}) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(token)) {
      throw new Error('probe token invalid');
    }
    const app = Java.use('android.app.ActivityThread').currentApplication();
    if (app === null) throw new Error('application context unavailable');
    const prefs = app.getSharedPreferences('rayban-proxy-diagnostics', 0);
    if (String(prefs.getString('requestProbeId', '')) === token) {
      onState('already-attempted');
      return {disable() {}};
    }
    const window = new OneTurnWindow(now);
    const target = Java.use('com.meta.air.SgOacrApi');
    const original = target.executeVoiceRequest.overload('java.lang.String',
      'java.lang.String', 'com.facebook.assistant.thrift.VoiceRequestOptions',
      'com.meta.air.InteractionStartCallback');
    let enabled = true;
    original.implementation = function (a, b, options, callback) {
      if (!enabled) return original.call(this, a, b, options, callback);
      const decision = window.decision();
      if (decision === 'pass') return original.call(this, a, b, options, callback);
      if (decision === 'first') {
        // Mark the attempt before dropping any request. A crash or restart
        // must not silently repeat the experiment.
        if (!prefs.edit().putString('requestProbeId', token).commit()) {
          onState('marker-failed');
          return original.call(this, a, b, options, callback);
        }
        window.begin();
        onState('suppressed');
      }
      // This is the app's declared failure callback, rather than leaving an
      // interaction pending. Duplicate handoffs for the same turn are also
      // suppressed for 15 seconds; later turns pass through unchanged.
      if (callback !== null) {
        try { callback.onComplete(false); }
        catch (_) { onState('callback-failed'); }
      }
      return;
    };
    onState('armed');
    return {disable() { enabled = false; }};
  }

  const api = {OneTurnWindow, install, WINDOW_MS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidRequestProbe = api;
})(globalThis);
