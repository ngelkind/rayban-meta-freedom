/* Phone-side text model API contracts. Transport and key lookup are injected;
 * nothing here stores a key, transcript, or reply. Actual glasses activation,
 * transcription and speech bindings must be verified separately.
 */
'use strict';

(function (root) {
  const ENDPOINTS = Object.freeze({
    nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models/'
  });

  function utf8Bytes(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.codePointAt(i);
      if (code > 0xffff) i++;
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return bytes;
  }

  function estimateUsd(text, maxOutputTokens, prices) {
    if (!prices || !Number.isFinite(prices.inputPerMillion) ||
        !Number.isFinite(prices.outputPerMillion) || prices.inputPerMillion < 0 ||
        prices.outputPerMillion < 0) throw new Error('model price is unknown');
    // Deliberately over-reserve input and all allowed output. A model that can
    // bill image/audio/request surcharges needs those prices before enabling.
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
        maxOutputTokens > 4096) throw new Error('invalid output token cap');
    // Byte count plus framing allowance is a conservative local reservation
    // for text tokenization, not a provider billing guarantee.
    const inputTokens = Math.max(256, utf8Bytes(text) + 512);
    return (inputTokens * prices.inputPerMillion +
      maxOutputTokens * prices.outputPerMillion) / 1_000_000;
  }

  class DailyBudget {
    constructor(store, limitUsd = 1, clock = () => new Date()) {
      if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
        throw new Error('persistent budget store required');
      }
      this.store = store;
      if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error('invalid daily limit');
      this.limitUsd = limitUsd;
      this.clock = clock;
    }

    reserve(amount) {
      if (!Number.isFinite(amount) || amount < 0) throw new Error('invalid reservation');
      const day = this.clock().toISOString().slice(0, 10);
      const prior = this.store.read();
      const spent = prior && prior.day === day ? prior.reservedUsd : 0;
      if (!Number.isFinite(spent) || spent < 0) throw new Error('corrupt budget record');
      if (spent + amount > this.limitUsd) throw new Error('daily model budget reached');
      // A failed request keeps its reservation. This is conservative and also
      // avoids double-spend after a crash or an uncertain network timeout.
      this.store.write({day, reservedUsd: spent + amount});
    }
  }

  function requestFor(provider, model, key, text, system, maxOutputTokens) {
    if (!ENDPOINTS[provider]) throw new Error('unsupported provider');
    if (!model || !key || !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 || maxOutputTokens > 4096) {
      throw new Error('model, key and valid output cap are required');
    }
    const headers = {'Content-Type': 'application/json'};
    if (provider === 'gemini') {
      if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('invalid Gemini model id');
      headers['x-goog-api-key'] = key;
      return {url: ENDPOINTS.gemini + model + ':generateContent', headers,
        body: {systemInstruction: {parts: [{text: system}]},
          contents: [{role: 'user', parts: [{text}]}],
          generationConfig: {maxOutputTokens}}};
    }
    if (provider === 'anthropic') {
      headers.Authorization = 'Bearer ' + key;
      headers['anthropic-version'] = '2023-06-01';
      return {url: ENDPOINTS.anthropic, headers,
        body: {model, system, max_tokens: maxOutputTokens,
          messages: [{role: 'user', content: text}]}};
    }
    headers.Authorization = 'Bearer ' + key;
    return {url: ENDPOINTS[provider], headers,
      body: {model, messages: [{role: 'system', content: system},
        {role: 'user', content: text}], max_tokens: maxOutputTokens, stream: false}};
  }

  function extract(provider, response) {
    if (provider === 'anthropic') {
      return (response.content || []).filter(item => item.type === 'text')
        .map(item => item.text).join('\n').trim();
    }
    if (provider === 'gemini') {
      return (response.candidates?.[0]?.content?.parts || [])
        .filter(part => typeof part.text === 'string').map(part => part.text).join('\n').trim();
    }
    const content = response.choices?.[0]?.message?.content;
    // Reasoning models (NVIDIA Nemotron) may prepend a <think> block.
    return typeof content === 'string' ?
      content.replace(/^[\s\S]*<\/think>\s*/i, '')
        .replace(/<think>[\s\S]*$/i, '').trim() : '';
  }

  class AssistantRouter {
    constructor({transport, keyFor, budget, provider, model, prices,
      maxOutputTokens = 512, system = 'Answer the user directly in English.'}) {
      if (!transport || typeof transport.post !== 'function' || typeof keyFor !== 'function' ||
          !budget || typeof budget.reserve !== 'function') {
        throw new Error('transport, key lookup and budget are required');
      }
      this.transport = transport;
      this.keyFor = keyFor;
      this.budget = budget;
      this.provider = provider;
      this.model = model;
      this.prices = prices;
      this.maxOutputTokens = maxOutputTokens;
      this.system = system;
    }

    async ask({text, requestId, signal}) {
      if (typeof text !== 'string' || !text.trim() || !requestId) {
        throw new Error('transcript and request id are required');
      }
      if (signal?.aborted) throw new Error('request cancelled');
      const key = this.keyFor(this.provider);
      const request = requestFor(this.provider, this.model, key,
        text, this.system, this.maxOutputTokens);
      this.budget.reserve(estimateUsd(text + this.system, this.maxOutputTokens, this.prices));
      const response = await this.transport.post(request.url, {
        headers: request.headers, body: request.body, signal, timeoutMs: 30000
      });
      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error('model request failed with status ' + (response?.status ?? 'unknown'));
      }
      const output = extract(this.provider, response.json);
      if (!output) throw new Error('model returned no text');
      return {requestId, provider: this.provider, text: output};
    }
  }

  const api = {AssistantRouter, DailyBudget, requestFor, extract, estimateUsd};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanAssistant = api;
})(globalThis);
