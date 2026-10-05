import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolMap } from '../src/tools/index.js';

const HELMET = 3448274439;
const KINETIC = 1498876634;
const C = 'c1';

/** 9 helmets on the character (full): h1..h9 with tier = index, h9 in a loadout. */
function setup() {
  const helmets = Array.from({ length: 9 }, (_, i) => ({
    itemHash: 100 + i,
    itemInstanceId: `h${i + 1}`,
    bucketHash: HELMET,
  }));
  const instances: Record<string, any> = {};
  const stats: Record<string, any> = {};
  helmets.forEach((h, i) => {
    instances[h.itemInstanceId] = { gearTier: i === 0 ? 3 : (i % 5) + 1 };
    stats[h.itemInstanceId] = { stats: { 1: { value: 10 * i }, 2: { value: 5 } } };
  });
  const moves: string[] = [];
  const ctx: any = {
    inventory: {
      resolvePrimary: async () => ({ membershipType: 3, membershipId: 'm' }),
      noteTransfer: (_mt: number, id: string) => moves.push(`noted:${id}`),
    },
    api: {
      getProfile: async () => ({
        Response: {
          profileInventory: { data: { items: [{ bucketHash: 138197802 }] } },
          characterInventories: {
            data: {
              [C]: {
                items: [...helmets, { itemHash: 1, itemInstanceId: 'k1', bucketHash: KINETIC }],
              },
            },
          },
          characterLoadouts: {
            data: { [C]: { loadouts: [{ items: [{ itemInstanceId: 'h1' }] }] } },
          },
          itemComponents: { instances: { data: instances }, stats: { data: stats } },
        },
      }),
      transferItem: async (a: any) => {
        moves.push(`vault:${a.itemId}`);
        return { ErrorCode: 1 };
      },
    },
    manifest: {
      getDefinitions: async (table: string, hashes: any[]) =>
        Object.fromEntries(
          hashes.map((h) => [
            String(h),
            table === 'DestinyInventoryBucketDefinition'
              ? { itemCount: Number(h) === 138197802 ? 700 : 10 }
              : { displayProperties: { name: `Helmet ${h}` } },
          ])
        ),
    },
  };
  return { ctx, moves };
}

const run = (ctx: any, args: object) =>
  toolMap.get('make_room')!.handler(ctx, { characterId: C, ...args }) as Promise<any>;

test('make_room previews the worst items, skipping loadout items and roomy buckets', async () => {
  const { ctx, moves } = setup();
  const out = await run(ctx, {});
  assert.equal(out.preview, true);
  assert.equal(out.plan.length, 1, 'kinetic bucket has room, only helmets listed');
  const ids = out.plan[0].move.map((c: any) => c.instanceId);
  // tiers: h1=3 (in loadout, skipped), h2=2 h3=3 h4=4 h5=5 h6=1 h7=2 h8=3 h9=4
  assert.deepEqual(ids, ['h6', 'h2', 'h7']);
  assert.equal(out.vaultFree, 699);
  assert.deepEqual(moves, [], 'preview moves nothing');
});

test('make_room apply=true moves and records them', async () => {
  const { ctx, moves } = setup();
  const out = await run(ctx, { apply: true, freeSlots: 1 });
  assert.equal(out.moved.length, 1);
  assert.deepEqual(moves, ['vault:h6', 'noted:h6']);
});
