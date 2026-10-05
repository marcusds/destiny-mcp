import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolMap } from '../src/tools/index.js';

const primary = { membershipType: 3, membershipId: 'm1' };
const run = (name: string, ctx: any, args: Record<string, unknown>) =>
  toolMap.get(name)!.handler(ctx, args) as Promise<any>;

test('get_characters names classes, stats and titles, most recent first', async () => {
  const ctx: any = {
    inventory: { resolvePrimary: async () => primary },
    api: {
      getProfile: async () => ({
        Response: {
          characters: {
            data: {
              old: {
                characterId: 'old',
                classType: 2,
                light: 10,
                stats: {},
                dateLastPlayed: '2025-01-01T00:00:00Z',
                minutesPlayedTotal: '90',
              },
              hunter: {
                characterId: 'hunter',
                classType: 1,
                light: 512,
                stats: { 7: 64 },
                genderHash: 11,
                titleRecordHash: 99,
                dateLastPlayed: '2026-10-05T00:00:00Z',
                minutesPlayedTotal: '221130',
              },
            },
          },
        },
      }),
    },
    manifest: {
      getDefinitions: async (table: string) =>
        table === 'DestinyStatDefinition'
          ? { 7: { displayProperties: { name: 'Weapons' } } }
          : { 99: { titleInfo: { titlesByGenderHash: { 11: 'ETERNAL' } } } },
    },
  };
  const out = await run('get_characters', ctx, {});
  assert.deepEqual(out.characters[0], {
    characterId: 'hunter',
    class: 'Hunter',
    power: 512,
    stats: { Weapons: 64 },
    title: 'ETERNAL',
    lastPlayed: '2026-10-05T00:00:00Z',
    hoursPlayed: 3686,
  });
  assert.equal(out.characters[1].class, 'Warlock');
});

test('get_activity_history summarizes with activity and mode names', async () => {
  const activity = {
    period: '2026-09-30T05:17:34Z',
    activityDetails: { directorActivityHash: 5, referenceId: 5, instanceId: 'i1', mode: 6 },
    values: {
      kills: { basic: { value: 112 } },
      deaths: { basic: { value: 2 } },
      assists: { basic: { value: 44 } },
      completed: { basic: { value: 0 } },
      playerCount: { basic: { value: 2 } },
      activityDurationSeconds: { basic: { value: 2051, displayValue: '34m 11s' } },
    },
  };
  const ctx: any = {
    inventory: { resolvePrimary: async () => primary },
    api: { getActivityHistory: async () => ({ Response: { activities: [activity] } }) },
    manifest: {
      getDefinitions: async () => ({
        5: { displayProperties: { name: 'Nessus, Unstable Centaur' } },
      }),
      getAll: async () => [{ modeType: 6, displayProperties: { name: 'Explore' } }],
    },
  };
  assert.deepEqual(await run('get_activity_history', ctx, { characterId: 'c1' }), [
    {
      instanceId: 'i1',
      date: '2026-09-30T05:17:34Z',
      activity: 'Nessus, Unstable Centaur',
      mode: 'Explore',
      completed: false,
      duration: '34m 11s',
      kills: 112,
      deaths: 2,
      assists: 44,
      players: 2,
    },
  ]);
});

test('get_character_loadouts names loadouts and their items', async () => {
  const SENTINEL = 2166136261;
  const ctx: any = {
    inventory: {
      resolvePrimary: async () => primary,
      getOrBuild: async () => ({ items: [{ instanceId: 'a', name: 'Gjallarhorn' }] }),
    },
    api: {
      getCharacterLoadouts: async () => ({
        Response: {
          characterLoadouts: {
            data: {
              c1: {
                loadouts: [
                  { nameHash: 1, items: [{ itemInstanceId: 'a' }, { itemInstanceId: 'gone' }] },
                  { nameHash: 2, items: [{ itemInstanceId: '0' }] },
                  { nameHash: SENTINEL, items: [] },
                ],
              },
            },
          },
        },
      }),
    },
    manifest: { getAll: async () => [{ hash: 1, name: 'Support' }] },
  };
  const out = await run('get_character_loadouts', ctx, { characterId: 'c1' });
  assert.deepEqual(out.slots, [
    { index: 0, status: 'used', name: 'Support', items: ['Gjallarhorn', '(missing gone)'] },
    { index: 1, status: 'free' },
    { index: 2, status: 'locked' },
  ]);
  assert.deepEqual([out.used, out.free, out.locked], [1, [1], 1]);
});

