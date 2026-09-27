/*
 * datax-capture.js — capture PLAINTEXT DataX messages from stella.
 *
 * THE key script. DataX is Meta's multiplexed message bus to the glasses. The
 * wire bytes are encrypted by native airshield + framed by libdatax_jni_local.so,
 * but the Java wrappers hand the payload to native as a plaintext protobuf with
 * an opcode. We hook those wrappers → we see every command/event in the clear,
 * with its serviceId + messageType(opcode), WITHOUT touching the crypto/framing.
 *
 * Recovers exactly what static RE could not: the serviceId+opcode map for
 * battery/notification/spotify/capture/etc. (only camera=151/op1 and
 * video-demo=7011 were resolvable statically).
 *
 * Class/method names here are STABLE (com.facebook.wearable.datax.*), unlike the
 * obfuscated X.* classes. Run:
 *   frida -U -f com.facebook.stella -l tools/frida/datax-capture.js --no-pause \
 *     | tee captures/ble/datax_$(date +%Y%m%d_%H%M%S).log
 * Then exercise features on the glasses (photo, Hey Meta, music, etc.).
 */
'use strict';

function ts() { return new Date().toISOString().substr(11, 12); }

function bbHex(bb, cap) {
  // Read the readable window [position, limit) of a java.nio.ByteBuffer as hex,
  // non-destructively (duplicate()), capped at `cap` bytes.
  try {
    if (bb === null) return '(null)';
    var ByteBuffer = Java.use('java.nio.ByteBuffer');
    var dup = Java.cast(bb.duplicate(), ByteBuffer);
    var n = dup.remaining();
    if (n <= 0) return '(empty)';
    var take = (cap && n > cap) ? cap : n;
    var jarr = Java.array('byte', new Array(take).fill(0));
    ByteBuffer.get.overload('[B', 'int', 'int').call(dup, jarr, 0, take);
    var s = '';
    for (var i = 0; i < take; i++) {
      var v = (jarr[i] < 0 ? jarr[i] + 256 : jarr[i]).toString(16);
      s += (v.length === 1 ? '0' + v : v);
    }
    return s + (n > take ? ('…(+' + (n - take) + 'B)') : '') + '  [' + n + 'B]';
  } catch (e) { return '(bberr ' + e + ')'; }
}

Java.perform(function () {
  console.log('[*] datax-capture attached @ ' + ts());
  const probe = Java.use('java.nio.ByteBuffer').allocateDirect(3);
  probe.put(Java.array('byte', [1, 2, -1]));
  probe.flip();
  const probeHex = bbHex(probe, 512);
  if (probeHex !== '0102ff  [3B]' || Java.cast(probe, Java.use('java.nio.Buffer')).position() !== 0) {
    throw new Error('ByteBuffer capture self-test failed: ' + probeHex);
  }
  send({kind: 'decoder-self-test', passed: true});

  // ---- OUTBOUND: LocalChannel.send(TypedBuffer) (phone -> glasses) ----
  try {
    var LC = Java.use('com.facebook.wearable.datax.LocalChannel');
    LC.send.overload('com.facebook.wearable.datax.TypedBuffer').implementation = function (tb) {
      try {
        console.log('[' + ts() + '] DATAX ->OUT svc=' + this.service.value +
          ' op=' + tb.type.value + ' payload=' + bbHex(tb.bytes.value, 512));
      } catch (e) { console.log('[send log err] ' + e); }
      return this.send(tb);
    };
    // INBOUND on a local channel: handleReceived(int type, ByteBuffer)
    LC.handleReceived.overload('int', 'java.nio.ByteBuffer').implementation = function (type, bb) {
      try {
        console.log('[' + ts() + '] DATAX IN<- svc=' + this.service.value +
          ' op=' + type + ' payload=' + bbHex(bb, 512));
      } catch (e) { console.log('[recv log err] ' + e); }
      return this.handleReceived(type, bb);
    };
    console.log('[+] hooked LocalChannel send/handleReceived');
  } catch (e) { console.log('[-] LocalChannel hook: ' + e); }

  // ---- OUTBOUND on server side: RemoteChannel.send(TypedBuffer) ----
  try {
    var RC = Java.use('com.facebook.wearable.datax.RemoteChannel');
    RC.send.overload('com.facebook.wearable.datax.TypedBuffer').implementation = function (tb) {
      try {
        console.log('[' + ts() + '] DATAX ->OUT(remote) id=' + this.getId() +
          ' op=' + tb.type.value + ' payload=' + bbHex(tb.bytes.value, 512));
      } catch (e) {}
      return this.send(tb);
    };
    console.log('[+] hooked RemoteChannel.send');
  } catch (e) { console.log('[-] RemoteChannel hook: ' + e); }

  // ---- INBOUND service dispatch: Service.handleReceived(RemoteChannel, int, ByteBuffer) ----
  try {
    var SV = Java.use('com.facebook.wearable.datax.Service');
    SV.handleReceived.overload('com.facebook.wearable.datax.RemoteChannel', 'int', 'java.nio.ByteBuffer')
      .implementation = function (rc, type, bb) {
        try {
          console.log('[' + ts() + '] DATAX IN<-(svc) svc=' + this.id.value +
            ' op=' + type + ' payload=' + bbHex(bb, 512));
        } catch (e) {}
        return this.handleReceived(rc, type, bb);
      };
    console.log('[+] hooked Service.handleReceived');
  } catch (e) { console.log('[-] Service hook: ' + e); }

  // ---- channel opening: Connection.openChannel(serviceId) surfaces service map ----
  try {
    var CN = Java.use('com.facebook.wearable.datax.Connection');
    // openChannel may be obfuscated on Connection; try common names defensively
    ['openChannel', 'A00', 'A01'].forEach(function (m) {
      if (!CN[m]) return;
      try {
        CN[m].overloads.forEach(function (ov) {
          if (ov.argumentTypes.length === 1 && ov.argumentTypes[0].className === 'int') {
            ov.implementation = function (sid) {
              console.log('[' + ts() + '] DATAX openChannel svc=' + sid);
              return ov.call(this, sid);
            };
          }
        });
      } catch (e) {}
    });
    console.log('[+] hooked Connection.openChannel (best-effort)');
  } catch (e) { console.log('[-] Connection hook: ' + e); }

  console.log('[*] ready — exercise glasses features now. svc/op legend:');
  console.log('    svc=151 op=1 CamOverrideRule | svc=7011 VideoDemo start/stop');
});
