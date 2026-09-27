/*
 * Read the owned-device Airshield identity from Stella's in-process
 * LightSharedPreferences objects. Run only on the user's own provisioned app.
 *
 * The script sends one structured object back to the Frida host. It deliberately
 * does not print secret values to Android logcat or write them on the phone.
 */

'use strict';

const PREFIXES = [
  'key-',
  'device-identity-certificate-',
  'device-identity-serial-number-',
  'device-identity-device-ec-pub-key-',
  'device-identity-device-ec-kdk-',
  'owned-',
  'secondary-certificate-'
];

function wanted(key) {
  for (let i = 0; i < PREFIXES.length; i++) {
    if (key.indexOf(PREFIXES[i]) === 0) return true;
  }
  return false;
}

Java.perform(function () {
  const LightPrefs = Java.use('com.facebook.crudolib.prefs.LightSharedPreferencesImpl');
  const found = [];
  let pending = 0;

  Java.choose(LightPrefs.$className, {
    onMatch: function (instance) {
      pending++;
      try {
        const all = instance.getAll();
        const iterator = all.entrySet().iterator();
        const values = {};
        while (iterator.hasNext()) {
          const entry = iterator.next();
          const key = String(entry.getKey());
          if (wanted(key)) values[key] = String(entry.getValue());
        }
        if (Object.keys(values).length > 0) {
          found.push({ preference_name: String(instance._name.value), values: values });
        }
      } catch (e) {
        found.push({ error: String(e) });
      }
    },
    onComplete: function () {
      send({
        type: 'airshield_identity',
        instances_scanned: pending,
        stores: found
      });
      console.log('[AIRSHIELD] scanned=' + pending + ' matching_stores=' + found.length);
    }
  });
});

