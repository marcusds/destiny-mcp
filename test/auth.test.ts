import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import axios from 'axios';
import { BungieAuth, extractCode } from '../src/auth.js';
import { sleep, tempDir } from './helpers.js';

test('extractCode handles redirect URLs, query strings and bare codes', () => {
  assert.equal(extractCode('https://localhost:7777/callback?code=ab%2Bc&state=s'), 'ab+c');
  assert.equal(extractCode('?code=xyz&state=s'), 'xyz');
  assert.equal(extractCode('abc123'), 'abc123');
  assert.equal(extractCode('not a code!'), null);
  assert.equal(extractCode(''), null);
});

function writeTokens(dir: string, tokens: object) {
  fs.writeFileSync(`${dir}/tokens.json`, JSON.stringify(tokens));
}

test('concurrent callers share a single token refresh', async (t) => {
  const dir = tempDir();
  writeTokens(dir, {
    accessToken: 'old',
    refreshToken: 'r1',
    tokenType: 'Bearer',
    membershipId: '42',
    accessExpiresAt: 0,
  });
  let posts = 0;
  t.mock.method(axios, 'post', async () => {
    posts++;
    await sleep(20);
    return {
      data: {
        access_token: `new${posts}`,
        refresh_token: 'r2',
        expires_in: 3600,
        token_type: 'Bearer',
        membership_id: '42',
      },
    };
  });
  const auth = new BungieAuth({ apiKey: 'k', baseUrl: '', clientId: '1', dataDir: dir });
  const tokens = await Promise.all(Array.from({ length: 5 }, () => auth.getValidAccessToken()));
  assert.equal(posts, 1);
  assert.deepEqual(new Set(tokens), new Set(['new1']));
});

test('picks up a login and logout made by another process', async () => {
  const dir = tempDir();
  const valid = { tokenType: 'Bearer', accessExpiresAt: Date.now() + 3_600_000 };
  writeTokens(dir, { ...valid, accessToken: 'a', membershipId: '1' });
  const auth = new BungieAuth({ apiKey: 'k', baseUrl: '', dataDir: dir });
  assert.equal(auth.getMembershipId(), '1');

  await sleep(20); // ensure a distinct mtime
  writeTokens(dir, { ...valid, accessToken: 'b', membershipId: '2' });
  assert.equal(auth.getMembershipId(), '2');

  fs.unlinkSync(`${dir}/tokens.json`);
  assert.equal(auth.isAuthenticated(), false);
});
