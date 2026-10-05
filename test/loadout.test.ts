import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolMap } from '../src/tools/index.js';

const EMPTY = 100;
const ITEM_HASH = 900;
const PLUG_SET = 500;

/** Fake tool context for one item whose sockets all draw from one plugSet. */
function fakeCtx(opts: {
  sockets: number[];
  plugs: Record<number, { name: string; cost?: number }>;
  energy?: { energyCapacity: number; energyUsed: number };
  failInsert?: (plugHash: number) => boolean;
}) {
  const inserts: Array<{ socketIndex: number; plugItemHash: number }> = [];
  const defs: Record<number, any> = { [EMPTY]: { displayProperties: { name: 'Empty Socket' } } };
  for (const [hash, p] of Object.entries(opts.plugs)) {
    defs[Number(hash)] = {
      displayProperties: { name: p.name },
      plug: p.cost === undefined ? undefined : { energyCost: { energyCost: p.cost } },
    };
  }
  const ctx: any = {
    api: {
      getItem: async () => ({
        Response: {
          sockets: { data: { sockets: opts.sockets.map((plugHash) => ({ plugHash })) } },
          reusablePlugs: { data: { plugs: {} } },
          instance: { data: { energy: opts.energy } },
        },
      }),
      insertSocketPlugFree: async (args: any) => {
        if (opts.failInsert?.(args.plug.plugItemHash))
          throw new Error('DestinyFailedPlugInsertionRules');
        inserts.push({ socketIndex: args.plug.socketIndex, plugItemHash: args.plug.plugItemHash });
        return { ErrorCode: 1 };
      },
    },
    inventory: {
      getOrBuild: async () => ({ items: [{ instanceId: 'item1', hash: ITEM_HASH }] }),
    },
    manifest: {
      getDefinition: async () => ({
        sockets: { socketEntries: opts.sockets.map(() => ({ reusablePlugSetHash: PLUG_SET })) },
      }),
      getDefinitions: async (table: string, hashes: number[]) =>
        table === 'DestinyPlugSetDefinition'
          ? {
              [PLUG_SET]: {
                reusablePlugItems: Object.keys(opts.plugs).map((h) => ({
                  plugItemHash: Number(h),
                })),
              },
            }
          : Object.fromEntries(hashes.map((h) => [String(h), defs[h] ?? null])),
    },
  };
  return { ctx, inserts };
}

const args = { itemId: 'item1', characterId: 'c1', membershipType: 3, membershipId: 'm1' };

test('set_plugs fills distinct sockets, preferring empty ones, and skips already-equipped', async () => {
  const { ctx, inserts } = fakeCtx({
    sockets: [201, EMPTY, EMPTY],
    plugs: {
      201: { name: 'Spark of Beacons' },
      202: { name: 'Spark of Shock' },
      203: { name: 'Spark of Ions' },
    },
  });
  const out: any = await toolMap.get('set_plugs')!.handler(ctx, {
    ...args,
    plugNames: ['Spark of Beacons', 'Spark of Shock', 'spark of ions'],
  });
  assert.equal(out.applied, 3);
  assert.equal(out.results[0].alreadyEquipped, true);
  assert.deepEqual(inserts, [
    { socketIndex: 1, plugItemHash: 202 },
    { socketIndex: 2, plugItemHash: 203 },
  ]);
});

test('set_plugs stops at the armor energy cap using its running tally', async () => {
  const { ctx, inserts } = fakeCtx({
    sockets: [EMPTY, EMPTY, EMPTY],
    plugs: { 301: { name: 'Grenade Kickstart', cost: 4 } },
    energy: { energyCapacity: 10, energyUsed: 0 },
  });
  const out: any = await toolMap.get('set_plugs')!.handler(ctx, {
    ...args,
    plugNames: ['Grenade Kickstart', 'Grenade Kickstart', 'Grenade Kickstart'],
  });
  assert.equal(out.applied, 2);
  assert.equal(inserts.length, 2);
  assert.match(out.results[2].reason, /Insufficient/);
});

test('insert_plug_by_name falls through to the next candidate when an insert fails', async () => {
  const { ctx, inserts } = fakeCtx({
    sockets: [EMPTY],
    plugs: { 401: { name: 'Arc Staff' }, 402: { name: 'Arc Staff' } }, // sunset duplicate + current
    failInsert: (h) => h === 401,
  });
  const out: any = await toolMap
    .get('insert_plug_by_name')!
    .handler(ctx, { ...args, plugName: 'Arc Staff' });
  assert.equal(out.plugItemHash, 402);
  assert.deepEqual(inserts, [{ socketIndex: 0, plugItemHash: 402 }]);
});
