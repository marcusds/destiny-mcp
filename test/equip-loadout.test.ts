import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolMap } from '../src/tools/index.js';

const HUNTER = 'h';
const TITAN = 't';
const HELMET = 1;
const KINETIC = 2;

type Row = {
  instanceId: string;
  name: string;
  hash: number;
  location: string;
  characterId?: string;
  character?: string;
  bucketHash: number;
};

/** Fake Bungie account: transfers/equips mutate `world`; one helmet slot is "full". */
function fakeAccount(world: Row[], opts: { helmetSlotsFree: number }) {
  const calls: string[] = [];
  let helmetFree = opts.helmetSlotsFree;
  const find = (id: string) => world.find((r) => r.instanceId === id)!;
  const ctx: any = {
    inventory: {
      resolvePrimary: async () => ({ membershipType: 3, membershipId: 'm' }),
      refresh: async () => ({ items: world.map((r) => ({ ...r })) }),
    },
    api: {
      getCharacterLoadouts: async () => ({
        Response: {
          characterLoadouts: {
            data: {
              [HUNTER]: {
                loadouts: [
                  {
                    items: [
                      { itemInstanceId: 'helm' },
                      { itemInstanceId: 'gun' },
                      { itemInstanceId: 'held' },
                    ],
                  },
                ],
              },
            },
          },
        },
      }),
      transferItem: async (a: any) => {
        const row = find(a.itemId);
        calls.push(`${a.transferToVault ? 'vault' : 'char'}:${row.name}`);
        if (a.transferToVault) {
          if (row.bucketHash === HELMET && row.characterId === HUNTER) helmetFree++;
          row.location = 'vault';
          row.characterId = undefined;
        } else {
          if (row.bucketHash === HELMET) {
            if (helmetFree === 0)
              throw new Error('Bungie API Error 1642 (DestinyNoRoomInDestination): no room');
            helmetFree--;
          }
          row.location = 'inventory';
          row.characterId = a.characterId;
        }
        return { ErrorCode: 1 };
      },
      equipLoadout: async () => {
        calls.push('equipLoadout');
        // Like Bungie: only items already on the character get equipped.
        for (const id of ['helm', 'gun', 'held']) {
          const row = find(id);
          if (row.characterId === HUNTER) row.location = 'equipped';
        }
        return { ErrorCode: 1 };
      },
    },
  };
  return { ctx, calls };
}

test('equip_loadout stages vault and other-character items, making room when full', async () => {
  const world: Row[] = [
    {
      instanceId: 'helm',
      name: 'AION Adapter Mask',
      hash: 10,
      location: 'vault',
      bucketHash: HELMET,
    },
    {
      instanceId: 'gun',
      name: 'VS Chill Inhibitor',
      hash: 11,
      location: 'inventory',
      characterId: TITAN,
      character: 'Titan',
      bucketHash: KINETIC,
    },
    {
      instanceId: 'held',
      name: "Khepri's Sting",
      hash: 12,
      location: 'inventory',
      characterId: HUNTER,
      character: 'Hunter',
      bucketHash: 3,
    },
    {
      instanceId: 'spare',
      name: 'Veritas Cowl',
      hash: 13,
      location: 'inventory',
      characterId: HUNTER,
      character: 'Hunter',
      bucketHash: HELMET,
    },
  ];
  const { ctx, calls } = fakeAccount(world, { helmetSlotsFree: 0 });
  const out: any = await toolMap
    .get('equip_loadout')!
    .handler(ctx, { loadoutIndex: 0, characterId: HUNTER });

  assert.deepEqual(calls, [
    'char:AION Adapter Mask', // fails: slot full
    'vault:Veritas Cowl', // make room
    'char:AION Adapter Mask',
    'vault:VS Chill Inhibitor', // Titan -> vault
    'char:VS Chill Inhibitor', // vault -> Hunter
    'equipLoadout',
  ]);
  assert.deepEqual(out.notEquipped, []);
  assert.deepEqual(out.problems, []);
  assert.equal(out.equipped, 3);
});

test('equip_loadout reports items it could not stage instead of claiming success', async () => {
  const world: Row[] = [
    {
      instanceId: 'helm',
      name: 'AION Adapter Mask',
      hash: 10,
      location: 'vault',
      bucketHash: HELMET,
    },
    {
      instanceId: 'gun',
      name: 'VS Chill Inhibitor',
      hash: 11,
      location: 'equipped',
      characterId: TITAN,
      character: 'Titan',
      bucketHash: KINETIC,
    },
    {
      instanceId: 'held',
      name: "Khepri's Sting",
      hash: 12,
      location: 'inventory',
      characterId: HUNTER,
      character: 'Hunter',
      bucketHash: 3,
    },
  ];
  const { ctx } = fakeAccount(world, { helmetSlotsFree: 0 }); // full, and nothing spare to move
  const out: any = await toolMap
    .get('equip_loadout')!
    .handler(ctx, { loadoutIndex: 0, characterId: HUNTER });

  assert.equal(out.equipped, 1);
  assert.deepEqual(out.notEquipped.sort(), ['AION Adapter Mask', 'VS Chill Inhibitor']);
  assert.equal(out.problems.length, 2);
  assert.match(out.problems.join(' '), /equipped on your Titan/);
});
