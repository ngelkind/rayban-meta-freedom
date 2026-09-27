/* RPC bridge that drives the user's glasses through Stella's own protocol stack. */

'use strict';

let retainedClient = null;
let callbackSerial = 0;

function findClient() {
  return new Promise(function (resolve, reject) {
    Java.perform(function () {
      if (retainedClient !== null) {
        resolve(retainedClient);
        return;
      }
      // JADX gives this class a filesystem-safe name. The runtime DEX name is
      // the original obfuscated name shown in the JADX header: X.0s7.
      const Client = Java.use('X.0s7');
      Java.choose(Client.$className, {
        onMatch: function (instance) {
          if (retainedClient === null) retainedClient = Java.retain(instance);
        },
        onComplete: function () {
          if (retainedClient === null) reject(new Error('Stella device client is not active'));
          else resolve(retainedClient);
        }
      });
    });
  });
}

function triggerCapture(type) {
  return findClient().then(function (client) {
    return new Promise(function (resolve, reject) {
      Java.perform(function () {
        try {
          const Builder = Java.use('X.CoG');
          const Request = Java.use('stella.srvs.TriggerCaptureRequest');
          const Services = Java.use('X.0s9');
          const Callback = Java.use('X.CZS');
          const builder = Builder.A02();
          Request.startTriggerCaptureRequest(builder);
          Request.addType(builder, type);
          Request.addOrigin(builder, 2); // CaptureRequestOrigin.OTHER
          const payload = Builder.A08(builder);
          const className = 'local.rayban.CaptureCallback' + callbackSerial++;
          const CaptureCallback = Java.registerClass({
            name: className,
            implements: [Callback],
            methods: {
              AwA: function (response, error) {
                if (error !== null) {
                  reject(new Error(String(error)));
                  return;
                }
                let result = -1;
                try { result = response.result(); } catch (_) {}
                resolve({ result: result, type: type });
              }
            }
          });
          const callback = CaptureCallback.$new();
          client.A05(Services.A0a.value, callback, payload);
        } catch (e) {
          reject(e);
        }
      });
    });
  });
}

rpc.exports = {
  status: function () {
    return findClient().then(function (client) {
      const Adapter = Java.use('android.bluetooth.BluetoothAdapter');
      const adapter = Adapter.getDefaultAdapter();
      return {
        device_client_present: client !== null,
        bluetooth_enabled: adapter !== null && adapter.isEnabled(),
        // Finding a client object is not evidence of a live glasses link.
        glasses_connection_verified: false
      };
    });
  },
  photo: function () { return triggerCapture(0); },
  startvideo: function () { return triggerCapture(1); },
  stopvideo: function () { return triggerCapture(2); }
};
