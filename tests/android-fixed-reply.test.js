'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {install} = require('../tools/patch/android-fixed-reply');
const {validate} = require('../tools/patch/config');

// Like Frida: .call() reaches the original only from inside the replacement;
// from anywhere else it re-enters the replacement.
function fakeJava() {
  const calls = [];
  let inside = 0;
  function hooked(method, original) {
    method.overload = () => method;
    method.call = (self, ...args) => {
      if (inside > 0 || !method.implementation) return original(self, ...args);
      inside++;
      try { return method.implementation.apply(self, args); } finally { inside--; }
    };
    const wrap = () => {
      const impl = method._impl;
      return function (...args) {
        inside++;
        try { return impl.apply(this, args); } finally { inside--; }
      };
    };
    Object.defineProperty(method, 'implementation', {
      get() { return method._impl ? wrap() : null; },
      set(fn) { method._impl = fn; }
    });
    return method;
  }
  const write = hooked(function () {},
    (stream, buffer) => calls.push(['write', stream.name, buffer.label]));
  const close = hooked(function () {}, stream => calls.push(['close', stream.name]));
  const Java = {
    retain: value => value,
    use(name) {
      if (name === 'X.EUx') return {write, close};
      if (name === 'java.nio.ByteBuffer') return {allocate: () => ({label: 'empty'})};
      throw new Error('unexpected class ' + name);
    }
  };
  return {Java, write, close, calls};
}

function stream(name, id) {
  return {name, A01: {value: {getInteractionId: () => id, getSamplingRate: () => 24000,
    getOpusCeltCbrBitrateBps: () => 0}}};
}

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r));
}

test('our reply is written into Meta stream before Meta close goes through', async () => {
  const previous = global.Java;
  const fake = fakeJava();
  global.Java = fake.Java;
  const encoded = [];
  try {
    const hook = install({text: 'fallback', sleep: async () => {},
      respond: async ({text}) => 'answer to ' + text,
      encoder: {encode: async request => {
        encoded.push(request);
        return [{label: 'p1'}, {label: 'p2'}];
      }}});
    hook.onFinal({requestId: 'r', text: 'hey meta tell me a joke', final: true});
    const s = stream('s1', 'turn-1');
    fake.write.implementation.call(s, {label: 'meta-1'});
    fake.write.implementation.call(s, {label: 'meta-2'});
    fake.close.implementation.call(s);          // Meta finished early: held
    assert.deepEqual(fake.calls, [['write', 's1', 'empty']]);
    await settle();
    assert.equal(encoded[0].text, 'answer to hey meta tell me a joke');
    assert.equal(encoded[0].sampleRate, 24000);
    assert.deepEqual(fake.calls, [['write', 's1', 'empty'], ['write', 's1', 'p1'],
      ['write', 's1', 'p2'], ['close', 's1']]);
  } finally {
    global.Java = previous;
  }
});

test('a late Meta close passes straight through after our audio', async () => {
  const previous = global.Java;
  const fake = fakeJava();
  global.Java = fake.Java;
  try {
    install({text: 'test', sleep: async () => {},
      encoder: {encode: async () => [{label: 'p1'}]}});
    const s = stream('s2', 'turn-2');
    fake.write.implementation.call(s, {label: 'meta'});
    await settle();
    fake.close.implementation.call(s);
    assert.deepEqual(fake.calls, [['write', 's2', 'empty'], ['write', 's2', 'p1'],
      ['close', 's2']]);
  } finally {
    global.Java = previous;
  }
});

test('encoder failure closes the stream and uses the fallback speaker', async () => {
  const previous = global.Java;
  const fake = fakeJava();
  global.Java = fake.Java;
  const spoken = [];
  const states = [];
  try {
    install({text: 'test', sleep: async () => {}, onState: s => states.push(s),
      encoder: {encode: async () => { throw new Error('no codec'); }},
      fallback: {speak: async request => { spoken.push(request.text); }}});
    const s = stream('s3', 'turn-3');
    fake.write.implementation.call(s, {label: 'meta'});
    fake.close.implementation.call(s);
    await settle();
    assert.deepEqual(fake.calls, [['write', 's3', 'empty'], ['close', 's3']]);
    assert.deepEqual(spoken, ['test']);
    assert.ok(states.some(state => state.startsWith('encode-failed')));
  } finally {
    global.Java = previous;
  }
});