test('get_title_progress treats finished interval triumphs as complete and reports the seal counter', async () => {
  const seal = {
    hash: 1,
    completionRecordHash: 900,
    displayProperties: { name: 'The Edge of Fate' },
    children: { records: [{ recordHash: 10 }, { recordHash: 11 }, { recordHash: 12 }] },
  };
  const recordDefs: Record<number, any> = {
    900: { titleInfo: { hasTitle: true, titlesByGender: { Male: 'Fated Weapon' } } },
    10: { displayProperties: { name: 'Matterspark' } },
    11: { displayProperties: { name: 'Stitchripper' } },
    12: { displayProperties: { name: 'Done Thing' } },
  };
  const ctx: any = {
    inventory: { resolvePrimary: async () => primary },
    manifest: {
      getAll: async () => [seal, { hash: 2, displayProperties: { name: 'Other' } }],
      getDefinitions: async (table: string, hashes: number[]) =>
        Object.fromEntries(
          hashes.map((h) => [
            String(h),
            table === 'DestinyRecordDefinition' ? recordDefs[h] : { progressDescription: 'Bosses' },
          ])
        ),
    },
    api: {
      getProfile: async () => ({
        Response: {
          profileRecords: {
            data: {
              records: {
                900: {
                  state: 4,
                  objectives: [{ objectiveHash: 5, progress: 2, completionValue: 2 }],
                },
                // state 7 still has ObjectiveNotCompleted set, but all intervals are done.
                10: {
                  state: 7,
                  intervalObjectives: [
                    { objectiveHash: 1, progress: 1, completionValue: 1, complete: true },
                  ],
                },
                11: {
                  state: 4,
                  objectives: [
                    { objectiveHash: 2, progress: 1, completionValue: 3, complete: false },
                  ],
                },
                12: { state: 67, objectives: [] },
              },
            },
          },
        },
      }),
    },
  };
  const out = await run('get_title_progress', ctx, { title: 'fated weapon' });
  assert.equal(out.title, 'Fated Weapon');
  assert.equal(out.completed, 2);
  assert.equal(out.sealProgress, '2/2');
  assert.deepEqual(
    out.incomplete.map((t: any) => [t.name, t.percent, t.objectives[0].progress]),
    [['Stitchripper', 33, '1/3']]
  );
});

test('get_checklist lists missing entries, merging character-scoped progress', async () => {
  const checklist = {
    hash: 77,
    displayProperties: { name: 'Kepler Urns' },
    entries: [1, 2, 3].map((h) => ({ hash: h, displayProperties: { name: `Kepler Urn #${h}` } })),
  };
  const ctx: any = {
    inventory: { resolvePrimary: async () => primary },
    manifest: {
      getAll: async () => [
        { hash: 5, displayProperties: { name: 'Cat Statues' }, entries: [] },
        checklist,
      ],
    },
    api: {
      getProfile: async () => ({
        Response: {
          profileProgression: { data: { checklists: { 77: { 1: true, 2: false, 3: false } } } },
          characterProgressions: { data: { c1: { checklists: { 77: { 3: true } } } } },
        },
      }),
    },
  };
  assert.deepEqual(await run('get_checklist', ctx, { name: 'urns' }), {
    checklist: 'Kepler Urns',
    found: 2,
    total: 3,
    missing: ['Kepler Urn #2'],
  });
  assert.deepEqual(
    (await run('get_checklist', ctx, {})).map((c: any) => c.name),
    ['Cat Statues', 'Kepler Urns']
  );
});

test('get_checklist shows the same read the tracker used for your own account', async () => {
  const checklist = {
    hash: 77,
    displayProperties: { name: 'Kepler Urns' },
    entries: [{ hash: 1, displayProperties: { name: 'Kepler Urn #1' } }],
  };
  const read = (found: boolean) => ({
    Response: { profileProgression: { data: { checklists: { 77: { 1: found } } } } },
  });
  const ctx: any = {
    inventory: { resolvePrimary: async () => primary },
    manifest: { getAll: async () => [checklist] },
    checklists: { observe: async () => read(false), locationOf: () => undefined },
    api: { getProfile: async () => read(true) }, // a second, newer read would disagree
  };
  assert.equal((await run('get_checklist', ctx, { name: 'urns' })).found, 0);
});

test('get_reputation reports rank names and reputation needed for a target rank', async () => {
  const ctx: any = {
    inventory: { resolvePrimary: async () => primary },
    api: {
      getProfile: async () => ({
        Response: {
          characters: {
            data: { c1: { characterId: 'c1', dateLastPlayed: '2026-10-05T00:00:00Z' } },
          },
          characterProgressions: {
            data: {
              c1: {
                factions: {
                  1: {
                    progressionHash: 639915560,
                    level: 1,
                    progressToNextLevel: 260,
                    nextLevelAt: 2000,
                    currentProgress: 1260,
                  },
                  2: {
                    progressionHash: 77,
                    level: 4,
                    progressToNextLevel: 220,
                    nextLevelAt: 2000,
                    currentProgress: 10220,
                  },
                },
              },
            },
          },
        },
      }),
    },
    manifest: {
      getDefinitions: async () => ({
        639915560: {
          displayProperties: { name: 'The Pikers' },
          steps: [1000, 2000, 3000, 4000, 2000].map((t, i) => ({
            progressTotal: t,
            stepName: ['Nobody', 'Acquaintance', 'Friend', 'Confidant', 'Family'][i],
          })),
        },
        77: {
          displayProperties: { name: 'Tharsis Reformation' },
          steps: [{ progressTotal: 2000, stepName: 'X' }],
        },
      }),
    },
  };
  const out = await run('get_reputation', ctx, { targetRank: 5 });
  assert.deepEqual(out.reputations, [
    {
      name: 'Tharsis Reformation',
      rank: 5,
      rankName: 'X',
      progress: '220/2000',
      total: 10220,
      toRank5: 0,
    },
    // Rank 2 -> 5: finish Acquaintance (1740) + Friend (3000) + Confidant (4000)
    {
      name: 'The Pikers',
      rank: 2,
      rankName: 'Acquaintance',
      progress: '260/2000',
      total: 1260,
      toRank5: 8740,
    },
  ]);
});
