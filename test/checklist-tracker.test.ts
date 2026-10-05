import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChecklistTracker } from '../src/checklist-tracker.js';
import { tempDir } from './helpers.js';

const URNS = 50;
const checklists = [
  {
    hash: URNS,
    displayProperties: { name: 'Kepler Urns' },
    entries: [1, 2, 3].map((h) => ({ hash: h, displayProperties: { name: `Kepler Urn #${h}` } })),
  },
];
const records = [
  {
    hash: 7,
    displayProperties: { name: "Urn Collection: Exile's Accord" },
    objectiveHashes: [71, 72],
  },
  { hash: 8, displayProperties: { name: 'Something Else' }, objectiveHashes: [81] },
];
const objectives: Record<number, any> = {
  71: { progressDescription: 'Curtilage Divide urns found' },
  72: { progressDescription: "Augur's Bethel urns found" },
  81: { progressDescription: 'Augur urns found' },
};

/** Tracker over a fake account whose checklist/counters the test mutates. */
function setup(dataDir = tempDir()) {
  const world = { found: { 1: true } as Record<number, boolean>, curtilage: 1, augur: 0 };
  const api: any = {
    getProfile: async () => ({
      Response: {
        profileProgression: { data: { checklists: { [URNS]: { ...world.found } } } },
        profileRecords: {
          data: {
            records: {
              7: {
                objectives: [
                  { objectiveHash: 71, progress: world.curtilage },
                  { objectiveHash: 72, progress: world.augur },
                ],
              },
              8: { objectives: [{ objectiveHash: 81, progress: 99 }] },
            },
          },
        },
      },
    }),
  };
  const manifest: any = {
    getAll: async (t: string) => (t === 'DestinyChecklistDefinition' ? checklists : records),
    getDefinitions: async (_t: string, hashes: number[]) =>
      Object.fromEntries(hashes.map((h) => [String(h), objectives[h]])),
  };
  const inventory: any = { resolvePrimary: async () => ({ membershipType: 3, membershipId: 'm' }) };
  const tracker = new ChecklistTracker(api, manifest, {} as any, inventory, {
    apiKey: '',
    baseUrl: '',
    dataDir,
  });
  return { tracker, world, dataDir };
}

test('attributes a find to the one area whose counter rose', async () => {
  const { tracker, world } = setup();
  await tracker.observe(); // baseline: nothing attributed
  assert.equal(tracker.locationOf(1), undefined);

  world.found[2] = true;
  world.augur = 1;
  await tracker.observe();
  assert.equal(tracker.locationOf(2)?.area, "Augur's Bethel");
  assert.equal(tracker.locationOf(2)?.entry, 'Kepler Urn #2');
});

test('records candidates when several areas rose together, and persists', async () => {
  const { tracker, world, dataDir } = setup();
  await tracker.observe();
  world.found[2] = true;
  world.found[3] = true;
  world.augur = 1;
  world.curtilage = 2;
  await tracker.observe();
  assert.deepEqual(tracker.locationOf(3)?.candidates?.sort(), [
    "Augur's Bethel",
    'Curtilage Divide',
  ]);
  assert.equal(tracker.locationOf(3)?.area, undefined);

  const reloaded = setup(dataDir).tracker;
  assert.deepEqual(reloaded.locationOf(2)?.candidates?.length, 2);
});

test('any checklist records the activity a find happened in', async () => {
  const dataDir = tempDir();
  const tapes = {
    hash: 60,
    displayProperties: { name: 'Renegades Tapes' },
    entries: [{ hash: 9, displayProperties: { name: 'Renegades Tape #1' } }],
  };
  let found = false;
  const api: any = {
    getProfile: async () => ({
      Response: {
        profileProgression: { data: { checklists: { 60: { 9: found } } } },
        profileRecords: { data: { records: {} } },
        characterActivities: {
          data: { c1: { currentActivityHash: 500, dateActivityStarted: '2026-10-05T00:00:00Z' } },
        },
      },
    }),
  };
  const manifest: any = {
    getAll: async (t: string) => (t === 'DestinyChecklistDefinition' ? [tapes] : []),
    getDefinitions: async () => ({}),
    getDefinition: async (t: string) =>
      t === 'DestinyActivityDefinition'
        ? { displayProperties: { name: 'Lawless Frontier' }, destinationHash: 1 }
        : { displayProperties: { name: 'Tharsis' } },
  };
  const inventory: any = { resolvePrimary: async () => ({ membershipType: 3, membershipId: 'm' }) };
  const tracker = new ChecklistTracker(api, manifest, {} as any, inventory, {
    apiKey: '',
    baseUrl: '',
    dataDir,
  });
  await tracker.observe();
  found = true;
  await tracker.observe();
  assert.deepEqual(
    { ...tracker.locationOf(9), foundAt: undefined },
    {
      checklist: 'Renegades Tapes',
      entry: 'Renegades Tape #1',
      activity: 'Lawless Frontier (Tharsis)',
      foundAt: undefined,
    }
  );
});
