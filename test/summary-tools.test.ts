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
