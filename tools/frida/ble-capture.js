/*
 * ble-capture.js — framework-level BLE/BT capture for stella (com.facebook.stella)
 *
 * WHY THIS WORKS EVEN THOUGH TRANSPORT IS NATIVE:
 *   An Android app has no private native BLE API. Even Meta's native "Positron"
 *   transport must reach the radio through the Java android.bluetooth.* classes
 *   via JNI. So hooking those Java methods captures every control frame the app
 *   sends/receives — the on-air bytes (airshield-encrypted). Pair with an
 *   airshield hook (see ble-airshield.js, written after RE) to also get plaintext.
 *
 * REQUIRES: root + frida-server running on the phone, OR a frida gadget in a
 *   repacked stella. Run:  frida -U -f com.facebook.stella -l ble-capture.js --no-pause
 *   (or attach:            frida -U -n com.facebook.stella -l ble-capture.js )
 *
 * Output: tagged hex lines on the frida console. Redirect to a file to archive.
 */
'use strict';

function hex(bytes) {
  if (bytes === null) return '(null)';
  try {
    var b = Java.array('byte', bytes);
    var s = '';
    for (var i = 0; i < b.length; i++) {
      var v = (b[i] < 0 ? b[i] + 256 : b[i]).toString(16);
      s += (v.length === 1 ? '0' + v : v);
    }
    return s;
  } catch (e) { return '(hexerr ' + e + ')'; }
}

function uuidOf(obj) {
  try { return obj.getUuid().toString(); } catch (e) { return '?'; }
}

function ts() { return new Date().toISOString().substr(11, 12); }

Java.perform(function () {
  console.log('[*] ble-capture attached @ ' + ts());

  // ---- BluetoothGatt: outbound writes / reads / notify subscriptions ----
  try {
    var Gatt = Java.use('android.bluetooth.BluetoothGatt');

    // writeCharacteristic overloads (old: (char) / new API33+: (char, byte[], int))
    Gatt.writeCharacteristic.overloads.forEach(function (ov) {
      ov.implementation = function () {
        var a = arguments;
        var ch = a[0];
        var val = (a.length >= 2 && a[1] !== null) ? a[1] : (function () {
          try { return ch.getValue(); } catch (e) { return null; }
        })();
        console.log('[' + ts() + '] GATT WRITE char=' + uuidOf(ch) + ' len=' +
          (val ? Java.array('byte', val).length : 0) + ' data=' + hex(val));
        return ov.apply(this, a);
      };
    });

    Gatt.readCharacteristic.implementation = function (ch) {
      console.log('[' + ts() + '] GATT READ  req char=' + uuidOf(ch));
      return this.readCharacteristic(ch);
    };

    Gatt.setCharacteristicNotification.implementation = function (ch, en) {
      console.log('[' + ts() + '] GATT NOTIFY-SUB char=' + uuidOf(ch) + ' enable=' + en);
      return this.setCharacteristicNotification(ch, en);
    };

    Gatt.writeDescriptor.overloads.forEach(function (ov) {
      ov.implementation = function () {
        var d = arguments[0];
        var val = (arguments.length >= 2) ? arguments[1] : (function () {
          try { return d.getValue(); } catch (e) { return null; }
        })();
        console.log('[' + ts() + '] GATT WRITE-DESC ' + (function(){try{return d.getUuid()}catch(e){return '?'}})() +
          ' data=' + hex(val));
        return ov.apply(this, arguments);
      };
    });

    Gatt.requestMtu.implementation = function (m) {
      console.log('[' + ts() + '] GATT requestMtu=' + m);
      return this.requestMtu(m);
    };
    console.log('[+] hooked BluetoothGatt');
  } catch (e) { console.log('[-] BluetoothGatt hook: ' + e); }

  // ---- inbound: app's BluetoothGattCallback subclasses (notifications/reads) ----
  try {
    var Base = Java.use('android.bluetooth.BluetoothGattCallback');
    Java.enumerateLoadedClasses({
      onMatch: function (name) {
        if (name.indexOf('android.') === 0 || name.indexOf('[') === 0) return;
        var C;
        try { C = Java.use(name); } catch (e) { return; }
        var isCb = false;
        try { isCb = Base.class.isAssignableFrom(C.class); } catch (e) { return; }
        if (!isCb) return;
        ['onCharacteristicChanged', 'onCharacteristicRead', 'onCharacteristicWrite'].forEach(function (m) {
          if (!C[m]) return;
          try {
            C[m].overloads.forEach(function (ov) {
              ov.implementation = function () {
                var ch = arguments[1];
                // new API delivers value as a separate byte[] arg
                var val = null;
                for (var i = 2; i < arguments.length; i++) {
                  try { if (arguments[i] && Java.array('byte', arguments[i]).length >= 0) { val = arguments[i]; break; } } catch (e) {}
                }
                if (val === null) { try { val = ch.getValue(); } catch (e) {} }
                console.log('[' + ts() + '] GATT ' + m.replace('on', '').toUpperCase() +
                  ' char=' + uuidOf(ch) + ' data=' + hex(val) + '   [' + name + ']');
                return ov.apply(this, arguments);
              };
            });
          } catch (e) {}
        });
      },
      onComplete: function () { console.log('[+] hooked GATT callbacks'); }
    });
  } catch (e) { console.log('[-] callback hook: ' + e); }

  // ---- RFCOMM / L2CAP sockets (classic control / Spotify / wake channel) ----
  try {
    var Dev = Java.use('android.bluetooth.BluetoothDevice');
    if (Dev.createL2capChannel) Dev.createL2capChannel.implementation = function (psm) {
      console.log('[' + ts() + '] L2CAP connect PSM=' + psm);
      return this.createL2capChannel(psm);
    };
    Dev.createRfcommSocketToServiceRecord.implementation = function (u) {
      console.log('[' + ts() + '] RFCOMM connect uuid=' + u);
      return this.createRfcommSocketToServiceRecord(u);
    };
    if (Dev.createInsecureL2capChannel) Dev.createInsecureL2capChannel.implementation = function (psm) {
      console.log('[' + ts() + '] L2CAP(insecure) connect PSM=' + psm);
      return this.createInsecureL2capChannel(psm);
    };
    console.log('[+] hooked socket factories');
  } catch (e) { console.log('[-] socket hook: ' + e); }

  // BluetoothSocket streams: capture the actual bytes over classic channels
  try {
    var OutS = Java.use('android.bluetooth.BluetoothSocket');
    // getOutputStream/getInputStream return java.io streams; wrap their read/write
    var JOut = Java.use('java.io.OutputStream');
    JOut.write.overload('[B', 'int', 'int').implementation = function (buf, off, len) {
      // only log if this looks like a BT socket stream — cheap heuristic: always log small frames
      if (len > 0 && len < 2048) {
        var slice = Java.array('byte', buf);
        // build hex of the [off, off+len) window
        var s = '';
        for (var i = off; i < off + len; i++) { var v = (slice[i] < 0 ? slice[i] + 256 : slice[i]).toString(16); s += (v.length === 1 ? '0' + v : v); }
        console.log('[' + ts() + '] STREAM.write len=' + len + ' data=' + s);
      }
      return this.write(buf, off, len);
    };
    console.log('[+] hooked OutputStream.write (noisy; filter STREAM lines)');
  } catch (e) { console.log('[-] stream hook: ' + e); }
});
