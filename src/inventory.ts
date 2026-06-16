import * as fs from 'fs';
import * as path from 'path';
import { BungieConfig } from './types.js';
import { DestinyAPI } from './destiny-api.js';
import { BungieAuth } from './auth.js';
import { ManifestManager } from './manifest.js';

export interface InventoryRow {
  name: string;
  itemType: string;
  tier: string;
  /** vault | inventory | equipped | postmaster | vendor | unknown */
  location: string;
  /** Class name (Titan/Hunter/Warlock) when the item sits on a character. */
  character?: string;
  quantity: number;
  instanceId?: string;
  hash: number;
}

export interface InventorySnapshot {
  membershipType: number;
  membershipId: string;
  /** ms epoch when this snapshot was built. */
  fetchedAt: number;
  items: InventoryRow[];
}

export interface ArmorRow {
  name: string;
  slot: string;
  /** Armor 3.0 tier (1-5), or null if unknown. */
  tier: number | null;
  energy: number | null;
  character?: string;
  location: string;
  equipped: boolean;
  /** Resolved Armor 3.0 stats: Weapons/Health/Class/Grenade/Super/Melee. */
  stats: Record<string, number>;
  instanceId: string;
  hash: number;
}

export interface ArmorSnapshot {
  membershipType: number;
  membershipId: string;
  fetchedAt: number;
  armor: ArmorRow[];
}

const LOCATIONS: Record<number, string> = {
  0: 'unknown',
  1: 'inventory',
  2: 'vault',
  3: 'vendor',
  4: 'postmaster',
};
const CLASSES: Record<number, string> = { 0: 'Titan', 1: 'Hunter', 2: 'Warlock', 3: 'Unknown' };
const ARMOR_BUCKETS: Record<number, string> = {
  3448274439: 'helmet',
  3551918588: 'gauntlets',
  14239492: 'chest',
  20886954: 'legs',
  1585787867: 'class',
};

/**
 * Server-side inventory snapshots: flattened, name-resolved item lists cached
 * per membership. The authenticated account's primary membership is refreshed
 * on a timer (hourly by default) so reads are instant and never trigger a
 * 25k-line profile dump. Snapshots are persisted to disk so restarts are warm.
 */
export class InventoryCache {
  private snapshots = new Map<string, InventorySnapshot>();
  private armorSnapshots = new Map<string, ArmorSnapshot>();
  private dir: string;
  private intervalMs: number;
  private timer?: NodeJS.Timeout;
  private primary?: { membershipType: number; membershipId: string };

  constructor(
    private api: DestinyAPI,
    private manifest: ManifestManager,
    private auth: BungieAuth,
    config: BungieConfig
  ) {
    this.dir = path.join(config.dataDir!, 'inventory');
    const minutes = Number(process.env.D2_MCP_INVENTORY_REFRESH_MINUTES) || 60;
    this.intervalMs = Math.max(5, minutes) * 60_000;
    this.loadFromDisk();
  }

  get refreshMinutes(): number {
    return Math.round(this.intervalMs / 60_000);
  }

  private key(membershipType: number, membershipId: string): string {
    return `${membershipType}/${membershipId}`;
  }

