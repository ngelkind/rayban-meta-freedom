/* Bounded HTTPS transport used by the phone-side assistant. Call only from a
 * scheduled job, never from a synchronous glasses/Java hook callback.
 */
'use strict';

(function (root) {
  const HOSTS = new Set([
    'integrate.api.nvidia.com', 'api.openai.com', 'openrouter.ai',
    'api.anthropic.com', 'generativelanguage.googleapis.com'
  ]);
  const MAX_RESPONSE_BYTES = 1024 * 1024;

  function endpoint(urlText) {
    const match = /^https:\/\/([a-z0-9.-]+)(\/[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*)$/.exec(urlText);
    if (!match || !HOSTS.has(match[1]) || urlText.includes('#')) {
      throw new Error('model endpoint not allowed');
    }
    return urlText;
  }

  function post(urlText, {headers, body, signal, timeoutMs = 30000}) {
    const url = endpoint(urlText);
    if (signal?.aborted) return Promise.reject(new Error('request cancelled'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
      return Promise.reject(new Error('invalid model timeout'));
    }
    return new Promise((resolve, reject) => {
      // A future dedicated Java worker can replace this scheduler. The Java
      // socket timeouts bound a blocked connection; JS cancellation is checked
      // before and after the call.
      setImmediate(() => Java.perform(() => {
        let connection = null;
        let stream = null;
        try {
          if (signal?.aborted) throw new Error('request cancelled');
          const URLClass = Java.use('java.net.URL');
          connection = Java.cast(URLClass.$new(url).openConnection(),
            Java.use('java.net.HttpURLConnection'));
          connection.setRequestMethod('POST');
          connection.setInstanceFollowRedirects(false);
          connection.setDoOutput(true);
          connection.setConnectTimeout(timeoutMs);
          connection.setReadTimeout(timeoutMs);
          for (const [name, value] of Object.entries(headers || {})) {
            if (!['content-type', 'authorization', 'x-goog-api-key', 'anthropic-version']
              .includes(name.toLowerCase())) throw new Error('unapproved model header');
            connection.setRequestProperty(name, String(value));
          }
          const data = Java.use('java.lang.String').$new(JSON.stringify(body)).getBytes('UTF-8');
          if (data.length > 256 * 1024) throw new Error('model request too large');
          connection.setFixedLengthStreamingMode(data.length);
          const output = connection.getOutputStream();
          try { output.write(data); } finally { output.close(); }
          const status = Number(connection.getResponseCode());
          if (status >= 300 && status < 400) throw new Error('model redirect refused');
          stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
          let json = null;
          if (stream !== null) {
            const bytes = Java.array('byte', new Array(8192).fill(0));
            const memory = Java.use('java.io.ByteArrayOutputStream').$new();
            while (true) {
              const count = stream.read(bytes);
              if (count < 0) break;
              if (memory.size() + count > MAX_RESPONSE_BYTES) throw new Error('model response too large');
              memory.write(bytes, 0, count);
            }
            if (status >= 200 && status < 300) json = JSON.parse(String(memory.toString('UTF-8')));
            memory.close();
          }
          if (signal?.aborted) throw new Error('request cancelled');
          resolve({status, json});
        } catch (error) { reject(new Error(String(error))); }
        finally {
          if (stream !== null) try { stream.close(); } catch (_) {}
          if (connection !== null) try { connection.disconnect(); } catch (_) {}
        }
      }));
    });
  }

  const api = {post, endpoint};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAndroidHttp = api;
})(globalThis);
