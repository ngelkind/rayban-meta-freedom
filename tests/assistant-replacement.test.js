'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TurnEngine} = require('../tools/patch/assistant-turn');
const {AudioGate} = require('../tools/patch/assistant-audio-gate');
const {ReplacementSession} = require('../tools/patch/assistant-replacement');

test('successful model reply claims and discards the original stream', async () => {
  let resolveModel;
  let opened = 0;
  let spoken = 0;
  let completed = 0;
  const session = new ReplacementSession({TurnEngine, AudioGate, mode: 'replace',
    model: {ask: () => new Promise(resolve => { resolveModel = resolve; })},
    speaker: {speak: async () => { spoken++; }}});
  const result = session.onFinal({requestId: 'turn', text: 'Question', final: true});
  const stream = session.gate.open('turn', () => { opened++; return {
    write() {}, close() {}
  }; }, () => { completed++; });
  stream.write(new Uint8Array([1, 2]));
  stream.close();
  resolveModel({requestId: 'turn', text: 'Custom reply'});
  assert.equal((await result).status, 'complete');
  assert.equal(opened, 0);
  assert.equal(spoken, 1);
  assert.equal(completed, 1);
});

test('failed model releases the original and never speaks', async () => {
  let opened = 0;
  let spoken = 0;
  const session = new ReplacementSession({TurnEngine, AudioGate, mode: 'replace',
    model: {ask: async () => { throw new Error('offline'); }},
    speaker: {speak: async () => { spoken++; }}});
  const pending = session.onFinal({requestId: 'turn', text: 'Question', final: true});
  const stream = session.gate.open('turn', () => { opened++; return {
    write() {}, close() {}
  }; }, () => {});
  stream.close();
  assert.equal((await pending).status, 'failed');
  assert.equal(opened, 1);
  assert.equal(spoken, 0);
});

test('a reply already started before the final transcript is left alone', async () => {
  let models = 0;
  const session = new ReplacementSession({TurnEngine, AudioGate, mode: 'replace',
    model: {ask: async () => { models++; }}, speaker: {speak: async () => {}}});
  session.gate.observeOriginal('turn');
  assert.equal((await session.onFinal({requestId: 'turn', text: 'Q', final: true})).status,
    'original-already-started');
  assert.equal(models, 0);
});
