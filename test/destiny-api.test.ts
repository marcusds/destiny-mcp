import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, AxiosHeaders } from 'axios';
import { DestinyAPI, path, text } from '../src/destiny-api.js';
import { tempDir } from './helpers.js';

test('path() accepts plain IDs and pre-encoded text', () => {
  assert.equal(path`/Destiny2/${3}/Profile/${'4611686018'}/`, '/Destiny2/3/Profile/4611686018/');
  assert.equal(path`/GroupV2/Name/${text('Clan Name.x')}/1/`, '/GroupV2/Name/Clan%20Name.x/1/');
});

test('path() rejects traversal and separators in IDs', () => {
  for (const bad of ['1/../2', '..', '1?x=2', '1#', '', 'a b', '%2F']) {
    assert.throws(() => path`/GroupV2/${bad}/`, /Invalid path parameter/, bad);
  }
});

test('text() rejects values Bungie would decode into a traversal', () => {
  for (const bad of ['..', '.', '. .', 'x/../..', 'x%2F..', 'a\\b', '  ']) {
    assert.throws(() => text(bad), /Invalid path text/, bad);
  }
});

function apiWithStub(handler: (call: number) => unknown) {
  const cfg: any = { apiKey: 'k', baseUrl: 'https://example.invalid', dataDir: tempDir() };
  const auth: any = {
    getAccessTokenIfAuthed: async () => null,
    getValidAccessToken: async () => 't',
  };
  const api = new DestinyAPI(cfg, auth);
  let calls = 0;
  (api as any).client.request = async () => handler(++calls);
  return { api, calls: () => calls };
}

function httpError(status: number, data: unknown): AxiosError {
  const response: any = { status, data, headers: {}, config: { headers: new AxiosHeaders() } };
  return new AxiosError('fail', 'ERR_BAD_RESPONSE', response.config, null, response);
}

test('retries after a 429 and then succeeds', async () => {
  const { api, calls } = apiWithStub((n) => {
    if (n === 1) throw httpError(429, { ErrorCode: 51, ThrottleSeconds: 0, Message: 'slow down' });
    return { data: { ErrorCode: 1, Response: 'ok' } };
  });
  const result = await api.getPublicMilestones();
  assert.equal(result.Response, 'ok');
  assert.equal(calls(), 2);
});

test('does not retry ordinary gameplay errors', async () => {
  const { api, calls } = apiWithStub(() => {
    throw httpError(500, {
      ErrorCode: 1623,
      ErrorStatus: 'DestinyItemNotFound',
      ThrottleSeconds: 0,
      Message: 'Item not found',
    });
  });
  await assert.rejects(api.getPublicMilestones(), /1623 \(DestinyItemNotFound\): Item not found/);
  assert.equal(calls(), 1);
});
