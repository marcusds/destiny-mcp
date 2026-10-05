import * as fs from 'fs';
import * as path from 'path';
import { BungieConfig } from './types.js';
import { DestinyAPI } from './destiny-api.js';
import { BungieAuth } from './auth.js';
import { ManifestManager } from './manifest.js';
import { InventoryCache } from './inventory.js';

/**
 * Checklists whose entries we try to locate, and the triumphs whose per-area
 * objective counters ("Stacks urns found") reveal where an entry was picked up.
 */
const TRACKED: Array<{ checklist: string; records: RegExp; area: RegExp }> = [
  { checklist: 'Kepler Urns', records: /^Urn Collection:/, area: /^(.+) urns found$/i },
  {
    checklist: 'Kepler Ability Chests',
    records: /^Secret Treasure:/,
    area: /^(.+) chests opened$/i,
  },
];

export interface EntryLocation {
  checklist: string;
  entry: string;
  /** Area where it was found, when exactly one area counter moved with it. */
  area?: string;
  /** Possible areas when several counters moved in the same observation. */
  candidates?: string[];
  foundAt: string;
}

interface TrackerState {
  /** checklist hash -> entry hashes found at the last observation */
  found: Record<string, string[]>;
  /** checklist hash -> area -> objective progress at the last observation */
  areas: Record<string, Record<string, number>>;
  /** entry hash -> where it was found */
  locations: Record<string, EntryLocation>;
}

/**
 * Learns where checklist collectibles (Kepler urns/chests) are found by
 * diffing successive observations: an entry that flips to found at the same
 * time as exactly one area's triumph counter rises was found in that area.
 * Polls frequently while the player is in an activity so pickups stay
 * separable; results persist to disk.
 */
export class ChecklistTracker {
  private readonly file: string;
  private state: TrackerState = { found: {}, areas: {}, locations: {} };
  private timer?: NodeJS.Timeout;
  private observing: Promise<void> | null = null;

  constructor(
    private api: DestinyAPI,
    private manifest: ManifestManager,
    private auth: BungieAuth,
    private inventory: InventoryCache,
    config: BungieConfig
  ) {
    this.file = path.join(config.dataDir!, 'checklist-locations.json');
    try {
      this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf-8')) };
    } catch {
      /* first run or unreadable: start fresh */
    }
  }

  /** Learned location for a checklist entry, if any. */
  locationOf(entryHash: number | string): EntryLocation | undefined {
    return this.state.locations[String(entryHash)];
  }

  /** Poll on an interval; only does the full observation while the player is in an activity. */
  start(
    intervalMs = Math.max(30, Number(process.env.D2_MCP_CHECKLIST_POLL_SECONDS) || 120) * 1000
  ) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      if (!this.auth.isAuthenticated()) return;
      const p = await this.inventory.resolvePrimary();
      if (!p) return;
      const acts = await this.api.getProfile(p.membershipType, p.membershipId, [204]);
      const playing = Object.values<any>(acts.Response?.characterActivities?.data ?? {}).some(
        (c) => c.currentActivityHash
      );
      if (playing) await this.observe();
    } catch (error) {
      console.error(
        '[checklists] poll failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /** Read checklists + triumph counters once and attribute new finds. Single-flight. */
  observe(): Promise<void> {
    this.observing ??= this.doObserve().finally(() => {
      this.observing = null;
    });
    return this.observing;
  }

  private async doObserve(): Promise<void> {
    const p = await this.inventory.resolvePrimary();
    if (!p) return;
    const [profile, checklists, records] = await Promise.all([
      this.api.getProfile(p.membershipType, p.membershipId, [104, 900]),
      this.manifest.getAll('DestinyChecklistDefinition'),
      this.manifest.getAll('DestinyRecordDefinition'),
    ]);
    const R = profile.Response ?? {};
    const checklistState: Record<string, Record<string, boolean>> = R.profileProgression?.data
      ?.checklists ?? {};
    const recordState: Record<string, any> = R.profileRecords?.data?.records ?? {};

    for (const t of TRACKED) {
      const def = checklists.find((c) => c.displayProperties?.name === t.checklist);
      if (!def) continue;
      const key = String(def.hash);
      const states = checklistState[key] ?? {};
      const found = (def.entries ?? [])
        .filter((e: any) => states[String(e.hash)])
        .map((e: any) => String(e.hash));

      const areas = await this.areaCounts(records, recordState, t);
      const prevFound = this.state.found[key];
      const prevAreas = this.state.areas[key];
      if (prevFound && prevAreas) {
        const newly = found.filter((h: string) => !prevFound.includes(h));
        const rose = Object.keys(areas).filter((a) => areas[a] > (prevAreas[a] ?? 0));
        const now = new Date().toISOString();
        for (const h of newly) {
          const entry = def.entries.find((e: any) => String(e.hash) === h);
          this.state.locations[h] = {
            checklist: t.checklist,
            entry: entry?.displayProperties?.name ?? h,
            ...(rose.length === 1
              ? { area: rose[0] }
              : rose.length > 1
                ? { candidates: rose }
                : {}),
            foundAt: now,
          };
        }
      }
      this.state.found[key] = found;
      this.state.areas[key] = areas;
    }
    this.save();
  }

  /** area name -> current progress, from the tracked triumphs' objectives. */
  private async areaCounts(
    records: any[],
    recordState: Record<string, any>,
    t: (typeof TRACKED)[number]
  ): Promise<Record<string, number>> {
    const defs = records.filter((r) => t.records.test(r.displayProperties?.name ?? ''));
    const objectiveHashes = defs.flatMap((r) => r.objectiveHashes ?? []);
    const objectiveDefs = await this.manifest.getDefinitions(
      'DestinyObjectiveDefinition',
      objectiveHashes
    );
    const out: Record<string, number> = {};
    for (const r of defs) {
      for (const o of recordState[String(r.hash)]?.objectives ?? []) {
        const desc: string = objectiveDefs[String(o.objectiveHash)]?.progressDescription ?? '';
        const area = desc.match(t.area)?.[1];
        if (area) out[area] = o.progress ?? 0;
      }
    }
    return out;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch {
      /* best-effort */
    }
  }
}