test('fixed reply config is off by default and exclusive with other audio hooks', () => {
  assert.deepEqual({...validate({}).fixedReply},
    {enabled: false, text: null, source: 'fixed', model: null});
  assert.equal(validate({fixedReply: {enabled: true, text: 'test', source: 'echo'}})
    .fixedReply.source, 'echo');
  assert.throws(() => validate({fixedReply: {enabled: true, text: 'test', source: 'x'}}),
    /source/);
  const modelPick = validate({fixedReply: {enabled: true, text: 'test', source: 'model',
    model: 'openai/gpt-oss-20b'}}).fixedReply.model;
  assert.equal(modelPick.provider, 'nvidia');
  assert.equal(modelPick.maxOutputTokens, 300);
  assert.throws(() => validate({fixedReply: {enabled: true, text: 'test', source: 'model'}}),
    /fixedReply.model/);
  assert.throws(() => validate({fixedReply: {enabled: true, text: 'test', source: 'model',
    model: 'm', apiKey: 'secret'}}), /credentials/);
  assert.throws(() => validate({fixedReply: {enabled: true}}), /fixedReply.text/);
  assert.throws(() => validate({fixedReply: {enabled: true, text: '  '}}), /blank/);
  assert.throws(() => validate({fixedReply: {enabled: true, text: 'test'},
    trace: {assistant: true}}), /requires/);
  assert.throws(() => validate({fixedReply: {enabled: true, text: 'test'},
    diagnostics: {muteDataxTestId: 'x'}}), /requires/);
});

test('reasoning text is removed from OpenAI-shaped replies', () => {
  const {extract} = require('../tools/patch/assistant');
  const reply = content => extract('nvidia', {choices: [{message: {content}}]});
  assert.equal(reply('<think>notes</think>\nWhy did it win?'), 'Why did it win?');
  assert.equal(reply('notes without an opening tag</think> Why did it win?'),
    'Why did it win?');
});

test('follow-up turns use the matching partial transcript when no final arrives', async () => {
  const previous = global.Java;
  const fake = fakeJava();
  global.Java = fake.Java;
  const asked = [];
  let now = 1000;
  try {
    const hook = install({text: 'fallback', now: () => now,
      sleep: async ms => { now += ms; },
      respond: async ({text}) => { asked.push(text); return 'ok'; },
      encoder: {encode: async () => [{label: 'p'}]}});
    hook.onTranscript({requestId: 'turn-a', text: 'first question', final: true});
    hook.onTranscript({requestId: 'turn-b', text: 'second', final: false});
    hook.onTranscript({requestId: 'turn-b', text: 'second question', final: false});
    fake.write.implementation.call(stream('sb', 'turn-b'), {label: 'meta'});
    await settle(40);
    fake.write.implementation.call(stream('sa', 'turn-a'), {label: 'meta'});
    await settle(40);
    assert.deepEqual(asked, ['second question', 'first question']);
  } finally {
    global.Java = previous;
  }
});

test('transcript events keep partials and finals with their interaction id', () => {
  const {transcriptEvent} = require('../tools/patch/android-transcript');
  const desc = fields => ({A01: index => fields[index] ?? null});
  assert.deepEqual(transcriptEvent(desc({0: 'hello', 4: 'id-1', 8: false})),
    {requestId: 'id-1', text: 'hello', final: false});
  assert.deepEqual(transcriptEvent(desc({0: 'hello there', 4: 'id-1', 8: true})),
    {requestId: 'id-1', text: 'hello there', final: true});
  assert.equal(transcriptEvent(desc({0: '  ', 4: 'id-1', 8: true})), null);
});
