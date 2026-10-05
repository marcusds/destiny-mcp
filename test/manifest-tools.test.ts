import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolMap } from '../src/tools/index.js';

const gjallarhorn = {
  hash: 1363886209,
  displayProperties: { name: 'Gjallarhorn', description: '' },
  itemTypeDisplayName: 'Rocket Launcher',
  inventory: { tierTypeName: 'Exotic' },
  classType: 3,
  sockets: { socketEntries: new Array(10).fill({ socketTypeHash: 1 }) },
};
const ctx: any = { manifest: { searchByName: async () => [gjallarhorn] } };
const search = toolMap.get('manifest_search')!;

test('manifest_search returns compact summaries by default', async () => {
  assert.deepEqual(await search.handler(ctx, { query: 'gjallar' }), [
    { hash: 1363886209, name: 'Gjallarhorn', type: 'Rocket Launcher', tier: 'Exotic' },
  ]);
});

test('manifest_search returns raw definitions with full=true', async () => {
  assert.deepEqual(await search.handler(ctx, { query: 'gjallar', full: true }), [gjallarhorn]);
});
