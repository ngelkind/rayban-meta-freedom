/* Frida Gadget entrypoint. The build script places Java, RaybanRouter and
 * PATCH_CONFIG above this file. No connection to a desktop controller is used.
 */
'use strict';

(function () {
  const EXPECTED_VERSION = '289.0.0.25.162';
  const MAX_ROUTED_BYTES = 1024 * 1024;
  const router = new RaybanRouter.FeatureRouter(function (id, error) {
    console.error('[rayban] observer ' + id + ' failed: ' + error);
  }, {allowedMutations: PATCH_CONFIG.mutableOperations || [],
      maxPayloadBytes: MAX_ROUTED_BYTES});
  let installed = false;
  let started = false;
  let version = null;
  let fault = null;
  let photoFault = null;
  let controlFault = null;
  let configFault = null;
  let traceFault = null;
  let assistantFault = null;
  let assistantPhase = null;
  let assistantSession = null;
  let transcriptHook = null;
  let replyGateHook = null;
  let assistantConfigStamp = null;
  let speakerProbe = null;
  let speakerProbeError = null;
  let requestProbe = null;
  let requestProbeHook = null;
  let micProbe = null;
  let micProbeHook = null;
  let dataxProbe = null;
  let dataxProbeHook = null;
  let assistantTrace = null;
  let fixedReply = null;
  let fixedReplyHook = null;
  let cameraAi = null;
  let cameraAiHook = null;
  let vision = null;
  let visionState = null;
  let deviceSettings = null;
  let config = RaybanConfig.DEFAULTS;
  let lastPhotoPoll = null;
  let photoTimer = null;
  let photoSource = null;
  let controls = null;
  const MAX_START_ATTEMPTS = 60;

  function retryStart(attempt) {
    if (attempt < MAX_START_ATTEMPTS) setTimeout(() => start(attempt + 1), 500);
    else log('Java bridge or application context unavailable', true);
  }

  function statusFile(stage) {
    if (stage === 'installed' && router.status().disabled) stage = 'disabled';
    try {
      File.writeAllText('/data/user/0/com.facebook.stella/files/rayban-proxy-status.json',
        JSON.stringify({stage: stage, buildId: PATCH_CONFIG.buildId || null,
          installed: installed, version: version, disabled: router.status().disabled,
          fault: fault, photoFault: photoFault, controlFault: controlFault,
          configFault: configFault, traceFault: traceFault,
          assistantFault: assistantFault, assistantPhase: assistantPhase,
          assistantEnabled: assistantSession !== null && assistantSession.turns.enabled,
          assistantMode: assistantSession === null ? null : assistantSession.mode,
          speakerProbe: speakerProbe,
          speakerProbeError: speakerProbeError,
          requestProbe: requestProbe,
          micProbe: micProbe,
          dataxProbe: dataxProbe,
          fixedReply: fixedReply,
          cameraAi: cameraAi,
          vision: visionState,
          deviceSettings: deviceSettings,
          traceEnabled: !!(assistantTrace && config.trace.assistant && !router.status().disabled),
          photosEnabled: photoTimer !== null,
          lastPhotoPoll: lastPhotoPoll}).padEnd(4096, ' '));
    } catch (_) {}
  }

  function log(message, error) {
    try {
      const Log = Java.use('android.util.Log');
      if (error) Log.e('RaybanProxy', message);
      else Log.i('RaybanProxy', message);
    } catch (_) { console.log('[rayban] ' + message); }
  }

  function versionOf(app) {
    const info = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
    return String(info.versionName.value || info.versionName);
  }

  function bytesOf(buffer) {
    const ByteBuffer = Java.use('java.nio.ByteBuffer');
    const dup = Java.cast(buffer.duplicate(), ByteBuffer);
    const size = dup.remaining();
    if (size > MAX_ROUTED_BYTES) throw new Error('message exceeds routing limit');
    const array = Java.array('byte', new Array(size).fill(0));
    ByteBuffer.get.overload('[B', 'int', 'int').call(dup, array, 0, size);
    return Uint8Array.from(array, x => x & 255);
  }

  function directBuffer(bytes) {
    const ByteBuffer = Java.use('java.nio.ByteBuffer');
    const buffer = ByteBuffer.allocateDirect(bytes.length);
    buffer.put(Java.array('byte', Array.from(bytes, x => x > 127 ? x - 256 : x)));
    buffer.flip();
    return buffer;
  }

  function equalBytes(left, right) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) ||
        left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    return true;
  }

  function routedEvent(feature, operation, buffer, extras) {
    const size = buffer.remaining();
    const event = Object.assign({ feature: feature, operation: operation,
      capturedAt: Date.now(), payloadBytes: size }, extras || {});
    if (router.hasHandler(feature, operation)) {
      if (size <= MAX_ROUTED_BYTES) event.payload = bytesOf(buffer);
      else event.payloadUnavailable = 'too_large';
    }
    return event;
  }

  function installDatax() {
    const LC = Java.use('com.facebook.wearable.datax.LocalChannel');
    const TB = Java.use('com.facebook.wearable.datax.TypedBuffer');
    const outbound = LC.send.overload('com.facebook.wearable.datax.TypedBuffer');
    outbound.implementation = function (typed) {
      const self = this;
      const originalBytes = typed.bytes.value;
      const serviceId = this.service.value;
      const opcode = typed.type.value;
      const operation = 'out:' + serviceId + ':' + opcode;
      const event = routedEvent('datax', operation, originalBytes,
        {direction: 'out', serviceId: serviceId, opcode: opcode, requestId: null});
      return router.dispatch(event, function (changed) {
        if (!changed.payload || equalBytes(changed.payload, event.payload)) return outbound.call(self, typed);
        if (!(changed.payload instanceof Uint8Array)) throw new Error('invalid outbound payload');
        const result = outbound.call(self, TB.$new(typed.type.value, directBuffer(changed.payload)));
        // The original send advances its caller's ByteBuffer to limit after
        // success. The replacement buffer does not do that automatically.
        originalBytes.position(originalBytes.limit());
        return result;
      });
    };

    const inbound = LC.handleReceived.overload('int', 'java.nio.ByteBuffer');
    inbound.implementation = function (type, buffer) {
      const self = this;
      const serviceId = this.service.value;
      const operation = 'in:' + serviceId + ':' + type;
      const event = routedEvent('datax', operation, buffer,
        {direction: 'in', serviceId: serviceId, opcode: type, requestId: null});
      return router.dispatch(event, function (changed) {
        if (!changed.payload || equalBytes(changed.payload, event.payload)) return inbound.call(self, type, buffer);
        if (!(changed.payload instanceof Uint8Array)) throw new Error('invalid inbound payload');
        return inbound.call(self, type, directBuffer(changed.payload));
      });
    };
  }

  function registerExtensions() {
    const watches = PATCH_CONFIG.observeDatax || [];
    watches.forEach(function (item, index) {
      const operation = item.direction + ':' + item.service + ':' + item.opcode;
      router.register({ id: 'watch-' + index, feature: 'datax', operation: operation,
        mode: 'observe', enabled: true, handle: function (event) {
          console.log('[rayban] ' + operation + ' bytes=' + event.payloadBytes);
        } });
    });
    if (typeof registerRaybanExtensions === 'function') registerRaybanExtensions(router);
  }

  function loadConfig() {
    const loaded = RaybanConfig.load();
    config = loaded.config;
    configFault = loaded.fault;
    if (configFault) log(configFault, true);
  }

  function photoDestination() {
    // Code in extensions.js takes precedence over the config file.
    const custom = typeof createPhotoDestination === 'function' ? createPhotoDestination() : null;
    if (custom) return custom;
    if (config.photos.destination) {
      return RaybanAndroidUpload.createHttpDestination(config.photos.destination);
    }
    return null;
  }

  function installPhotoSource() {
    const wanted = PATCH_CONFIG.photoWatch === true || config.photos.enabled;
    if (!wanted || router.status().disabled || photoTimer !== null) return;
    photoFault = null;
    const destination = photoDestination();
    if (!destination || typeof destination.deliver !== 'function') {
      photoFault = 'photo watcher requested without a destination';
      statusFile('installed');
      log(photoFault, true);
      return;
    }
    const source = new RaybanPhotoSource.PhotoSource({
      database: RaybanAndroidPhoto.database,
      files: RaybanAndroidPhoto.files,
      ledger: RaybanAndroidPhoto.ledger,
      destination: new RaybanMedia.PhotoRouter(destination),
      maxAttempts: config.photos.maxAttempts
    });
    photoSource = source;
    function poll() {
      source.poll().then(result => {
        if (result.busy || result.stopped) return;
        lastPhotoPoll = Object.assign({atMs: Date.now()}, result);
        statusFile('installed');
      }).catch(error => {
        photoFault = String(error);
        statusFile('installed');
        log('photo source: ' + photoFault, true);
      });
    }
    photoTimer = setInterval(poll, config.photos.pollSeconds * 1000);
    poll();
    log('photo watcher running every ' + config.photos.pollSeconds + ' s');
  }

  function syncAssistantTrace() {
    const wanted = config.trace.assistant && !router.status().disabled;
    if (wanted && assistantTrace === null) {
      try {
        assistantTrace = RaybanAssistantTrace.install({onFault: error => {
          traceFault = error;
          log('assistant trace hook missing: ' + error, true);
        }});
      } catch (error) {
        traceFault = String(error).slice(0, 500);
        log('assistant trace unavailable: ' + traceFault, true);
      }
    }
    if (assistantTrace !== null) assistantTrace.setEnabled(wanted);
  }

  function syncAssistantReplacement() {
    if (!config.assistant.enabled || router.status().disabled) {
      if (assistantSession !== null) assistantSession.disable();
      if (transcriptHook !== null) transcriptHook.disable();
      if (replyGateHook !== null) replyGateHook.disable();
      return;
    }
    const stamp = JSON.stringify(config.assistant);
    if (assistantSession !== null) {
      if (assistantConfigStamp !== stamp) {
        assistantFault = 'restart required for assistant config changes';
        statusFile('installed');
        return;
      }
      assistantSession.enable();
      if (transcriptHook !== null) transcriptHook.enable();
      if (replyGateHook !== null) replyGateHook.enable();
      statusFile('installed');
      return;
    }
    try {
      const choice = config.assistant;
      const model = new RaybanAssistant.AssistantRouter({
        transport: RaybanAndroidHttp, keyFor: RaybanAndroidAssistantStore.keyFor,
        budget: new RaybanAssistant.DailyBudget(
          RaybanAndroidAssistantStore.budgetStore, choice.dailyBudgetUsd),
        provider: choice.provider, model: choice.model, prices: choice.prices,
        maxOutputTokens: choice.maxOutputTokens
      });
      const speaker = choice.mode === 'replace' ? RaybanAndroidSystemTts.fromAndroid() : null;
      const session = new RaybanAssistantReplacement.ReplacementSession({
        TurnEngine: RaybanAssistantTurn.TurnEngine,
        AudioGate: RaybanAssistantAudioGate.AudioGate,
        model, speaker, mode: choice.mode,
        onState: state => { assistantPhase = state.phase; statusFile('installed'); }
      });
      if (choice.mode === 'replace') {
        replyGateHook = RaybanAndroidReplyGate.install(session.gate);
      }
      transcriptHook = RaybanAndroidTranscript.install(
        event => session.onFinal(event), () => {
          assistantFault = 'transcript observer failed'; statusFile('installed');
        });
      assistantSession = session;
      assistantConfigStamp = stamp;
      assistantFault = null;
      assistantPhase = 'ready';
      statusFile('installed');
    } catch (_) {
      if (replyGateHook !== null) replyGateHook.disable();
      assistantFault = 'assistant binding unavailable; original app preserved';
      statusFile('installed');
    }
  }

  function runSpeakerProbe() {
    const id = config.diagnostics.speakerTestId;
    if (!id || router.status().disabled) return;
    // A fixed phrase tests our speech output without invoking a model or
    // suppressing Meta. The app-private marker prevents a crash/restart from
    // unexpectedly speaking twice after TTS may already have begun.
    setTimeout(() => {
      if (router.status().disabled) return;
      try {
        let attempted = false;
        Java.performNow(() => {
          const app = Java.use('android.app.ActivityThread').currentApplication();
          const prefs = app.getSharedPreferences('rayban-proxy-diagnostics', 0);
          attempted = String(prefs.getString('speakerTestId', '')) === id;
        });
        if (attempted) {
          speakerProbe = 'already-attempted'; statusFile('installed'); return;
        }
        const speaker = RaybanAndroidSystemTts.fromAndroid({
          onStage: stage => { speakerProbe = stage; statusFile('installed'); },
        });
        Java.performNow(() => {
          const app = Java.use('android.app.ActivityThread').currentApplication();
          const prefs = app.getSharedPreferences('rayban-proxy-diagnostics', 0);
          if (!prefs.edit().putString('speakerTestId', id).commit()) {
            throw new Error('probe marker could not be saved');
          }
        });
        speakerProbe = 'speaking'; statusFile('installed');
        Promise.resolve(speaker.speak({requestId: 'probe-' + id,
          text: 'This is a test of the custom speaker.'})).then(() => {
          speakerProbe = 'played'; statusFile('installed');
        }).catch(error => {
          speakerProbe = 'playback-failed'; statusFile('installed');
          speakerProbeError = String(error && error.message || error).slice(0, 300);
          statusFile('installed');
        });
      } catch (error) {
        speakerProbe = 'binding-unavailable'; statusFile('installed');
        speakerProbeError = String(error && error.message || error).slice(0, 300);
        statusFile('installed');
      }
    }, 5000);
  }

  function runRequestProbe() {
    const id = config.diagnostics.suppressOriginalTestId;
    if (!id || router.status().disabled) return;
    try {
      requestProbeHook = RaybanAndroidRequestProbe.install({token: id,
        onState: state => { requestProbe = state; statusFile('installed'); }});
    } catch (_) {
      requestProbe = 'binding-unavailable';
      statusFile('installed');
    }
  }

  function runMicProbe() {
    const id = config.diagnostics.muteMicTestId;
    if (!id || router.status().disabled) return;
    try {
      micProbeHook = RaybanAndroidMicProbe.install({token: id,
        onState: state => { micProbe = state; statusFile('installed'); }});
    } catch (_) {
      micProbe = 'binding-unavailable';
      statusFile('installed');
    }
  }

  function runDataxProbe() {
    const id = config.diagnostics.muteDataxTestId;
    if (!id || router.status().disabled) return;
    try {
      dataxProbeHook = RaybanAndroidDataxInputProbe.install({token: id,
        onState: state => { dataxProbe = state; statusFile('installed'); }});
    } catch (_) {
      dataxProbe = 'binding-unavailable';
      statusFile('installed');
    }
  }

  const VOICE_SYSTEM_PROMPT = 'You are a voice assistant speaking through smart ' +
    'glasses. The user\'s words come from speech recognition and may contain ' +
    'errors. Reply in plain spoken English, usually one to three short ' +
    'sentences. No markdown, lists, emoji or URLs.';

  // Meta's transcript starts with the wake phrase ("hey meta tell me ...").
  function stripWakeWord(text) {
    const rest = text.replace(/^\s*(hey|hi|okay|ok)[\s,]+meta[\s,.!?]*/i, '');
    return rest.trim() ? rest : text;
  }

  // Camera question: the glasses photo goes with the words to a vision model
  // (OpenAI-style image_url content). Used only when a photo arrived this turn.
  async function askVision(pick, question, base64Jpeg) {
    const endpoint = {nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
      openai: 'https://api.openai.com/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions'}[pick.provider];
    if (!endpoint) throw new Error('vision needs an OpenAI-compatible provider');
    const key = RaybanAndroidAssistantStore.keyFor(pick.provider);
    const response = await RaybanAndroidHttp.post(endpoint, {
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key},
      timeoutMs: 30000,
      body: {model: pick.visionModel, max_tokens: pick.maxOutputTokens, stream: false,
        messages: [{role: 'system', content: VISION_SYSTEM_PROMPT},
          {role: 'user', content: [{type: 'text', text: question},
            {type: 'image_url', image_url: {url: 'data:image/jpeg;base64,' + base64Jpeg}}]}]}
    });
    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error('vision request failed with status ' + (response?.status ?? 'unknown'));
    }
    const answer = RaybanAssistant.extract(pick.provider, response.json);
    if (!answer) throw new Error('vision model returned no text');
    return answer;
  }

  const VISION_SYSTEM_PROMPT = 'You are a voice assistant on smart glasses helping ' +
    'someone whose eyesight is weak. The photo is what the glasses camera sees ' +
    'right now. Answer the question about it in plain spoken English, one to ' +
    'three short sentences. Mention distant objects, signs and text when useful. ' +
    'No markdown, lists or emoji.';

  function syncCameraAi() {
    if (!config.cameraAi.enabled || router.status().disabled || cameraAiHook !== null) return;
    try {
      cameraAiHook = RaybanAndroidCameraConsent.install({
        onState: state => { cameraAi = state; statusFile('installed'); }});
      // Diagnostic: what the glasses report for camera/AI settings.
      setTimeout(() => Java.performNow(() => {
        try { deviceSettings = RaybanAndroidCameraConsent.dumpDeviceSettings(); }
        catch (error) { deviceSettings = ['dump failed: ' + String(error).slice(0, 160)]; }
        statusFile('installed');
      }), 20000);
    } catch (error) {
      cameraAi = 'binding-unavailable: ' + String(error && error.message || error).slice(0, 160);
      statusFile('installed');
    }
  }

  function syncFixedReply() {
    const wanted = config.fixedReply.enabled && !router.status().disabled;
    if (!wanted) {
      if (fixedReplyHook !== null) fixedReplyHook.disable();
      if (transcriptHook !== null && !config.assistant.enabled) transcriptHook.disable();
      return;
    }
    if (fixedReplyHook !== null) {
      fixedReplyHook.enable();
      if (transcriptHook !== null) transcriptHook.enable();
      return;
    }
    try {
      const choice = config.fixedReply;
      // echo: speak Meta's final transcript back. It checks the transcript ->
      // reply -> speaker chain before a model is attached to the same slot.
      let respond = null;
      if (choice.source === 'echo') respond = async ({text}) => 'You said: ' + text;
      if (choice.source === 'model') {
        const pick = choice.model;
        const router = new RaybanAssistant.AssistantRouter({
          transport: RaybanAndroidHttp, keyFor: RaybanAndroidAssistantStore.keyFor,
          budget: new RaybanAssistant.DailyBudget(
            RaybanAndroidAssistantStore.budgetStore, config.assistant.dailyBudgetUsd),
          provider: pick.provider, model: pick.model,
          prices: config.assistant.prices, maxOutputTokens: pick.maxOutputTokens,
          system: (/nemotron/i.test(pick.model) ? 'detailed thinking off\n' : '') +
            VOICE_SYSTEM_PROMPT
        });
        if (pick.visionModel) {
          try {
            vision = RaybanAndroidVision.install({
              onState: state => { visionState = state; statusFile('installed'); }});
          } catch (error) {
            visionState = 'unavailable: ' + String(error && error.message || error).slice(0, 120);
          }
        }
        respond = async ({requestId, text}) => {
          const question = stripWakeWord(text);
          const photo = vision ? vision.take(requestId, 20000) : null;
          if (photo) return askVision(pick, question, photo);
          return (await router.ask({requestId, text: question})).text;
        };
      }
      const label = choice.source + (choice.model ? ':' + choice.model.model : '');
      const hook = RaybanAndroidFixedReply.install({text: choice.text,
        encoder: RaybanAndroidFixedReply.encoderFromAndroid(),
        fallback: RaybanAndroidSystemTts.fromAndroid(), respond,
        onJava: fn => Java.performNow(fn),
        onState: state => { fixedReply = state + ' [' + label + ']'; statusFile('installed'); }});
      if (respond !== null) {
        transcriptHook = RaybanAndroidTranscript.install(event => hook.onTranscript(event),
          () => { fixedReply = 'transcript observer failed'; statusFile('installed'); },
          {partials: true});
      }
      fixedReplyHook = hook;
    } catch (error) {
      fixedReply = 'binding-unavailable: ' +
        String(error && error.message || error).slice(0, 200);
      statusFile('installed');
    }
  }

  function pauseAll() {
    router.disableAll();
    if (assistantTrace !== null) assistantTrace.setEnabled(false);
    if (assistantSession !== null) assistantSession.disable();
    if (transcriptHook !== null) transcriptHook.disable();
    if (replyGateHook !== null) replyGateHook.disable();
    if (requestProbeHook !== null) requestProbeHook.disable();
    if (micProbeHook !== null) micProbeHook.disable();
    if (dataxProbeHook !== null) dataxProbeHook.disable();
    if (fixedReplyHook !== null) fixedReplyHook.disable();
    if (photoTimer !== null) { clearInterval(photoTimer); photoTimer = null; }
    if (photoSource !== null) { photoSource.stop(); photoSource = null; }
    statusFile('disabled');
  }

  function resumeAll() {
    router.enableAll();
    // Resume re-reads the config file, so a change applies without a restart.
    loadConfig();
    syncAssistantTrace();
    syncAssistantReplacement();
    syncFixedReply();
    syncCameraAi();
    installPhotoSource();
    statusFile('installed');
  }

  function start(attempt) {
    try {
      if (!Java.available) { retryStart(attempt); return; }
      Java.perform(function () {
      try {
        const ActivityThread = Java.use('android.app.ActivityThread');
        const app = ActivityThread.currentApplication();
        if (app === null) {
          retryStart(attempt);
          return;
        }
        if (String(ActivityThread.currentProcessName()) !== String(app.getPackageName())) return;
        statusFile('java-ready');
        version = versionOf(app);
        if (version !== EXPECTED_VERSION) {
          fault = 'unsupported app version: ' + version;
          log(fault, true);
          statusFile('unsupported');
          return;
        }
        loadConfig();
        registerExtensions();
        // An unconfigured proxy must not intercept every DataX packet. Keep
        // the original transport untouched until a mapped handler exists.
        if (router.status().handlers.some(item => item.feature === 'datax')) {
          installDatax();
        }
        installed = true;
        syncAssistantTrace();
        syncAssistantReplacement();
        syncFixedReply();
        syncCameraAi();
        try {
          controls = RaybanAndroidControl.install(pauseAll, resumeAll, function (error) {
            controlFault = String(error.stack || error).slice(0, 1500);
            log('local control action failed: ' + controlFault, true);
            statusFile(router.status().disabled ? 'disabled' : 'installed');
          });
        } catch (error) {
          controlFault = String(error.stack || error).slice(0, 1500);
          log('local control unavailable: ' + controlFault, true);
        }
        installPhotoSource();
        runSpeakerProbe();
        runRequestProbe();
        runMicProbe();
        runDataxProbe();
        log('router installed for ' + version);
        statusFile('installed');
      } catch (error) {
        fault = String(error);
        log('router install failed: ' + fault, true);
        statusFile('failed');
      }
      });
    } catch (error) {
      if (String(error).includes('Java API not available') && attempt < MAX_START_ATTEMPTS) {
        retryStart(attempt);
      } else {
        fault = String(error);
        log('router startup failed: ' + fault, true);
        statusFile('failed');
      }
    }
  }

  rpc.exports = {
    init: function () { if (!started) { started = true; start(0); } },
    status: function () { return { installed: installed, version: version, fault: fault,
      photoFault: photoFault, controlFault: controlFault, router: router.status() }; },
    dispose: function () {
      pauseAll();
      if (controls !== null) controls.dispose();
      statusFile('disposed');
    },
    disableall: function () { if (controls) controls.setDisabled(true); else pauseAll(); },
    enableall: function () { if (controls) controls.setDisabled(false); else resumeAll(); },
    enable: function (id, value) { router.setEnabled(id, value); }
  };
  // Gadget's Script interaction invokes init; a host-attached test may not.
  if (!PATCH_CONFIG.gadgetInitOnly && !started) { started = true; start(0); }
})();
