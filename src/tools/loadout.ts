import { ToolDef, ToolContext, tool, num, str, fields } from './registry.js';

const ARMOR_BUCKETS: Record<number, string> = {
  3448274439: 'helmet',
  3551918588: 'gauntlets',
  14239492: 'chest',
  20886954: 'legs',
  1585787867: 'class',
};
const CLASSES: Record<number, string> = { 0: 'Titan', 1: 'Hunter', 2: 'Warlock', 3: 'Unknown' };
const LOADOUT_SENTINEL = 2166136261; // FNV offset basis — Bungie's "unset/locked slot" marker

async function resolveMembership(
  ctx: ToolContext,
  mt?: number,
  mid?: string
): Promise<{ membershipType: number; membershipId: string }> {
  if (mid) {
    if (mt === undefined) throw new Error('membershipType is required when membershipId is given.');
    return { membershipType: mt, membershipId: mid };
  }
  const p = await ctx.inventory.resolvePrimary();
  if (!p) throw new Error('No membership given and not authenticated. Run `d2-mcp auth`.');
  return p;
}

export const loadoutTools: ToolDef[] = [
  // -- Name-based, socket-aware, current-version plug insert -----------------
  tool(
    'insert_plug_by_name',
    '[auth][write] Insert a subclass plug (ability/aspect/fragment) or armor mod BY NAME. Resolves the currently-valid plug hash and correct socket automatically — works for both subclass plugSets and armor mod sockets, skips sunset duplicates and restricted sockets. Must be in orbit/Tower. Call once per copy for repeated mods.',
    {
      properties: {
        itemId: str('Item instance ID (subclass or armor piece) to modify'),
        plugName: str('Exact plug name, e.g. "Arc Staff", "Skip Grenade", "Grenade Kickstart"'),
        characterId: fields.characterId(),
        socketIndex: num('Optional: force a specific socket index instead of auto-finding'),
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
      },
      required: ['itemId', 'plugName', 'characterId'],
    },
    async (ctx, a) => {
      const { membershipType, membershipId } = await resolveMembership(
        ctx,
        a.membershipType as number | undefined,
        a.membershipId as string | undefined
      );
      const itemId = a.itemId as string;
      const want = (a.plugName as string).trim().toLowerCase();
      const forceIdx = a.socketIndex as number | undefined;

      // Live sockets (current plug) + live reusable plugs (armor mods).
      const item = await ctx.api.getItem(membershipType, membershipId, itemId, [305, 310]);
      const sockets: any[] = item.Response?.sockets?.data?.sockets ?? [];
      const reusable: Record<string, any[]> = item.Response?.reusablePlugs?.data?.plugs ?? {};

      // Resolve the item's definition hash (for subclass plugSet options) via the snapshot.
      let snap = await ctx.inventory.getOrBuild(membershipType, membershipId);
      let row = snap.items.find((i) => i.instanceId === itemId);
      if (!row) {
        snap = await ctx.inventory.refresh(membershipType, membershipId);
        row = snap.items.find((i) => i.instanceId === itemId);
      }
      const socketEntries: any[] = row
        ? ((await ctx.manifest.getDefinition('DestinyInventoryItemDefinition', row.hash))?.sockets
            ?.socketEntries ?? [])
        : [];

      // Pull plugSet definitions referenced by the sockets.
      const plugSetHashes = new Set<number>();
      for (const se of socketEntries) {
        const ps = se.reusablePlugSetHash ?? se.randomizedPlugSetHash;
        if (ps) plugSetHashes.add(ps);
      }
      const plugSets = await ctx.manifest.getDefinitions('DestinyPlugSetDefinition', [
        ...plugSetHashes,
      ]);

      // Candidate plug hashes per socket = reusable component ∪ plugSet ∪ singleInitial.
      const candidateHashesForSocket = (idx: number): number[] => {
        const out = new Set<number>();
        for (const p of reusable[String(idx)] ?? []) {
          if (p.canInsert !== false) out.add(p.plugItemHash);
        }
        const se = socketEntries[idx];
        if (se) {
          const ps = se.reusablePlugSetHash ?? se.randomizedPlugSetHash;
          const def = ps ? plugSets[String(ps)] : undefined;
          for (const pi of def?.reusablePlugItems ?? []) {
            if (pi.currentlyCanRoll !== false) out.add(pi.plugItemHash);
          }
          if (se.singleInitialItemHash) out.add(se.singleInitialItemHash);
        }
        return [...out];
      };

      const socketCount = Math.max(sockets.length, socketEntries.length);
      const allHashes = new Set<number>();
      for (let i = 0; i < socketCount; i++) {
        if (forceIdx !== undefined && i !== forceIdx) continue;
        for (const h of candidateHashesForSocket(i)) allHashes.add(h);
      }
      const defs = await ctx.manifest.getDefinitions('DestinyInventoryItemDefinition', [
        ...allHashes,
      ]);
      const nameOf = (h: number) => (defs[String(h)]?.displayProperties?.name ?? '').toLowerCase();

      const candidates: Array<{ idx: number; hash: number; already: boolean }> = [];
      for (let i = 0; i < socketCount; i++) {
        if (forceIdx !== undefined && i !== forceIdx) continue;
        for (const h of candidateHashesForSocket(i)) {
          if (nameOf(h) === want) {
            candidates.push({ idx: i, hash: h, already: sockets[i]?.plugHash === h });
          }
        }
      }
      if (candidates.length === 0) {
        throw new Error(
          `No currently-insertable plug named "${a.plugName}" found on this item (check spelling, or it may not be unlocked).`
        );
      }
      candidates.sort((x, y) => Number(x.already) - Number(y.already));
      if (candidates[0].already) {
        return {
          applied: true,
          alreadyEquipped: true,
          socketIndex: candidates[0].idx,
          plugName: a.plugName,
        };
      }

      const tried: string[] = [];
      for (const c of candidates) {
        if (c.already) continue;
        try {
          await ctx.api.insertSocketPlugFree({
            plug: { socketIndex: c.idx, socketArrayType: 0, plugItemHash: c.hash },
            itemId,
            characterId: a.characterId as string,
            membershipType,
          });
          return {
            applied: true,
            socketIndex: c.idx,
            plugItemHash: c.hash,
            plugName: defs[String(c.hash)]?.displayProperties?.name ?? a.plugName,
          };
        } catch (e) {
          tried.push(`socket ${c.idx}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw new Error(`Could not insert "${a.plugName}". Attempts — ${tried.join(' | ')}`);
    },
    { write: true }
  ),

  // -- Armor with stats + tier + energy in one call --------------------------
  tool(
    'get_armor',
    'List owned armor with resolved Armor 3.0 stats (Weapons/Health/Class/Grenade/Super/Melee), gearTier (1-5), and energy — in one call, including vault. Omit membership to use your authenticated account.',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
        slot: str('Filter by slot: helmet | gauntlets | chest | legs | class'),
        nameContains: str('Filter by item name substring (e.g. a set name)'),
        minTier: num('Only return armor at or above this gearTier (1-5)'),
      },
    },
    async (ctx, a) => {
      const { membershipType, membershipId } = await resolveMembership(
        ctx,
        a.membershipType as number | undefined,
        a.membershipId as string | undefined
      );
      const prof = await ctx.api.getArmorProfile(membershipType, membershipId);
      const R = prof.Response ?? {};
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

      // Classify by the item DEFINITION's home bucket (vault items report the vault bucket).
      const itemDefs = await ctx.manifest.getDefinitions(
        'DestinyInventoryItemDefinition',
        raw.map((r) => r.hash)
      );
      const statHashes = new Set<number>();
      for (const s of Object.values(statsData))
        for (const h of Object.keys(s.stats ?? {})) statHashes.add(Number(h));
      const statDefs = await ctx.manifest.getDefinitions('DestinyStatDefinition', [...statHashes]);
      const statName = (h: string) => statDefs[h]?.displayProperties?.name ?? h;

      let rows = raw
        .map((r) => {
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
        .filter((r): r is NonNullable<typeof r> => r !== null);

      const slot = (a.slot as string | undefined)?.toLowerCase();
      const nameSub = (a.nameContains as string | undefined)?.toLowerCase();
      const minTier = a.minTier as number | undefined;
      if (slot) rows = rows.filter((r) => r.slot === slot);
      if (nameSub) rows = rows.filter((r) => r.name.toLowerCase().includes(nameSub));
      if (minTier !== undefined) rows = rows.filter((r) => (r.tier ?? 0) >= minTier);
      rows.sort((x, y) => (y.tier ?? 0) - (x.tier ?? 0) || x.name.localeCompare(y.name));

      return { membershipType, membershipId, count: rows.length, armor: rows };
    }
  ),

  // -- Loadout slot status ---------------------------------------------------
  tool(
    'get_character_loadouts',
    "Show a character's loadout slots and which are used / free / locked (snapshotting needs a free slot). Omit membership to use your authenticated account.",
    {
      properties: {
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
      },
      required: ['characterId'],
    },
    async (ctx, a) => {
      const { membershipType, membershipId } = await resolveMembership(
        ctx,
        a.membershipType as number | undefined,
        a.membershipId as string | undefined
      );
      const prof = await ctx.api.getCharacterLoadouts(membershipType, membershipId);
      const data: any[] =
        prof.Response?.characterLoadouts?.data?.[a.characterId as string]?.loadouts ?? [];
      const slots = data.map((l, i) => {
        const items = (l.items ?? []).filter(
          (it: any) => it.itemInstanceId && it.itemInstanceId !== '0'
        );
        let status: 'used' | 'free' | 'locked';
        if (l.nameHash === LOADOUT_SENTINEL) status = 'locked';
        else if (items.length > 0) status = 'used';
        else status = 'free';
        return { index: i, status, items: items.length };
      });
      return {
        characterId: a.characterId,
        used: slots.filter((s) => s.status === 'used').length,
        free: slots.filter((s) => s.status === 'free').map((s) => s.index),
        locked: slots.filter((s) => s.status === 'locked').length,
        slots,
      };
    }
  ),
];
