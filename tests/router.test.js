'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FeatureRouter } = require('../tools/patch/router');

const event = () => ({feature: 'datax', operation: 'out:18:6', requestId: 'one',
  payload: Uint8Array.from([1, 2, 3]), metadata: { source: 'glasses' }});
const mutableRouter = () => new FeatureRouter(undefined,
  {allowedMutations: ['datax:out:18:6']});

test('unconfigured events pass through once', () => {
  const router = new FeatureRouter();
  let calls = 0;
  router.dispatch(event(), () => ++calls);
  assert.equal(calls, 1);
});

test('observer gets an isolated copy and cannot change the original', () => {
  const router = new FeatureRouter();
  router.register({id: 'observe', feature: 'datax', operation: 'out:18:6',
    mode: 'observe', enabled: true, handle: seen => {
      seen.payload[0] = 99;
      assert.throws(() => { seen.metadata.source = 'changed'; });
    }});
  let calls = 0;
  router.dispatch(event(), forwarded => {
    ++calls;
    assert.deepEqual([...forwarded.payload], [1, 2, 3]);
    assert.equal(forwarded.metadata.source, 'glasses');
  });
  assert.equal(calls, 1);
});

test('transform keeps correlation and calls original once', () => {
  const router = mutableRouter();
  router.register({id: 'rewrite', feature: 'datax', operation: 'out:18:6',
    mode: 'transform', enabled: true,
    handle: () => ({payload: Uint8Array.from([4, 5])})});
  let calls = 0;
  router.dispatch(event(), forwarded => {
    ++calls;
    assert.equal(forwarded.requestId, 'one');
    assert.deepEqual([...forwarded.payload], [4, 5]);
  });
  assert.equal(calls, 1);
});

test('replacement suppresses the original even if handler fails', () => {
  const router = mutableRouter();
  router.register({id: 'replace', feature: 'datax', operation: 'out:18:6',
    mode: 'replace', enabled: true, handle: () => { throw new Error('provider failed'); }});
  let calls = 0;
  assert.throws(() => router.dispatch(event(), () => ++calls), /provider failed/);
  assert.equal(calls, 0);
});

test('replacement returns its own value and never calls original', () => {
  const router = mutableRouter();
  router.register({id: 'replace', feature: 'datax', operation: 'out:18:6',
    mode: 'replace', enabled: true, handle: () => 'ours'});
  let calls = 0;
  assert.equal(router.dispatch(event(), () => ++calls), 'ours');
  assert.equal(calls, 0);
});

test('tee explicitly runs both sides once', () => {
  const router = mutableRouter();
  let custom = 0;
  let original = 0;
  router.register({id: 'tee', feature: 'datax', operation: 'out:18:6',
    mode: 'tee', enabled: true, handle: () => ++custom});
  router.dispatch(event(), () => ++original);
  assert.equal(custom, 1);
  assert.equal(original, 1);
});

test('disable-all restores pass-through', () => {
  const router = mutableRouter();
  router.register({id: 'replace', feature: 'datax', operation: 'out:18:6',
    mode: 'replace', enabled: true, handle: () => 'ours'});
  router.disableAll();
  assert.equal(router.dispatch(event(), () => 'original'), 'original');
});

test('a second mutator cannot be enabled for the same operation', () => {
  const router = mutableRouter();
  router.register({id: 'first', feature: 'datax', operation: 'out:18:6',
    mode: 'replace', enabled: true, handle: () => null});
  router.register({id: 'second', feature: 'datax', operation: 'out:18:6',
    mode: 'replace', handle: () => null});
  assert.throws(() => router.setEnabled('second', true), /already enabled/);
});

test('nested replacement cannot fall through to the original', () => {
  const router = mutableRouter();
  let routed = 0;
  router.register({id: 'nested', feature: 'datax', operation: 'out:18:6',
    mode: 'replace', enabled: true, handle: () => {
      ++routed;
      return router.dispatch(event(), () => 'nested original');
    }});
  assert.throws(() => router.dispatch(event(), () => 'outer original'), /recursive/);
  assert.equal(routed, 1);
});

test('unmapped mutations are rejected, including firmware operations', () => {
  const router = new FeatureRouter();
  assert.throws(() => router.register({id: 'update', feature: 'datax',
    operation: 'out:99:1', mode: 'replace', enabled: true,
    handle: () => null}), /verified operation/);
});

test('thenables and oversized transformed buffers are rejected', () => {
  const router = new FeatureRouter(undefined, {allowedMutations: ['datax:out:18:6'],
    maxPayloadBytes: 3});
  router.register({id: 'oversize', feature: 'datax', operation: 'out:18:6',
    mode: 'transform', enabled: true, handle: () => ({payload: new Uint8Array(4)})});
  assert.throws(() => router.dispatch(event(), () => null), /invalid transformed payload/);
  router.setEnabled('oversize', false);
  router.register({id: 'thenable', feature: 'datax', operation: 'out:18:6',
    mode: 'replace', enabled: true, handle: () => ({then: () => {}})});
  assert.throws(() => router.dispatch(event(), () => null), /async replacement/);
});
