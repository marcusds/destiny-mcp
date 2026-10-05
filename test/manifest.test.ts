import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ManifestManager, versionCheckMs } from '../src/manifest.js';
import { tempDir } from './helpers.js';

const toSigned = (h: number) => (h > 0x7fffffff ? h - 0x100000000 : h);

/** Write a minimal world.content for `version` with the given item definitions. */
function writeManifest(dataDir: string, version: string, items: Record<number, string>) {
  const file = path.join(dataDir, 'manifest', version, 'world.content');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE DestinyInventoryItemDefinition (id INTEGER PRIMARY KEY, json TEXT)');
  const insert = db.prepare('INSERT INTO DestinyInventoryItemDefinition VALUES (?, ?)');
  for (const [hash, name] of Object.entries(items)) {
    insert.run(
      toSigned(Number(hash)),
      JSON.stringify({ hash: Number(hash), displayProperties: { name } })
    );
  }
  db.close();
}

/** ManifestManager over a fake API whose reported version can be changed. */
function setup(items: Record<number, string>) {
  const dataDir = tempDir();
  writeManifest(dataDir, 'v1', items);
  const state = { version: 'v1', calls: 0 };
  const api: any = {
    getManifest: async () => {
      state.calls++;
      return { Response: { version: state.version, mobileWorldContentPaths: { en: '/unused' } } };
    },
  };
  const manifest = new ManifestManager(api, { apiKey: '', baseUrl: '', dataDir });
  return { manifest, state, dataDir };
}

const GJALLARHORN = 1363886209;
const HIGH_HASH = 3628991658; // > 2^31: stored as a negative signed id

test('resolves hashes (including ones stored as negative ids)', async () => {
  const { manifest } = setup({ [GJALLARHORN]: 'Gjallarhorn', [HIGH_HASH]: 'Arc Staff' });
  assert.equal(
    (await manifest.getDefinition('DestinyInventoryItemDefinition', HIGH_HASH)).displayProperties
      .name,
    'Arc Staff'
  );
  const defs = await manifest.getDefinitions('DestinyInventoryItemDefinition', [GJALLARHORN, 1]);
  assert.equal(defs[GJALLARHORN].displayProperties.name, 'Gjallarhorn');
  assert.equal(defs[1], null);
});

test('checks the version once, even for concurrent and repeated lookups', async () => {
  const { manifest, state } = setup({ [GJALLARHORN]: 'Gjallarhorn' });
  await Promise.all(
    Array.from({ length: 5 }, () =>
      manifest.getDefinition('DestinyInventoryItemDefinition', GJALLARHORN)
    )
  );
  for (let i = 0; i < 20; i++)
    await manifest.getDefinition('DestinyInventoryItemDefinition', GJALLARHORN);
  assert.equal(state.calls, 1);
});

test('a lookup miss re-checks the version (rate-limited) and picks up a new manifest', async () => {
  const NEW_ITEM = 42;
  const { manifest, state, dataDir } = setup({ [GJALLARHORN]: 'Gjallarhorn' });
  await manifest.getDefinition('DestinyInventoryItemDefinition', GJALLARHORN);

  // Within the cooldown a miss does not hit Bungie.
  assert.equal(await manifest.getDefinition('DestinyInventoryItemDefinition', NEW_ITEM), null);
  assert.equal(state.calls, 1);

  // After the cooldown, a patch has shipped a new version containing the item.
  writeManifest(dataDir, 'v2', { [NEW_ITEM]: 'New Exotic' });
  state.version = 'v2';
  (manifest as any).lastChecked -= 6 * 60_000;
  const def = await manifest.getDefinition('DestinyInventoryItemDefinition', NEW_ITEM);
  assert.equal(def?.displayProperties.name, 'New Exotic');
  assert.equal(manifest.getVersion(), 'v2');
  assert.equal(fs.existsSync(path.join(dataDir, 'manifest', 'v1')), false, 'old version pruned');
});

test('name search is case-insensitive and respects the limit', async () => {
  const { manifest } = setup({
    1: 'Gjallarhorn',
    2: 'Gjallarhorn Catalyst',
    3: 'Arc Staff',
    4: 'GJALLARHORN Ornament',
  });
  const names = (await manifest.searchByName('DestinyInventoryItemDefinition', 'gjallar')).map(
    (d) => d.displayProperties.name
  );
  assert.deepEqual(names.sort(), ['GJALLARHORN Ornament', 'Gjallarhorn', 'Gjallarhorn Catalyst']);
  assert.equal(
    (await manifest.searchByName('DestinyInventoryItemDefinition', 'gjallar', 1)).length,
    1
  );
});

test('rejects unknown tables instead of interpolating them into SQL', async () => {
  const { manifest } = setup({});
  await assert.rejects(manifest.getDefinition('Nope; DROP TABLE x', 1), /Unknown manifest table/);
});

test('version checks run every 3h on Pacific Tuesday, daily otherwise', () => {
  const HOUR = 3_600_000;
  // 2026-10-06 is a Tuesday. Pacific is UTC-7 (PDT) on that date.
  assert.equal(versionCheckMs(new Date('2026-10-06T06:59:00Z')), 24 * HOUR); // Mon 23:59 PT
  assert.equal(versionCheckMs(new Date('2026-10-06T07:01:00Z')), 3 * HOUR); // Tue 00:01 PT
  assert.equal(versionCheckMs(new Date('2026-10-07T06:59:00Z')), 3 * HOUR); // Tue 23:59 PT
  assert.equal(versionCheckMs(new Date('2026-10-07T07:01:00Z')), 24 * HOUR); // Wed 00:01 PT
});
