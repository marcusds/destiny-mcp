import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { InventoryCache } from '../src/inventory.js';
import { tempDir } from './helpers.js';

const HELMET_BUCKET = 3448274439;

const profile = {
  Response: {
    characters: { data: { c1: { classType: 2 } } },
    profileInventory: { data: { items: [{ itemHash: 10, itemInstanceId: 'i1', location: 2 }] } },
    characterInventories: { data: { c1: { items: [] } } },
    characterEquipment: {
      data: { c1: { items: [{ itemHash: 20, itemInstanceId: 'i2', location: 1 }] } },
    },
    itemComponents: {
      instances: { data: { i2: { gearTier: 5, energy: { energyCapacity: 10 } } } },
      stats: { data: { i2: { stats: { 1: { value: 30 } } } } },
    },
  },
};

const defs: Record<string, any> = {
  10: {
    displayProperties: { name: 'Gjallarhorn' },
    itemTypeDisplayName: 'Rocket Launcher',
    inventory: { tierTypeName: 'Exotic' },
  },
  20: {
    displayProperties: { name: 'Hood' },
    itemTypeDisplayName: 'Helmet',
    inventory: { tierTypeName: 'Legendary', bucketTypeHash: HELMET_BUCKET },
  },
};

function setup(dataDir = tempDir()) {
  const calls = { armorProfile: 0, inventoryProfile: 0 };
  const api: any = {
    getArmorProfile: async () => (calls.armorProfile++, profile),
    getInventoryProfile: async () => (calls.inventoryProfile++, profile),
  };
  const lookup = async (table: string, hashes: number[]) =>
    Object.fromEntries(
      hashes.map((h) => [
        String(h),
        table === 'DestinyStatDefinition'
          ? { displayProperties: { name: 'Weapons' } }
          : (defs[h] ?? null),
      ])
    );
  const manifest: any = {
    getDefinitions: lookup,
    resolveItems: async (hashes: number[]) =>
      Object.fromEntries(
        hashes.map((h) => [
          String(h),
          {
            name: defs[h].displayProperties.name,
            itemType: defs[h].itemTypeDisplayName,
            tier: defs[h].inventory.tierTypeName,
          },
        ])
      ),
  };
  const auth: any = { getMembershipId: () => 'bnet1' };
  return {
    cache: new InventoryCache(api, manifest, auth, { apiKey: '', baseUrl: '', dataDir }),
    calls,
    dataDir,
  };
}

test('refreshBoth builds inventory and armor from one profile fetch', async () => {
  const { cache, calls } = setup();
  const { inventory, armor } = await cache.refreshBoth(3, 'm1');
  assert.equal(calls.armorProfile + calls.inventoryProfile, 1);
  assert.deepEqual(
    inventory.items.map((i) => [i.name, i.location, i.character]),
    [
      ['Gjallarhorn', 'vault', undefined],
      ['Hood', 'equipped', 'Warlock'],
    ]
  );
  assert.equal(armor.armor.length, 1);
  assert.deepEqual(armor.armor[0].stats, { Weapons: 30 });
  assert.equal(armor.armor[0].tier, 5);
});

test('a corrupt cache file is skipped without dropping the others', async () => {
  const { cache, dataDir } = setup();
  await cache.refreshBoth(3, 'm1');
  fs.writeFileSync(path.join(dataDir, 'inventory', '0-corrupt.json'), '{not json');

  const reloaded = setup(dataDir).cache;
  assert.equal(reloaded.get(3, 'm1')?.items.length, 2);
  assert.equal(reloaded.getArmorSnapshot(3, 'm1')?.armor.length, 1);
});

test('re-resolves the primary membership when the logged-in account changes', async () => {
  const { cache } = setup();
  let account = 'bnet1';
  (cache as any).auth = { getMembershipId: () => account };
  (cache as any).api.getMembershipsForCurrentUser = async () => ({
    Response: { destinyMemberships: [{ membershipType: 3, membershipId: `d-${account}` }] },
  });
  assert.equal((await cache.resolvePrimary())?.membershipId, 'd-bnet1');
  account = 'bnet2';
  assert.equal((await cache.resolvePrimary())?.membershipId, 'd-bnet2');
});
