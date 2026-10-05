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
    classType: 1,
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
            bucketHash: defs[h].inventory.bucketTypeHash,
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
  // Class comes from the definition (Hunter), not the character holding it (Warlock).
  assert.equal(armor.armor[0].class, 'Hunter');
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

test('armor snapshots from an older schema are ignored on load', async () => {
  const { cache, dataDir } = setup();
  await cache.refreshBoth(3, 'm1');
  const file = path.join(dataDir, 'inventory', 'armor-3-m1.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf-8'));
  delete old.schema;
  fs.writeFileSync(file, JSON.stringify(old));
  assert.equal(setup(dataDir).cache.getArmorSnapshot(3, 'm1'), undefined);
});

/** Profile where item i1 is in the vault and i2 is equipped on the Warlock (c1). */
function profileWith(i1: { location: number; on?: string }, i2Equipped = true) {
  const char = (cid: string) => ({
    items: [
      ...(i1.on === cid ? [{ itemHash: 10, itemInstanceId: 'i1', location: 1 }] : []),
      ...(!i2Equipped && cid === 'c1' ? [{ itemHash: 20, itemInstanceId: 'i2', location: 1 }] : []),
    ],
  });
  return {
    Response: {
      ...profile.Response,
      profileInventory: {
        data: {
          items: i1.on ? [] : [{ itemHash: 10, itemInstanceId: 'i1', location: i1.location }],
        },
      },
      characterInventories: { data: { c1: char('c1') } },
      characterEquipment: {
        data: {
          c1: { items: i2Equipped ? [{ itemHash: 20, itemInstanceId: 'i2', location: 1 }] : [] },
        },
      },
    },
  };
}

test('recorded writes survive lagging refreshes until Bungie agrees', async () => {
  const { cache } = setup();
  let current: any = profileWith({ location: 2 }); // i1 in vault
  (cache as any).api.getInventoryProfile = async () => current;
  await cache.refresh(3, 'm1');

  cache.noteTransfer(3, 'i1', false, 'c1'); // we moved i1 to the Warlock
  const loc = () => cache.get(3, 'm1')!.items.find((r) => r.instanceId === 'i1');
  assert.equal(loc()?.location, 'inventory');
  assert.equal(loc()?.character, 'Warlock');

  await cache.refresh(3, 'm1'); // Bungie still says vault (stale)
  assert.equal(loc()?.location, 'inventory');
  assert.deepEqual([...cache.pendingIds(3, 'm1')], ['i1']);

  current = profileWith({ location: 1, on: 'c1' }); // Bungie caught up
  await cache.refresh(3, 'm1');
  assert.equal(loc()?.characterId, 'c1');
  assert.equal(cache.pendingIds(3, 'm1').size, 0);
});

test('equipping displaces the item previously equipped in that slot', async () => {
  const { cache } = setup();
  (cache as any).api.getInventoryProfile = async () => profileWith({ location: 1, on: 'c1' });
  defs[10].inventory.bucketTypeHash = HELMET_BUCKET; // i1 is another helmet
  try {
    await cache.refresh(3, 'm1');
    cache.noteEquip(3, 'c1', ['i1']);
    const rows = cache.get(3, 'm1')!.items;
    assert.equal(rows.find((r) => r.instanceId === 'i1')?.location, 'equipped');
    assert.equal(rows.find((r) => r.instanceId === 'i2')?.location, 'inventory');
  } finally {
    delete defs[10].inventory.bucketTypeHash;
  }
});

test('recorded writes expire so Bungie wins eventually', async (t) => {
  const { cache } = setup();
  (cache as any).api.getInventoryProfile = async () => profileWith({ location: 2 });
  await cache.refresh(3, 'm1');
  cache.noteTransfer(3, 'i1', false, 'c1');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 6 * 60_000 });
  await cache.refresh(3, 'm1');
  assert.equal(cache.get(3, 'm1')!.items.find((r) => r.instanceId === 'i1')?.location, 'vault');
});
