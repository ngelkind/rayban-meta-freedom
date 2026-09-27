/* Runtime configuration for the embedded proxy. The file lives in the app's
 * external files directory, which ADB can write without root and other apps
 * cannot read on Android 11+:
 *   /sdcard/Android/data/com.facebook.stella/files/rayban-proxy.json
 * Keys and destination URLs therefore never have to be built into the APK.
 * Everything is off unless the file enables it explicitly.
 */
'use strict';

(function (root) {
  const FILE_NAME = 'rayban-proxy.json';
  const MAX_FILE_BYTES = 64 * 1024;
  const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
  const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

  function object(value, path) {
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(path + ' must be an object');
    }
    return value;
  }

  function text(value, path, max = 2048) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max ||
        /[\r\n\0]/.test(value)) throw new Error(path + ' must be a single-line string');
    return value;
  }

  function integer(value, path, min, max, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(path + ' must be an integer from ' + min + ' to ' + max);
    }
    return value;
  }

  // Plain HTTP is accepted only for addresses that cannot leave a home or
  // tailnet: loopback, RFC 1918, CGNAT/Tailscale and mDNS names.
  function privateHost(host) {
    if (host === 'localhost' || host.endsWith('.local')) return true;
    const parts = host.split('.');
    if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
    const [a, b] = parts.map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }

  function destinationUrl(value, path) {
    const url = text(value, path);
    const match = /^(https?):\/\/([A-Za-z0-9.-]+)(:\d{1,5})?(\/[^\s#]*)?$/.exec(url);
    if (!match) throw new Error(path + ' must be an http(s) URL without a fragment');
    const host = match[2].toLowerCase();
    if (match[1] === 'http' && !privateHost(host)) {
      throw new Error(path + ' may use plain http only for a private address');
    }
    return url;
  }

  function stringMap(value, path, namePattern) {
    const input = object(value, path);
    const output = {};
    const names = Object.keys(input);
    if (names.length > 16) throw new Error(path + ' has too many entries');
    for (const name of names) {
      if (!namePattern.test(name)) throw new Error(path + ' has an invalid name: ' + name);
      output[name] = text(input[name], path + '.' + name);
    }
    return output;
  }

  function photoDestination(value) {
    const input = object(value, 'photos.destination');
    if (input.type !== 'http') throw new Error('photos.destination.type must be "http"');
    const format = input.format === undefined ? 'raw' : input.format;
    if (format !== 'raw' && format !== 'multipart') {
      throw new Error('photos.destination.format must be "raw" or "multipart"');
    }
    const headers = stringMap(input.headers, 'photos.destination.headers', HEADER_NAME);
    for (const name of Object.keys(headers)) {
      if (/^(content-type|content-length|host|transfer-encoding|connection)$/i.test(name)) {
        throw new Error('photos.destination.headers may not set ' + name);
      }
    }
    return Object.freeze({
      type: 'http',
      url: destinationUrl(input.url, 'photos.destination.url'),
      format,
      field: format === 'multipart' ?
        text(input.field === undefined ? 'photo' : input.field, 'photos.destination.field', 64) : null,
      fields: Object.freeze(stringMap(input.fields, 'photos.destination.fields', FIELD_NAME)),
      headers: Object.freeze(headers),
      timeoutSeconds: integer(input.timeoutSeconds, 'photos.destination.timeoutSeconds', 5, 300, 60)
    });
  }

  function validate(raw) {
    const input = object(raw, 'config');
    const traceIn = object(input.trace, 'trace');
    if (traceIn.assistant !== undefined && typeof traceIn.assistant !== 'boolean') {
      throw new Error('trace.assistant must be a boolean');
    }
    const photosIn = object(input.photos, 'photos');
    const enabled = photosIn.enabled === true;
    const photos = Object.freeze({
      enabled,
      pollSeconds: integer(photosIn.pollSeconds, 'photos.pollSeconds', 5, 3600, 30),
      maxAttempts: integer(photosIn.maxAttempts, 'photos.maxAttempts', 1, 20, 5),
      destination: enabled || photosIn.destination !== undefined ?
        photoDestination(photosIn.destination) : null
    });
    const assistantIn = object(input.assistant, 'assistant');
    if (assistantIn.apiKey !== undefined || assistantIn.key !== undefined) {
      throw new Error('assistant credentials cannot be stored in config');
    }
    const assistantEnabled = assistantIn.enabled === true;
    if (assistantIn.enabled !== undefined && typeof assistantIn.enabled !== 'boolean') {
      throw new Error('assistant.enabled must be a boolean');
    }
    const mode = assistantIn.mode === undefined ? 'shadow' : assistantIn.mode;
    if (!['shadow', 'replace'].includes(mode)) throw new Error('assistant.mode invalid');
    if (assistantEnabled && mode === 'replace' && assistantIn.experimentalAudioGate !== true) {
      throw new Error('assistant replacement needs experimentalAudioGate true');
    }
    if (assistantEnabled && mode === 'replace') {
      throw new Error('assistant replacement unavailable: original Meta reply is not suppressible yet');
    }
    if (assistantEnabled && traceIn.assistant === true) {
      throw new Error('assistant replacement and trace cannot hook the same audio method');
    }
    const provider = assistantIn.provider === undefined ? 'nvidia' : assistantIn.provider;
    if (!['nvidia', 'openai', 'openrouter', 'anthropic', 'gemini'].includes(provider)) {
      throw new Error('assistant.provider invalid');
    }
    const model = assistantEnabled ? text(assistantIn.model, 'assistant.model', 160) : null;
    function price(name) {
      const value = assistantIn[name] === undefined ? 0 : assistantIn[name];
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error('assistant.' + name + ' invalid');
      }
      return value;
    }
    const dailyBudgetUsd = assistantIn.dailyBudgetUsd === undefined ? 1 :
      assistantIn.dailyBudgetUsd;
    if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0 || dailyBudgetUsd > 50) {
      throw new Error('assistant.dailyBudgetUsd invalid');
    }
    const assistant = Object.freeze({enabled: assistantEnabled, mode, provider, model,
      maxOutputTokens: integer(assistantIn.maxOutputTokens,
        'assistant.maxOutputTokens', 1, 2048, 512),
      prices: Object.freeze({inputPerMillion: price('inputPerMillion'),
        outputPerMillion: price('outputPerMillion')}), dailyBudgetUsd});
    const diagnosticsIn = object(input.diagnostics, 'diagnostics');
    const speakerTestId = diagnosticsIn.speakerTestId;
    const suppressOriginalTestId = diagnosticsIn.suppressOriginalTestId;
    const muteMicTestId = diagnosticsIn.muteMicTestId;
    const muteDataxTestId = diagnosticsIn.muteDataxTestId;
    if (speakerTestId !== undefined &&
        (typeof speakerTestId !== 'string' ||
         !/^[A-Za-z0-9_-]{1,32}$/.test(speakerTestId))) {
      throw new Error('diagnostics.speakerTestId invalid');
    }
    if (speakerTestId !== undefined && assistantEnabled) {
      throw new Error('speaker test requires assistant disabled');
    }
    if (suppressOriginalTestId !== undefined &&
        (typeof suppressOriginalTestId !== 'string' ||
         !/^[A-Za-z0-9_-]{1,32}$/.test(suppressOriginalTestId))) {
      throw new Error('diagnostics.suppressOriginalTestId invalid');
    }
    if (suppressOriginalTestId !== undefined &&
        (assistantEnabled || speakerTestId !== undefined || traceIn.assistant === true)) {
      throw new Error('request probe requires assistant, speaker test and trace disabled');
    }
    if (muteMicTestId !== undefined &&
        (typeof muteMicTestId !== 'string' ||
         !/^[A-Za-z0-9_-]{1,32}$/.test(muteMicTestId))) {
      throw new Error('diagnostics.muteMicTestId invalid');
    }
    if (muteMicTestId !== undefined &&
        (assistantEnabled || speakerTestId !== undefined ||
         suppressOriginalTestId !== undefined || traceIn.assistant === true)) {
      throw new Error('mic probe requires assistant, speaker test, request probe and trace disabled');
    }
    if (muteDataxTestId !== undefined &&
        (typeof muteDataxTestId !== 'string' ||
         !/^[A-Za-z0-9_-]{1,32}$/.test(muteDataxTestId))) {
      throw new Error('diagnostics.muteDataxTestId invalid');
    }
    if (muteDataxTestId !== undefined &&
        (assistantEnabled || speakerTestId !== undefined ||
         suppressOriginalTestId !== undefined || muteMicTestId !== undefined ||
         traceIn.assistant === true)) {
      throw new Error('DataX probe requires other assistant diagnostics disabled');
    }
    // Fixed reply: drop Meta's streamed reply audio and speak one phrase.
    const fixedIn = object(input.fixedReply, 'fixedReply');
    if (fixedIn.enabled !== undefined && typeof fixedIn.enabled !== 'boolean') {
      throw new Error('fixedReply.enabled must be a boolean');
    }
    const fixedEnabled = fixedIn.enabled === true;
    const fixedText = fixedEnabled || fixedIn.text !== undefined ?
      text(fixedIn.text, 'fixedReply.text', 200) : null;
    if (fixedText !== null && !fixedText.trim()) throw new Error('fixedReply.text is blank');
    if (fixedEnabled && (assistantEnabled || traceIn.assistant === true ||
        speakerTestId !== undefined || suppressOriginalTestId !== undefined ||
        muteMicTestId !== undefined || muteDataxTestId !== undefined)) {
      throw new Error('fixedReply requires assistant, trace and diagnostics disabled');
    }
    const source = fixedIn.source === undefined ? 'fixed' : fixedIn.source;
    if (!['fixed', 'echo', 'model'].includes(source)) throw new Error('fixedReply.source invalid');
    if (fixedIn.apiKey !== undefined || fixedIn.key !== undefined) {
      throw new Error('fixedReply credentials cannot be stored in config');
    }
    let fixedModel = null;
    if (source === 'model') {
      const fixedProvider = fixedIn.provider === undefined ? 'nvidia' : fixedIn.provider;
      if (!['nvidia', 'openai', 'openrouter', 'anthropic', 'gemini'].includes(fixedProvider)) {
        throw new Error('fixedReply.provider invalid');
      }
      fixedModel = Object.freeze({provider: fixedProvider,
        model: text(fixedIn.model, 'fixedReply.model', 160),
        visionModel: fixedIn.visionModel === undefined ? null :
          text(fixedIn.visionModel, 'fixedReply.visionModel', 160),
        maxOutputTokens: integer(fixedIn.maxOutputTokens, 'fixedReply.maxOutputTokens',
          16, 1024, 300)});
    }
    const fixedReply = Object.freeze({enabled: fixedEnabled, text: fixedText, source,
      model: fixedModel});
    const cameraIn = object(input.cameraAi, 'cameraAi');
    if (cameraIn.enabled !== undefined && typeof cameraIn.enabled !== 'boolean') {
      throw new Error('cameraAi.enabled must be a boolean');
    }
    const cameraAi = Object.freeze({enabled: cameraIn.enabled === true});
    return Object.freeze({photos, assistant, fixedReply, cameraAi,
      diagnostics: Object.freeze({speakerTestId: speakerTestId || null,
        suppressOriginalTestId: suppressOriginalTestId || null,
        muteMicTestId: muteMicTestId || null,
        muteDataxTestId: muteDataxTestId || null}),
      trace: Object.freeze({assistant: traceIn.assistant === true})});
  }

  const DEFAULTS = validate({});

  // Android loader. A missing file means defaults (everything off); a present
  // but invalid file is reported and also leaves everything off.
  function load() {
    let result = {config: DEFAULTS, path: null, fault: null};
    Java.performNow(() => {
      const app = Java.use('android.app.ActivityThread').currentApplication();
      if (app === null) { result.fault = 'application context unavailable'; return; }
      const dir = app.getExternalFilesDir(null);
      if (dir === null) { result.fault = 'external files directory unavailable'; return; }
      const file = Java.use('java.io.File').$new(dir, FILE_NAME);
      result.path = String(file.getPath());
      if (!file.isFile()) return;
      try {
        if (file.length() > MAX_FILE_BYTES) throw new Error('config file too large');
        const content = File.readAllText(result.path);
        result.config = validate(JSON.parse(content));
      } catch (error) {
        result.fault = 'config rejected: ' + String(error.message || error);
      }
    });
    return result;
  }

  const api = {validate, load, privateHost, DEFAULTS, FILE_NAME};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanConfig = api;
})(globalThis);
