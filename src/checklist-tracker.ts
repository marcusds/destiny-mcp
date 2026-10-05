import * as fs from 'fs';
import * as path from 'path';
import { BungieConfig } from './types.js';
import { DestinyAPI } from './destiny-api.js';
import { BungieAuth } from './auth.js';
import { ManifestManager } from './manifest.js';
import { InventoryCache } from './inventory.js';

/**
 * Checklists that also have triumphs with per-area objective counters
 * ("Stacks urns found"), which pin a find to a sub-area. Every other checklist
 * is still tracked, located by the activity the player was in.
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
  /** Activity (and destination) the player was in when it was found. */
  activity?: string;
  foundAt: string;
}

/** How long after leaving an activity a late-arriving find is still attributed to it. */
const ACTIVITY_GRACE_MS = 10 * 60_000;

interface TrackerState {
  /** checklist hash -> entry hashes found at the last observation */
  found: Record<string, string[]>;
  /** checklist hash -> area -> objective progress at the last observation */
  areas: Record<string, Record<string, number>>;
  /** entry hash -> where it was found */
  locations: Record<string, EntryLocation>;
}

/**
 * Learns where checklist collectibles are found by diffing successive
 * observations. Every newly found entry records the activity the player was in;
 * for checklists in TRACKED, an entry that flips at the same time as exactly one
 * area's triumph counter rises is also pinned to that area.
 * Polls frequently while the player is in an activity so pickups stay
 * separable; results persist to disk.
 */
export class ChecklistTracker {
  private readonly file: string;
  private state: TrackerState = { found: {}, areas: {}, locations: {} };
  private timer?: NodeJS.Timeout;
  private observing: Promise<any> | null = null;
  /** Most recent activity seen while polling, for finds Bungie reports late. */
  private lastActivity?: { name: string; at: number };

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
      const playing = await this.noteActivity(acts.Response);
      // Keep observing briefly after leaving: Bungie can report a pickup late.
      const recent = this.lastActivity && Date.now() - this.lastActivity.at < ACTIVITY_GRACE_MS;
      if (playing || recent) await this.observe();
    } catch (error) {
      console.error(
        '[checklists] poll failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Read checklists + triumph counters once and attribute new finds. Single-flight.
   * Resolves to the profile response it used (components 104 + 900), so callers can
   * show exactly the data the tracker saw (separate reads can disagree mid-update).
   */
  observe(): Promise<any> {
    this.observing ??= this.doObserve().finally(() => {
      this.observing = null;
    });
    return this.observing;
  }

  private async doObserve(): Promise<any> {
    const p = await this.inventory.resolvePrimary();
    if (!p) return undefined;
    const [profile, checklists, records] = await Promise.all([
      this.api.getProfile(p.membershipType, p.membershipId, [104, 202, 204, 900]),
      this.manifest.getAll('DestinyChecklistDefinition'),
      this.manifest.getAll('DestinyRecordDefinition'),
    ]);
    const R = profile.Response ?? {};
    const checklistState: Record<string, Record<string, boolean>> = R.profileProgression?.data
      ?.checklists ?? {};
    // Character-scoped checklists (Lost Sectors, Jade Rabbits...): an entry counts
    // as found once any character has it, matching how get_checklist reports them.
    const charChecklists: Array<Record<string, Record<string, boolean>>> = Object.values<any>(
      R.characterProgressions?.data ?? {}
    ).map((c) => c.checklists ?? {});
    const recordState: Record<string, any> = R.profileRecords?.data?.records ?? {};
    await this.noteActivity(R);
    const activity =
      this.lastActivity && Date.now() - this.lastActivity.at < ACTIVITY_GRACE_MS
        ? this.lastActivity.name
        : undefined;
    const now = new Date().toISOString();

    for (const def of checklists) {
      const key = String(def.hash);
      const sources = [checklistState[key], ...charChecklists.map((c) => c[key])].filter(Boolean);
      if (!sources.length) continue; // not on this profile
      const states: Record<string, boolean> = {};
      for (const src of sources) for (const [h, v] of Object.entries(src)) if (v) states[h] = true;
      const found = (def.entries ?? [])
        .filter((e: any) => states[String(e.hash)])
        .map((e: any) => String(e.hash));
      const t = TRACKED.find((x) => x.checklist === def.displayProperties?.name);
      const areas = t ? await this.areaCounts(records, recordState, t) : undefined;

      const prevFound = this.state.found[key];
      if (prevFound) {
        const prevAreas = this.state.areas[key] ?? {};
        const rose = areas ? Object.keys(areas).filter((a) => areas[a] > (prevAreas[a] ?? 0)) : [];
        for (const h of found.filter((x: string) => !prevFound.includes(x))) {
          const entry = def.entries.find((e: any) => String(e.hash) === h);
          this.state.locations[h] = {
            checklist: def.displayProperties?.name ?? key,
            entry: entry?.displayProperties?.name ?? h,
            ...(rose.length === 1
              ? { area: rose[0] }
              : rose.length > 1
                ? { candidates: rose }
                : {}),
            ...(activity && { activity }),
            foundAt: now,
          };
        }
      }
      this.state.found[key] = found;
      if (areas) this.state.areas[key] = areas;
    }
    this.save();
    return profile;
  }

  /** Remember the activity a character is in; returns whether anyone is playing. */
  private async noteActivity(R: any): Promise<boolean> {
    const current = Object.values<any>(R?.characterActivities?.data ?? {})
      .filter((c) => c.currentActivityHash)
      .sort((x, y) => Date.parse(y.dateActivityStarted) - Date.parse(x.dateActivityStarted))[0];
    if (!current) return false;
    const def = await this.manifest.getDefinition(
      'DestinyActivityDefinition',
      current.currentActivityHash
    );
    const dest = def?.destinationHash
      ? await this.manifest.getDefinition('DestinyDestinationDefinition', def.destinationHash)
      : undefined;
    const name: string = def?.displayProperties?.name || String(current.currentActivityHash);
    const destName: string | undefined = dest?.displayProperties?.name;
    this.lastActivity = {
      name: destName && destName !== name ? `${name} (${destName})` : name,
      at: Date.now(),
    };
    return true;
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
