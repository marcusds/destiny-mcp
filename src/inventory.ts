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
  /** Character ID when the item sits on a character. */
  characterId?: string;
  /** The item's slot bucket (from its definition), e.g. helmet or kinetic weapons. */
  bucketHash?: number;
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
  /** Class the armor is for: Titan | Hunter | Warlock (from the definition, not the holder). */
  class: string;
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

/**
 * How long a write we made overrides Bungie's reads. While the player is in-game,
 * profile reads lag the live game state, so a refresh right after a transfer or
 * equip still shows the old locations.
 */
const PENDING_TTL_MS = 5 * 60_000;

/** Where a write we made put an item, until Bungie's reads agree. */
interface PendingMove {
  location: string;
  characterId?: string;
  character?: string;
  at: number;
}

/** Bump when ArmorRow changes shape so stale on-disk snapshots are rebuilt. */
const ARMOR_SCHEMA = 2;

export interface ArmorSnapshot {
  schema?: number;
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
  /** Bungie.net account `primary` was resolved for (re-resolve if it changes). */
  private primaryFor?: string | null;
  /** membership key -> instanceId -> move not yet visible in Bungie's reads. */
  private pending = new Map<string, Map<string, PendingMove>>();

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
    let files: string[];
    try {
      files = fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : [];
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8'));
        const k = this.key(parsed.membershipType, parsed.membershipId);
        if (file.startsWith('armor-')) {
          if (parsed.schema === ARMOR_SCHEMA) this.armorSnapshots.set(k, parsed as ArmorSnapshot);
        } else this.snapshots.set(k, parsed as InventorySnapshot);
      } catch {
        /* skip a corrupt file; the next refresh rewrites it */
      }
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
    return this.buildInventory(membershipType, membershipId, profile);
  }

  private async buildInventory(
    membershipType: number,
    membershipId: string,
    profile: any
  ): Promise<InventorySnapshot> {
    const R = profile.Response ?? {};

    const classOf = (cid: string): string => {
      const c = R.characters?.data?.[cid];
      return c ? (CLASSES[c.classType] ?? cid) : cid;
    };

    const raw: Array<Omit<InventoryRow, 'name' | 'itemType' | 'tier' | 'bucketHash'>> = [];
    for (const it of R.profileInventory?.data?.items ?? []) raw.push(toRaw(it));
    for (const [cid, inv] of Object.entries(R.characterInventories?.data ?? {})) {
      for (const it of (inv as any).items ?? []) raw.push(toRaw(it, classOf(cid), cid));
    }
    for (const [cid, eq] of Object.entries(R.characterEquipment?.data ?? {})) {
      for (const it of (eq as any).items ?? []) {
        raw.push({ ...toRaw(it, classOf(cid), cid), location: 'equipped' });
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
        bucketHash: def?.bucketHash,
      };
    });
    items.sort((a, b) => a.name.localeCompare(b.name));
    this.reconcilePending(this.key(membershipType, membershipId), items);

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

  // -- Local write tracking -----------------------------------------------

  /**
   * Record that an item was moved to the vault or a character. Call only after
   * Bungie accepted the write. Updates cached snapshots now and keeps overriding
   * lagging refreshes until Bungie's data agrees (or PENDING_TTL_MS passes).
   */
  noteTransfer(
    membershipType: number,
    itemId: string,
    toVault: boolean,
    characterId: string,
    membershipId?: string
  ): void {
    const key = this.findKey(membershipType, itemId, membershipId);
    if (!key) return;
    this.applyMoves(key, [
      toVault
        ? { instanceId: itemId, location: 'vault' }
        : { instanceId: itemId, location: 'inventory', characterId },
    ]);
  }

  /** Record successful equips; whatever was equipped in those slots moves to inventory. */
  noteEquip(
    membershipType: number,
    characterId: string,
    itemIds: string[],
    membershipId?: string
  ): void {
    const key = itemIds.length ? this.findKey(membershipType, itemIds[0], membershipId) : undefined;
    const snap = key ? this.snapshots.get(key) : undefined;
    if (!key || !snap) return;
    const moves: Array<{ instanceId: string; location: string; characterId?: string }> = [];
    for (const id of itemIds) {
      const row = snap.items.find((r) => r.instanceId === id);
      if (!row) continue;
      const displaced = snap.items.find(
        (r) =>
          r.location === 'equipped' &&
          r.characterId === characterId &&
          r.bucketHash === row.bucketHash &&
          r.instanceId !== id &&
          !itemIds.includes(r.instanceId!)
      );
      if (displaced)
        moves.push({ instanceId: displaced.instanceId!, location: 'inventory', characterId });
      moves.push({ instanceId: id, location: 'equipped', characterId });
    }
    this.applyMoves(key, moves);
  }

  /** Instance IDs whose recorded moves Bungie's reads don't show yet. */
  pendingIds(membershipType: number, membershipId: string): Set<string> {
    return new Set(this.pending.get(this.key(membershipType, membershipId))?.keys() ?? []);
  }

  private findKey(
    membershipType: number,
    itemId: string,
    membershipId?: string
  ): string | undefined {
    if (membershipId) return this.key(membershipType, membershipId);
    for (const [key, snap] of this.snapshots) {
      if (
        snap.membershipType === membershipType &&
        snap.items.some((r) => r.instanceId === itemId)
      ) {
        return key;
      }
    }
    return undefined;
  }

  private applyMoves(
    key: string,
    moves: Array<{ instanceId: string; location: string; characterId?: string }>
  ): void {
    const snap = this.snapshots.get(key);
    const className = (cid?: string) =>
      cid ? snap?.items.find((r) => r.characterId === cid && r.character)?.character : undefined;
    let pending = this.pending.get(key);
    if (!pending) this.pending.set(key, (pending = new Map()));
    for (const m of moves) {
      pending.set(m.instanceId, {
        location: m.location,
        characterId: m.characterId,
        character: className(m.characterId),
        at: Date.now(),
      });
    }
    if (snap) {
      for (const row of snap.items) applyMove(row, pending.get(row.instanceId!));
      this.saveToDisk(snap);
    }
    const armor = this.armorSnapshots.get(key);
    if (armor) {
      for (const row of armor.armor) applyArmorMove(row, pending.get(row.instanceId));
      this.saveArmorToDisk(armor);
    }
  }

  /** Drop moves Bungie now reflects (or that expired); re-apply the rest to fresh rows. */
  private reconcilePending(key: string, items: InventoryRow[]): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    const now = Date.now();
    for (const [id, move] of pending) {
      const row = items.find((r) => r.instanceId === id);
      const confirmed =
        row && row.location === move.location && row.characterId === move.characterId;
      if (confirmed || now - move.at > PENDING_TTL_MS) pending.delete(id);
      else if (row) applyMove(row, move);
    }
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
    return this.buildArmor(membershipType, membershipId, profile);
  }

  /** Refresh both snapshots from ONE profile fetch (the armor component set is a superset). */
  async refreshBoth(
    membershipType: number,
    membershipId: string
  ): Promise<{ inventory: InventorySnapshot; armor: ArmorSnapshot }> {
    const profile = await this.api.getArmorProfile(membershipType, membershipId);
    const [inventory, armor] = await Promise.all([
      this.buildInventory(membershipType, membershipId, profile),
      this.buildArmor(membershipType, membershipId, profile),
    ]);
    return { inventory, armor };
  }

  private async buildArmor(
    membershipType: number,
    membershipId: string,
    profile: any
  ): Promise<ArmorSnapshot> {
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
          class: CLASSES[def?.classType] ?? 'Unknown',
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
    const pending = this.pending.get(this.key(membershipType, membershipId));
    if (pending) for (const row of armor) applyArmorMove(row, pending.get(row.instanceId));

    const snap: ArmorSnapshot = {
      schema: ARMOR_SCHEMA,
      membershipType,
      membershipId,
      fetchedAt: Date.now(),
      armor,
    };
    this.armorSnapshots.set(this.key(membershipType, membershipId), snap);
    this.saveArmorToDisk(snap);
    return snap;
  }

  /** Resolve (and cache) the authenticated account's primary Destiny membership. */
  async resolvePrimary(): Promise<{ membershipType: number; membershipId: string } | undefined> {
    const account = this.auth.getMembershipId();
    if (this.primary && this.primaryFor === account) return this.primary;
    this.primary = undefined;
    const data = await this.api.getMembershipsForCurrentUser();
    const memberships = data.Response?.destinyMemberships ?? [];
    if (memberships.length === 0) return undefined;
    const primaryId = data.Response?.primaryMembershipId;
    const pick = memberships.find((m: any) => m.membershipId === primaryId) ?? memberships[0];
    this.primary = { membershipType: pick.membershipType, membershipId: pick.membershipId };
    this.primaryFor = account;
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
      const { inventory, armor } = await this.refreshBoth(p.membershipType, p.membershipId);
      console.error(
        `[inventory] refreshed ${inventory.items.length} items, ${armor.armor.length} armor.`
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

function applyMove(row: InventoryRow, move: PendingMove | undefined): void {
  if (!move) return;
  row.location = move.location;
  row.characterId = move.characterId;
  row.character = move.character;
}

function applyArmorMove(row: ArmorRow, move: PendingMove | undefined): void {
  if (!move) return;
  row.location = move.location;
  row.equipped = move.location === 'equipped';
  row.character = move.character;
}

function toRaw(
  it: any,
  character?: string,
  characterId?: string
): Omit<InventoryRow, 'name' | 'itemType' | 'tier' | 'bucketHash'> {
  return {
    hash: it.itemHash,
    quantity: it.quantity ?? 1,
    location: LOCATIONS[it.location] ?? 'other',
    character,
    characterId,
    instanceId: it.itemInstanceId,
  };
}