  // -- Persistence --------------------------------------------------------

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.dir)) return;
      for (const file of fs.readdirSync(this.dir)) {
        if (!file.endsWith('.json')) continue;
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8'));
        const k = this.key(parsed.membershipType, parsed.membershipId);
        if (file.startsWith('armor-')) this.armorSnapshots.set(k, parsed as ArmorSnapshot);
        else this.snapshots.set(k, parsed as InventorySnapshot);
      }
    } catch {
      /* ignore corrupt cache */
    }
  }

  private saveToDisk(snap: InventorySnapshot): void {
    this.write(`${snap.membershipType}-${snap.membershipId}.json`, snap);
  }

  private saveArmorToDisk(snap: ArmorSnapshot): void {
    this.write(`armor-${snap.membershipType}-${snap.membershipId}.json`, snap);
  }

  private write(file: string, data: unknown): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, file), JSON.stringify(data));
    } catch {
      /* best-effort */
    }
  }

  // -- Reads --------------------------------------------------------------

  get(membershipType: number, membershipId: string): InventorySnapshot | undefined {
    return this.snapshots.get(this.key(membershipType, membershipId));
  }

  /** Return the cached snapshot, building one if missing or `force` is set. */
  async getOrBuild(
    membershipType: number,
    membershipId: string,
    force = false
  ): Promise<InventorySnapshot> {
    const cached = this.get(membershipType, membershipId);
    if (cached && !force) return cached;
    return this.refresh(membershipType, membershipId);
  }

  // -- Refresh ------------------------------------------------------------

  /** Fetch, flatten, and name-resolve a membership's inventory; cache it. */
  async refresh(membershipType: number, membershipId: string): Promise<InventorySnapshot> {
    const profile = await this.api.getInventoryProfile(membershipType, membershipId);
    const R = profile.Response ?? {};

    const classOf = (cid: string): string => {
      const c = R.characters?.data?.[cid];
      return c ? (CLASSES[c.classType] ?? cid) : cid;
    };

    const raw: Array<Omit<InventoryRow, 'name' | 'itemType' | 'tier'>> = [];
    for (const it of R.profileInventory?.data?.items ?? []) raw.push(toRaw(it));
    for (const [cid, inv] of Object.entries(R.characterInventories?.data ?? {})) {
      for (const it of (inv as any).items ?? []) raw.push(toRaw(it, classOf(cid)));
    }
    for (const [cid, eq] of Object.entries(R.characterEquipment?.data ?? {})) {
      for (const it of (eq as any).items ?? []) {
        raw.push({ ...toRaw(it, classOf(cid)), location: 'equipped' });
      }
    }

    const resolved = await this.manifest.resolveItems([...new Set(raw.map((r) => r.hash))]);
    const items: InventoryRow[] = raw.map((r) => {
      const def = resolved[String(r.hash)];
      return {
        ...r,
        name: def?.name ?? '',
        itemType: def?.itemType ?? '',
        tier: def?.tier ?? '',
      };
    });
    items.sort((a, b) => a.name.localeCompare(b.name));

    const snap: InventorySnapshot = {
      membershipType,
      membershipId,
      fetchedAt: Date.now(),
      items,
    };
    this.snapshots.set(this.key(membershipType, membershipId), snap);
    this.saveToDisk(snap);
    return snap;
  }

  // -- Armor snapshot (stats + tier + energy) -----------------------------

  getArmorSnapshot(membershipType: number, membershipId: string): ArmorSnapshot | undefined {
    return this.armorSnapshots.get(this.key(membershipType, membershipId));
  }

  async getOrBuildArmor(
    membershipType: number,
    membershipId: string,
    force = false
  ): Promise<ArmorSnapshot> {
    const cached = this.getArmorSnapshot(membershipType, membershipId);
    if (cached && !force) return cached;
    return this.refreshArmor(membershipType, membershipId);
  }

  /** Fetch armor with per-instance stats/tier/energy and name-resolve it; cache it. */
  async refreshArmor(membershipType: number, membershipId: string): Promise<ArmorSnapshot> {
    const profile = await this.api.getArmorProfile(membershipType, membershipId);
    const R = profile.Response ?? {};
    const instances: Record<string, any> = R.itemComponents?.instances?.data ?? {};
    const statsData: Record<string, any> = R.itemComponents?.stats?.data ?? {};
    const characters: Record<string, any> = R.characters?.data ?? {};

    type Raw = {
      hash: number;
      instanceId: string;
      character?: string;
      location: string;
      equipped: boolean;
    };
    const raw: Raw[] = [];
    const collect = (
      items: any[],
      character: string | undefined,
      location: string,
      equipped: boolean
    ) => {
      for (const it of items ?? []) {
        if (it.itemInstanceId)
          raw.push({
            hash: it.itemHash,
            instanceId: it.itemInstanceId,
            character,
            location,
            equipped,
          });
      }
    };
    collect(R.profileInventory?.data?.items, undefined, 'vault', false);
    for (const [cid, inv] of Object.entries<any>(R.characterInventories?.data ?? {})) {
      collect(inv.items, CLASSES[characters[cid]?.classType] ?? cid, 'inventory', false);
    }
    for (const [cid, eq] of Object.entries<any>(R.characterEquipment?.data ?? {})) {
      collect(eq.items, CLASSES[characters[cid]?.classType] ?? cid, 'equipped', true);
    }

    const itemDefs = await this.manifest.getDefinitions(
      'DestinyInventoryItemDefinition',
      raw.map((r) => r.hash)
    );
    const statHashes = new Set<number>();
    for (const s of Object.values(statsData))
      for (const h of Object.keys(s.stats ?? {})) statHashes.add(Number(h));
    const statDefs = await this.manifest.getDefinitions('DestinyStatDefinition', [...statHashes]);
    const statName = (h: string) => statDefs[h]?.displayProperties?.name ?? h;

    const armor: ArmorRow[] = raw
      .map((r): ArmorRow | null => {
        const def = itemDefs[String(r.hash)];
        const slot = ARMOR_BUCKETS[def?.inventory?.bucketTypeHash];
        if (!slot) return null;
        const inst = instances[r.instanceId] ?? {};
        const stats: Record<string, number> = {};
        for (const [h, v] of Object.entries<any>(statsData[r.instanceId]?.stats ?? {})) {
          stats[statName(h)] = v.value;
        }
        return {
          name: def?.displayProperties?.name ?? '',
          slot,
          tier: inst.gearTier ?? null,
          energy: inst.energy?.energyCapacity ?? null,
          character: r.character,
          location: r.location,
          equipped: r.equipped,
          stats,
          instanceId: r.instanceId,
          hash: r.hash,
        };
      })
      .filter((r): r is ArmorRow => r !== null);
    armor.sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0) || a.name.localeCompare(b.name));

    const snap: ArmorSnapshot = { membershipType, membershipId, fetchedAt: Date.now(), armor };
    this.armorSnapshots.set(this.key(membershipType, membershipId), snap);
    this.saveArmorToDisk(snap);
    return snap;
  }

  /** Resolve (and cache) the authenticated account's primary Destiny membership. */
  async resolvePrimary(): Promise<{ membershipType: number; membershipId: string } | undefined> {
    if (this.primary) return this.primary;
    const data = await this.api.getMembershipsForCurrentUser();
    const memberships = data.Response?.destinyMemberships ?? [];
    if (memberships.length === 0) return undefined;
    const primaryId = data.Response?.primaryMembershipId;
    const pick = memberships.find((m: any) => m.membershipId === primaryId) ?? memberships[0];
    this.primary = { membershipType: pick.membershipType, membershipId: pick.membershipId };
    return this.primary;
  }

  async refreshPrimary(): Promise<InventorySnapshot | undefined> {
    const p = await this.resolvePrimary();
    return p ? this.refresh(p.membershipType, p.membershipId) : undefined;
  }

  // -- Scheduler ----------------------------------------------------------

  /** Start the periodic refresh of the authenticated user's inventory. */
  startAutoRefresh(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    console.error(
      `[inventory] auto-refresh every ${this.refreshMinutes} min (runs once authenticated).`
    );
  }

  private async tick(): Promise<void> {
    if (!this.auth.isAuthenticated()) return; // quietly wait for `d2-mcp auth`
    try {
      const p = await this.resolvePrimary();
      if (!p) return;
      const snap = await this.refresh(p.membershipType, p.membershipId);
      const armor = await this.refreshArmor(p.membershipType, p.membershipId);
      console.error(
        `[inventory] refreshed ${snap.items.length} items, ${armor.armor.length} armor.`
      );
    } catch (error) {
      console.error(
        '[inventory] refresh failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function toRaw(it: any, character?: string): Omit<InventoryRow, 'name' | 'itemType' | 'tier'> {
  return {
    hash: it.itemHash,
    quantity: it.quantity ?? 1,
    location: LOCATIONS[it.location] ?? 'other',
    character,
    instanceId: it.itemInstanceId,
  };
}
