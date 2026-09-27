/* Private configuration lookup and persistent budget accounting. No API key
 * is embedded in the APK. Configuration UI is a separate feature gate.
 */
'use strict';

(function (root) {
  const PREFS = 'rayban-proxy-assistant';
  const BUDGET = 'budgetV1';
  function onJava(fn) {
    let result;
    let fault;
    Java.performNow(() => { try { result = fn(); } catch (error) { fault = error; } });
    if (fault) throw fault;
    return result;
  }
  function prefs() {
    const app = Java.use('android.app.ActivityThread').currentApplication();
    if (app === null) throw new Error('application context unavailable');
    return app.getSharedPreferences(PREFS, 0);
  }
  const budgetStore = {
    read: () => onJava(() => {
      const value = String(prefs().getString(BUDGET, ''));
      return value ? JSON.parse(value) : null;
    }),
    write: value => onJava(() => {
      const item = JSON.stringify(value);
      if (!prefs().edit().putString(BUDGET, item).commit()) {
        throw new Error('model budget could not be persisted');
      }
    })
  };
  function keyFor(provider) {
    if (!['nvidia', 'openai', 'openrouter', 'anthropic', 'gemini'].includes(provider)) {
      throw new Error('unsupported provider');
    }
    return onJava(() => {
      const key = String(prefs().getString('apiKey:' + provider, ''));
      if (!key) throw new Error('provider key is not configured');
      return key;
    });
  }
  const api = {budgetStore, keyFor};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidAssistantStore = api;
})(globalThis);
