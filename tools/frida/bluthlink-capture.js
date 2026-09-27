/*
 * Capture Stella's BluthLink RPC/topic plane above Airshield encryption.
 *
 * Tested against stella 289.0.0.25.162. The stable package names describe the
 * events; the X.* names are version-specific and intentionally checked at
 * runtime so a future app update fails loudly instead of producing an empty log.
 */

'use strict';

// `console.log()` is not reliably surfaced by Frida Gadget.  Use Frida's
// message channel so every observed event reaches run_capture.py.
function emit(text) {
  send({kind: 'bluthlink', text: text});
}

function hex(bytes, start, length) {
  if (bytes === null || bytes === undefined) return '';
  const n = bytes.length;
  const from = Math.max(0, start || 0);
  const end = Math.min(n, length === undefined ? n : from + length);
  let out = '';
  for (let i = from; i < end; i++) {
    const value = bytes[i] & 0xff;
    out += ('0' + value.toString(16)).slice(-2);
  }
  return out;
}

function u16le(bytes, offset) {
  return (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8);
}

function u32le(bytes, offset) {
  return ((bytes[offset] & 0xff) |
    ((bytes[offset + 1] & 0xff) << 8) |
    ((bytes[offset + 2] & 0xff) << 16) |
    ((bytes[offset + 3] & 0xff) << 24)) >>> 0;
}

function describeFrame(kind, bytes) {
  try {
    if (kind.indexOf('OnService') === 0 && bytes.length >= 16) {
      return ' clientId=' + u16le(bytes, 2) +
        ' size=' + u32le(bytes, 4) +
        ' token=' + u16le(bytes, 8) +
        ' result=' + u16le(bytes, 10) +
        ' payload=' + hex(bytes, 16);
    }
    if (kind === 'OnTopicMessageReceived' && bytes.length >= 24) {
      return ' topicId=' + u16le(bytes, 2) +
        ' size=' + u32le(bytes, 4) +
        ' flags=' + u16le(bytes, 8) +
        ' payload=' + hex(bytes, 24);
    }
    if (kind === 'OnTopicBufferReceived' && bytes.length >= 8) {
      return ' topicId=' + u16le(bytes, 2) +
        ' size=' + u32le(bytes, 4) +
        ' payload=' + hex(bytes, 8);
    }
  } catch (e) {
    return ' parse_error=' + e;
  }
  return ' frame=' + hex(bytes);
}

Java.perform(function () {
  const DeviceClient = Java.use('X.0s7');
  const send = DeviceClient.A05.overload('X.0s8', 'X.CZS', '[B');
  send.implementation = function (service, callback, payload) {
    let description = '<unknown service>';
    try { description = service.toString(); } catch (_) {}
    emit('[BLUTH][OUT][RPC] ' + description + ' payload=' + hex(payload));
    return send.call(this, service, callback, payload);
  };

  const Dispatcher = Java.use('X.CpE');
  const dispatch = Dispatcher.A0B.overload('android.os.Message', 'java.lang.Object');
  dispatch.implementation = function (message, event) {
    let kind = '<null>';
    try {
      const name = event.getClass().getName().toString();
      event = Java.cast(event, Java.use(name));
      kind = name.split('$').pop();
    } catch (_) {}
    try {
      if (event !== null && event.A00 !== undefined) {
        const raw = event.A00.value;
        if (raw && typeof raw.length === 'number') {
          emit('[BLUTH][IN][' + kind + ']' + describeFrame(kind, raw));
        } else {
          emit('[BLUTH][EVENT][' + kind + '] value=' + raw);
        }
      } else {
        emit('[BLUTH][EVENT][' + kind + ']');
      }
    } catch (e) {
      emit('[BLUTH][IN][' + kind + '] inspect_error=' + e);
    }
    return dispatch.call(this, message, event);
  };

  const Registry = Java.use('X.16Q');
  const addService = Registry.A01.overload('X.0s8', 'X.0uo');
  addService.implementation = function (service, handler) {
    try { emit('[BLUTH][REGISTER][RPC] ' + service.toString()); } catch (_) {}
    return addService.call(this, service, handler);
  };
  const addTopic = Registry.A03.overload('X.0ub', 'X.0up');
  addTopic.implementation = function (topic, handler) {
    try { emit('[BLUTH][REGISTER][TOPIC] ' + topic.toString()); } catch (_) {}
    return addTopic.call(this, topic, handler);
  };

  // This is the generated request handler registered for NotifyCaptureRequest.
  // It is closer to the app's camera-import path than the generic dispatcher,
  // and lets a physical shutter press prove the exact inbound route.
  try {
    const NotifyCaptureHandler = Java.use('X.2YL');
    const handleNotify = NotifyCaptureHandler.AwD.overload('X.0sA', 'java.lang.Exception');
    handleNotify.implementation = function (request, error) {
      try {
        const name = request ? request.getClass().getName().toString() : '<null>';
        if (name === 'stella.srvs.NotifyCaptureRequest') {
          request = Java.cast(request, Java.use(name));
          let info = '<none>';
          try { info = String(request.info()); } catch (e) { info = '<unreadable: ' + e + '>'; }
          emit('[BLUTH][IN][NOTIFY_CAPTURE] request=' + name + ' info=' + info);
        }
      } catch (e) {
        emit('[BLUTH][IN][NOTIFY_CAPTURE] inspect_error=' + e);
      }
      return handleNotify.call(this, request, error);
    };
    emit('[BLUTH] NotifyCaptureRequest handler hooked');
  } catch (e) {
    emit('[BLUTH] NotifyCaptureRequest hook unavailable: ' + e);
  }

  emit('[BLUTH] hooks installed (stella 289.0.0.25.162)');
});
