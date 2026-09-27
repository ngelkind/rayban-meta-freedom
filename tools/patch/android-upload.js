/* HTTP photo destination configured by rayban-proxy.json. The request body is
 * staged in the app cache with Frida's native File API and streamed by Java in
 * 64 KiB chunks; copying a multi-megabyte photo byte by byte through the Java
 * bridge held Stella's thread at full CPU in the overnight probe.
 */
'use strict';

(function (root) {
  const CHUNK = 64 * 1024;
  const MAX_RESPONSE_BYTES = 64 * 1024;

  function utf8(textValue) {
    const out = [];
    for (let i = 0; i < textValue.length; i++) {
      let code = textValue.codePointAt(i);
      if (code > 0xffff) i++;
      if (code <= 0x7f) out.push(code);
      else if (code <= 0x7ff) out.push(0xc0 | code >> 6, 0x80 | code & 63);
      else if (code <= 0xffff) out.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
      else out.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
    }
    return Uint8Array.from(out);
  }

  function token(value) {
    return String(value).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
  }

  function extension(mime) {
    return mime === 'image/png' ? 'png' : 'jpg';
  }

  // Returns the bytes written before and after the image, so the image itself
  // is never concatenated into another large buffer.
  function envelope(destination, photo, boundary) {
    if (destination.format === 'raw') {
      return {contentType: photo.mime, prefix: new Uint8Array(0), suffix: new Uint8Array(0)};
    }
    if (!/^[A-Za-z0-9]{16,70}$/.test(boundary)) throw new Error('invalid multipart boundary');
    let head = '';
    for (const [name, value] of Object.entries(destination.fields || {})) {
      head += '--' + boundary + '\r\nContent-Disposition: form-data; name="' + name +
        '"\r\n\r\n' + value + '\r\n';
    }
    head += '--' + boundary + '\r\nContent-Disposition: form-data; name="' +
      destination.field + '"; filename="' + token(photo.captureId) + '.' +
      extension(photo.mime) + '"\r\nContent-Type: ' + photo.mime + '\r\n\r\n';
    return {contentType: 'multipart/form-data; boundary=' + boundary,
      prefix: utf8(head), suffix: utf8('\r\n--' + boundary + '--\r\n')};
  }

  // retry: the photo can safely be offered again later. uncertain: the server
  // may have it, so it is held rather than risking an unasked-for duplicate.
  function classify(status) {
    if (status >= 200 && status < 300) return 'acknowledged';
    if (status === 408 || status === 429 || status >= 500) return 'retry';
    return 'failed';
  }

  function deliveryError(message, outcome) {
    const error = new Error(message);
    error.outcome = outcome;
    return error;
  }

  function randomHex(length) {
    let out = '';
    while (out.length < length) out += Math.floor(Math.random() * 0x100000000).toString(16);
    return out.slice(0, length);
  }

  function writeStage(path, parts) {
    const file = new File(path, 'wb');
    try {
      for (const part of parts) {
        if (part.length === 0) continue;
        file.write(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
      }
    } finally {
      file.close();
    }
  }

  function createHttpDestination(destination) {
    if (!destination || destination.type !== 'http') throw new Error('http destination required');
    return {deliver: photo => new Promise((resolve, reject) => {
      setImmediate(() => Java.perform(() => {
        const app = Java.use('android.app.ActivityThread').currentApplication();
        const JFile = Java.use('java.io.File');
        const stage = JFile.$new(app.getCacheDir(), 'rayban-upload-' + randomHex(12) + '.part');
        const stagePath = String(stage.getPath());
        let connection = null;
        let input = null;
        let bodyStarted = false;
        try {
          const wrap = envelope(destination, photo, 'rayban' + randomHex(24));
          writeStage(stagePath, [wrap.prefix, photo.bytes, wrap.suffix]);
          const total = wrap.prefix.length + photo.bytes.length + wrap.suffix.length;
          if (Number(stage.length()) !== total) throw new Error('staged upload is incomplete');
          const timeout = destination.timeoutSeconds * 1000;
          connection = Java.cast(Java.use('java.net.URL').$new(destination.url).openConnection(),
            Java.use('java.net.HttpURLConnection'));
          connection.setRequestMethod('POST');
          connection.setInstanceFollowRedirects(false);
          connection.setDoOutput(true);
          connection.setConnectTimeout(timeout);
          connection.setReadTimeout(timeout);
          connection.setFixedLengthStreamingMode(Java.use('java.lang.Long').parseLong(String(total)));
          connection.setRequestProperty('Content-Type', wrap.contentType);
          connection.setRequestProperty('Idempotency-Key', token(photo.captureId));
          connection.setRequestProperty('X-Rayban-Capture-Id', token(photo.captureId));
          connection.setRequestProperty('X-Rayban-Captured-At', String(photo.capturedAt));
          for (const [name, value] of Object.entries(destination.headers)) {
            connection.setRequestProperty(name, value);
          }
          const output = connection.getOutputStream();
          bodyStarted = true;
          input = Java.use('java.io.FileInputStream').$new(stage);
          const buffer = Java.array('byte', new Array(CHUNK).fill(0));
          try {
            while (true) {
              const count = input.read(buffer);
              if (count < 0) break;
              output.write(buffer, 0, count);
            }
          } finally {
            output.close();
          }
          const status = Number(connection.getResponseCode());
          const stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
          if (stream !== null) {
            try {
              let seen = 0;
              while (seen < MAX_RESPONSE_BYTES) {
                const count = stream.read(buffer, 0, Math.min(CHUNK, MAX_RESPONSE_BYTES - seen));
                if (count < 0) break;
                seen += count;
              }
            } finally { stream.close(); }
          }
          const outcome = classify(status);
          if (outcome === 'acknowledged') resolve({status});
          else reject(deliveryError('destination returned HTTP ' + status, outcome));
        } catch (error) {
          if (error && error.outcome) { reject(error); return; }
          // Nothing was sent if the connection never produced a body stream.
          reject(deliveryError(String(error), bodyStarted ? 'uncertain' : 'retry'));
        } finally {
          if (input !== null) try { input.close(); } catch (_) {}
          if (connection !== null) try { connection.disconnect(); } catch (_) {}
          try { stage.delete(); } catch (_) {}
        }
      }));
    })};
  }

  const api = {createHttpDestination, envelope, classify, utf8, token};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidUpload = api;
})(globalThis);
