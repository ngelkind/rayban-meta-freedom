/* Feature router shared by the Android agent and the offline Node tests.
 * A handler runs synchronously because the current Java hooks are synchronous.
 * Async media/network work belongs in a separate bounded queue, not here.
 */
'use strict';

(function (root) {
  const MODES = new Set(['observe', 'transform', 'replace', 'tee']);
  const isThenable = value => value !== null && value !== undefined &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function';

  function copy(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(copy);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    const result = {};
    for (const key of Object.keys(value)) result[key] = copy(value[key]);
    return result;
  }

  function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return value;
  }

  function readable(event) {
    return deepFreeze(copy(event));
  }

  class FeatureRouter {
    constructor(report, options = {}) {
      this._handlers = [];
      this._disabled = false;
      this._busy = new Set();
      this._report = report || function () {};
      this._allowedMutations = new Set(options.allowedMutations || []);
      this._maxPayloadBytes = options.maxPayloadBytes || 1024 * 1024;
    }

    register(spec) {
      if (!spec || !spec.id || !spec.feature || !spec.operation ||
          !MODES.has(spec.mode) || typeof spec.handle !== 'function') {
        throw new Error('invalid handler specification');
      }
      if (spec.mode !== 'observe' &&
          !this._allowedMutations.has(spec.feature + ':' + spec.operation)) {
        throw new Error('mutation requires a verified operation');
      }
      if (this._handlers.some(h => h.id === spec.id)) throw new Error('duplicate handler: ' + spec.id);
      if (spec.enabled === true && spec.mode !== 'observe' && this._handlers.some(h => h.enabled && h.mode !== 'observe' &&
          h.feature === spec.feature && h.operation === spec.operation)) {
        throw new Error('mutating handler already registered for this operation');
      }
      const handler = { id: spec.id, feature: spec.feature, operation: spec.operation,
        mode: spec.mode, handle: spec.handle, enabled: spec.enabled === true };
      this._handlers.push(handler);
      return handler.id;
    }

    setEnabled(id, enabled) {
      const handler = this._handlers.find(h => h.id === id);
      if (!handler) throw new Error('unknown handler: ' + id);
      if (enabled && handler.mode !== 'observe' && this._handlers.some(h => h !== handler &&
          h.enabled && h.mode !== 'observe' && h.feature === handler.feature &&
          h.operation === handler.operation)) {
        throw new Error('mutating handler already enabled for this operation');
      }
      handler.enabled = !!enabled;
    }

    disableAll() { this._disabled = true; }
    enableAll() { this._disabled = false; }

    status() {
      return { disabled: this._disabled, handlers: this._handlers.map(h => ({
        id: h.id, feature: h.feature, operation: h.operation, mode: h.mode, enabled: h.enabled
      })) };
    }

    hasHandler(feature, operation) {
      return !this._disabled && this._handlers.some(h => h.enabled &&
        h.feature === feature && h.operation === operation);
    }

    dispatch(event, original) {
      if (!event || typeof event.feature !== 'string' || typeof event.operation !== 'string' ||
          typeof original !== 'function') throw new Error('invalid dispatch');
      if (this._disabled) return original(event);
      const key = event.feature + ':' + event.operation;
      if (this._busy.has(key)) throw new Error('recursive feature dispatch');
      this._busy.add(key);
      try {
        let current = copy(event);
        const matching = this._handlers.filter(h => h.enabled && h.feature === event.feature &&
          h.operation === event.operation);
        for (const handler of matching.filter(h => h.mode === 'observe')) {
          try { handler.handle(readable(current)); }
          catch (error) { this._report(handler.id, String(error)); }
        }
        const mutator = matching.find(h => h.mode !== 'observe');
        if (!mutator) return original(current);
        if (mutator.mode === 'transform') {
          const update = mutator.handle(readable(current));
          if (!update || typeof update !== 'object' || isThenable(update)) {
            throw new Error('transform must synchronously return an update');
          }
          if (update.feature !== undefined && update.feature !== event.feature) {
            throw new Error('transform cannot change feature');
          }
          if (update.operation !== undefined && update.operation !== event.operation) {
            throw new Error('transform cannot change operation');
          }
          for (const key of ['requestId', 'direction', 'serviceId', 'opcode']) {
            if (update[key] !== undefined && update[key] !== event[key]) {
              throw new Error('transform cannot change ' + key);
            }
          }
          if (update.payload !== undefined &&
              (!(update.payload instanceof Uint8Array) ||
               update.payload.length > this._maxPayloadBytes)) {
            throw new Error('invalid transformed payload');
          }
          current = Object.assign(current, copy(update));
          return original(current);
        }
        if (mutator.mode === 'replace') {
          const replacement = mutator.handle(readable(current));
          if (isThenable(replacement)) throw new Error('async replacement is unsupported');
          return replacement;
        }
        // tee is explicit: the handler is called once and the original once.
        // A failed tee never silently retries an external side effect.
        const teeResult = mutator.handle(readable(current));
        if (isThenable(teeResult)) throw new Error('async tee is unsupported');
        return original(current);
      } finally {
        this._busy.delete(key);
      }
    }
  }

  const api = { FeatureRouter, copy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RaybanRouter = api;
})(globalThis);
