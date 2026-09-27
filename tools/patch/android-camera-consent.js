/* Turns on the glasses' camera-for-AI consent settings that the companion app
 * hides in some regions. The glasses report "mmai enabled: 0" and ignore
 * RemoteImageCaptureRequest while these are off.
 *
 * Uses the app's own settings path, the one its toggles use:
 *   SmartGlassesAssistantSettings.A06(key X.3H1, deviceType X.19c, deviceId,
 *     source, value, checkLastSuccessful)  -- set and sync to the glasses
 *   SmartGlassesAssistantSettings.A08(key, deviceId) -- current boolean value
 * The device type and id are learned from the app's own settings reads
 * (A01(key, deviceType, deviceId)). Nothing is sent to Meta's servers by this
 * module beyond what the app's normal settings sync does.
 */
'use strict';

(function (root) {
  const SETTINGS = 'com.facebook.wearable.glasses.assistant.settings.SmartGlassesAssistantSettings';
  const DEFAULT_KEYS = ['MMAI_USER_CONSENT_ENABLED', 'CAMERA_SETTING_ENABLED',
    'CLOUD_AI_UNDERSTANDING', 'CLOUD_MEDIA_PROCESSING_ENABLED'];
  const SOURCE = 'rayban_proxy_camera_ai';

  function install({keys = DEFAULT_KEYS, onState = () => {}, defer = fn => setTimeout(fn, 0)}) {
    const Settings = Java.use(SETTINGS);
    const Keys = Java.use('X.3H1');
    const read = Settings.A01.overload('X.3H1', 'X.19c', 'java.lang.String');
    const get = Settings.A08.overload('X.3H1', 'java.lang.String');
    const set = Settings.A06.overload('X.3H1', 'X.19c', 'java.lang.String',
      'java.lang.String', 'boolean', 'boolean');
    let device = null;
    let applied = false;

    function apply() {
      if (applied || device === null) return;
      applied = true;
      const report = [];
      for (const name of keys) {
        try {
          const key = Keys.valueOf(name);
          const before = !!get.call(Settings, key, device.id);
          if (!before) set.call(Settings, key, device.type, device.id, SOURCE, true, false);
          const after = !!get.call(Settings, key, device.id);
          report.push(name + ':' + (before ? 1 : 0) + '>' + (after ? 1 : 0));
        } catch (error) {
          report.push(name + ':error ' + String(error && error.message || error).slice(0, 80));
        }
      }
      onState(report.join(' '));
    }

    read.implementation = function (key, type, id) {
      const result = read.call(this, key, type, id);
      if (!applied && device === null && type !== null && id !== null && String(id)) {
        device = {type: Java.retain(type), id: String(id)};
        onState('device found; applying');
        defer(() => Java.performNow(() => {
          try { apply(); } catch (error) {
            onState('apply failed: ' + String(error && error.message || error).slice(0, 160));
          }
        }));
      }
      return result;
    };
    onState('waiting for glasses settings');
    return {status: () => ({applied, found: device !== null})};
  }

  // Read-only: camera/AI entries in the SettingsSDK caches, i.e. the values
  // the glasses reported, plus the "<device><:><key>" id format.
  function dumpDeviceSettings(pattern = /mmai|camera|cloud_ai|cloud_media|live_ai|feather/i) {
    const out = [];
    const manager = Java.use('com.facebook.wearable.sdk.settings.sync.WearableSettingsManager');
    for (const name of ['A05', 'A06', 'A0B', 'A0C']) {
      let map;
      try { map = manager[name].value; } catch (error) {
        out.push(name + ' error ' + String(error && error.message || error).slice(0, 100));
        continue;
      }
      if (map === null) { out.push(name + ' null'); continue; }
      const entries = Java.cast(map, Java.use('java.util.Map')).entrySet().toArray();
      out.push(name + ' size=' + entries.length);
      let sampled = 0;
      for (let i = 0; i < entries.length && out.length < 60; i++) {
        const entry = Java.cast(entries[i], Java.use('java.util.Map$Entry'));
        const key = String(entry.getKey()).slice(0, 90);
        const value = entry.getValue();
        const text = value === null ? 'null' : String(value);
        // Only true/false values are shown; anything else is reduced to its type.
        const shown = /^(true|false)$/.test(text) ? text :
          (value === null ? 'null' : String(value.$className || 'object'));
        if (pattern.test(key)) out.push(name + ' * ' + key + '=' + shown);
        else if (sampled < 6) { sampled++; out.push(name + '   ' + key + '=' + shown); }
      }
    }
    return out;
  }

  const api = {install, dumpDeviceSettings, DEFAULT_KEYS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidCameraConsent = api;
})(globalThis);
