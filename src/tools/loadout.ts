import { ToolDef, ToolContext, tool, num, str, bool, strArr, fields } from './registry.js';
import { resolveMembership } from './membership.js';
import { InventoryRow } from '../inventory.js';

const LOADOUT_SENTINEL = 2166136261; // FNV offset basis — Bungie's "unset/locked slot" marker

/** Energy cost of a plug per its definition (0 if none — e.g. subclass plugs / empty sockets). */
function plugEnergyCost(defs: Record<string, any>, hash?: number): number {
  return defs[String(hash)]?.plug?.energyCost?.energyCost ?? 0;
}

/**
 * Throw a clear error if inserting `newHash` into socket `targetIdx` would exceed the
 * armor piece's energy capacity. No-op for items with no energy meter (subclasses), so
 * fragments/aspects are unaffected. Surfaces the real cause instead of a raw
 * `1676 DestinyFailedPlugInsertionRules`. Pass the item's instance `energy` component (300).
 */
function assertEnergyFits(opts: {
  energy: { energyCapacity?: number; energyUsed?: number } | undefined | null;
  curSocketHash?: number;
  newHash: number;
  defs: Record<string, any>;
}): void {
  const cap = opts.energy?.energyCapacity;
  if (cap === undefined || cap === null) return; // not an energy item (subclass, etc.)
  const used = opts.energy?.energyUsed ?? 0;
  const oldCost = plugEnergyCost(opts.defs, opts.curSocketHash); // freed by overwriting this socket
  const newCost = plugEnergyCost(opts.defs, opts.newHash);
  const free = cap - used + oldCost;
  if (newCost > free) {
    const name = opts.defs[String(opts.newHash)]?.displayProperties?.name ?? opts.newHash;
    throw new Error(
      `Insufficient armor energy for "${name}": needs ${newCost}, only ${free} free ` +
        `(capacity ${cap}, used ${used}). Free ~${newCost - free} energy by removing or ` +
        `downgrading another mod on this piece first.`
    );
  }
}

/**
 * Live socket state for one item plus everything needed to pick plugs by name:
 * current plugs (305), reusable plugs (310), instance energy (300), the item's
 * socket entries and plugSets from the manifest, and resolved plug definitions.
 * `onlySocket` limits candidate resolution to a single socket index.
 */
async function loadItemSockets(
  ctx: ToolContext,
  membershipType: number,
  membershipId: string,
  itemId: string,
  onlySocket?: number
) {
  const item = await ctx.api.getItem(membershipType, membershipId, itemId, [305, 310, 300]);
  const sockets: any[] = item.Response?.sockets?.data?.sockets ?? [];
  const reusable: Record<string, any[]> = item.Response?.reusablePlugs?.data?.plugs ?? {};
  const energy = item.Response?.instance?.data?.energy as
    | { energyCapacity?: number; energyUsed?: number }
    | undefined;

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
  const candidates = (idx: number): number[] => {
    const out = new Set<number>();
    for (const p of reusable[String(idx)] ?? []) {
      if (p.canInsert !== false) out.add(p.plugItemHash);
    }
    const se = socketEntries[idx];
    if (se) {
      const ps = se.reusablePlugSetHash ?? se.randomizedPlugSetHash;
      const def = ps ? plugSets[String(ps)] : undefined;
      // Include all plugSet items — subclass aspects/fragments are unlocks
      // (currentlyCanRoll=false) so we must not filter on it. Sunset
      // duplicates that can't actually be inserted are weeded out by the
      // callers' per-candidate insert retry.
      for (const pi of def?.reusablePlugItems ?? []) out.add(pi.plugItemHash);
      if (se.singleInitialItemHash) out.add(se.singleInitialItemHash);
    }
    return [...out];
  };

  const socketCount = Math.max(sockets.length, socketEntries.length);
  const allHashes = new Set<number>();
  for (let i = 0; i < socketCount; i++) {
    if (onlySocket !== undefined && i !== onlySocket) continue;
    for (const h of candidates(i)) allHashes.add(h);
  }
  // Also resolve each socket's CURRENT plug so we can tell empty sockets apart.
  for (const s of sockets) if (s?.plugHash) allHashes.add(s.plugHash);
  const defs = await ctx.manifest.getDefinitions('DestinyInventoryItemDefinition', [...allHashes]);
  const nameOf = (h: number) => (defs[String(h)]?.displayProperties?.name ?? '').toLowerCase();
  const isEmpty = (i: number) => {
    const cur = sockets[i]?.plugHash;
    return !cur || nameOf(cur).includes('empty');
  };

  return { sockets, energy, socketCount, candidates, defs, nameOf, isEmpty };
}

/** Bungie error when the destination bucket has no free slot. */
const NO_ROOM = /NoRoomInDestination|1642/;

/**
 * Bring every loadout item onto the target character so EquipLoadout can use it.
 * Bungie's EquipLoadout silently skips items that are in the vault or on another
 * character, so: vault -> character; other character -> vault -> character. When
 * the character's slot is full, an unequipped non-loadout item in that bucket is
 * moved to the vault to make room. Returns per-item notes for anything skipped.
 */
async function stageLoadoutItems(
  ctx: ToolContext,
  membershipType: number,
  characterId: string,
  loadoutIds: Set<string>,
  rows: InventoryRow[]
): Promise<{ moved: string[]; problems: string[] }> {
  const moved: string[] = [];
  const problems: string[] = [];
  const transfer = (row: InventoryRow, toVault: boolean, charId: string) =>
    ctx.api.transferItem({
      itemReferenceHash: row.hash,
      stackSize: 1,
      transferToVault: toVault,
      itemId: row.instanceId!,
      characterId: charId,
      membershipType,
    });

  /** Move one spare item out of `bucketHash` on the target character. */
  const makeRoom = async (bucketHash: number | undefined): Promise<boolean> => {
    const spare = rows.find(
      (r) =>
        r.characterId === characterId &&
        r.location === 'inventory' &&
        r.bucketHash === bucketHash &&
        r.instanceId &&
        !loadoutIds.has(r.instanceId)
    );
    if (!spare) return false;
    await transfer(spare, true, characterId);
    spare.location = 'vault';
    spare.characterId = undefined;
    moved.push(`${spare.name} -> vault (to make room)`);
    return true;
  };

  for (const id of loadoutIds) {
    const row = rows.find((r) => r.instanceId === id);
    if (!row) {
      problems.push(`${id}: not found (dismantled?)`);
      continue;
    }
    if (row.characterId === characterId) continue;
    if (row.location === 'equipped') {
      problems.push(`${row.name}: equipped on your ${row.character}; unequip it there first`);
      continue;
    }
    try {
      if (row.characterId) {
        await transfer(row, true, row.characterId); // other character -> vault
        row.location = 'vault';
      }
      try {
        await transfer(row, false, characterId);
      } catch (e) {
        if (!(e instanceof Error && NO_ROOM.test(e.message)) || !(await makeRoom(row.bucketHash))) {
          throw e;
        }
        await transfer(row, false, characterId);
      }
      row.location = 'inventory';
      row.characterId = characterId;
      moved.push(`${row.name} -> character`);
    } catch (e) {
      problems.push(`${row.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { moved, problems };
}

export const loadoutTools: ToolDef[] = [
  tool(
    'equip_loadout',
    "[auth][write] Equip one of a character's in-game loadouts by index (see get_character_loadouts). Unlike Bungie's raw endpoint, first pulls loadout items from the vault or your other characters (making room if a slot is full), then verifies and reports anything that didn't equip. Must not be in an activity that locks gear.",
    {
      properties: {
        loadoutIndex: num('Loadout slot index'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
      },
      required: ['loadoutIndex', 'characterId'],
    },
    async (ctx, a) => {
      const { membershipType, membershipId } = await resolveMembership(
        ctx,
        a.membershipType as number | undefined,
        a.membershipId as string | undefined
      );
      const characterId = a.characterId as string;
      const loadoutIndex = a.loadoutIndex as number;

      const [prof, snap] = await Promise.all([
        ctx.api.getCharacterLoadouts(membershipType, membershipId),
        ctx.inventory.refresh(membershipType, membershipId),
      ]);
      const loadout =
        prof.Response?.characterLoadouts?.data?.[characterId]?.loadouts?.[loadoutIndex];
      if (!loadout) throw new Error(`No loadout at index ${loadoutIndex} for this character.`);
      const loadoutIds = new Set<string>(
        (loadout.items ?? [])
          .map((it: any) => it.itemInstanceId)
          .filter((id: string | undefined) => id && id !== '0')
      );
      if (loadoutIds.size === 0) throw new Error(`Loadout ${loadoutIndex} is empty.`);

      const rows = snap.items.map((r) => ({ ...r }));
      const { moved, problems } = await stageLoadoutItems(
        ctx,
        membershipType,
        characterId,
        loadoutIds,
        rows
      );
      await ctx.api.equipLoadout({ loadoutIndex, characterId, membershipType });

      // Verify against a fresh read; Bungie reports success even for partial equips.
      const after = await ctx.inventory.refresh(membershipType, membershipId);
      const equipped = new Set(
        after.items
          .filter((r) => r.location === 'equipped' && r.characterId === characterId)
          .map((r) => r.instanceId)
      );
      const name = (id: string) => rows.find((r) => r.instanceId === id)?.name ?? id;
      const notEquipped = [...loadoutIds].filter((id) => !equipped.has(id)).map(name);
      return {
        loadoutIndex,
        equipped: loadoutIds.size - notEquipped.length,
        total: loadoutIds.size,
        moved,
        notEquipped,
        problems,
      };
    },
    { write: true }
  ),

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

      const {
        sockets,
        energy,
        socketCount,
        candidates: candidateHashesForSocket,
        defs,
        nameOf,
        isEmpty: isEmptySocket,
      } = await loadItemSockets(ctx, membershipType, membershipId, itemId, forceIdx);

      const candidates: Array<{ idx: number; hash: number; already: boolean; empty: boolean }> = [];
      for (let i = 0; i < socketCount; i++) {
        if (forceIdx !== undefined && i !== forceIdx) continue;
        for (const h of candidateHashesForSocket(i)) {
          if (nameOf(h) === want) {
            candidates.push({
              idx: i,
              hash: h,
              already: sockets[i]?.plugHash === h,
              empty: isEmptySocket(i),
            });
          }
        }
      }
      if (candidates.length === 0) {
        throw new Error(
          `No currently-insertable plug named "${a.plugName}" found on this item (check spelling, or it may not be unlocked).`
        );
      }
      // Prefer an empty socket (so repeated plugs fill new slots instead of
      // overwriting), then any non-target socket; never disturb a socket that
      // already holds the target.
      const rank = (c: { already: boolean; empty: boolean }) => (c.already ? 2 : c.empty ? 0 : 1);
      candidates.sort((x, y) => rank(x) - rank(y) || x.idx - y.idx);
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
          assertEnergyFits({
            energy,
            curSocketHash: sockets[c.idx]?.plugHash,
            newHash: c.hash,
            defs,
          });
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

  // -- Composite: place many plugs on one item, distinct sockets -------------
  tool(
    'set_plugs',
    '[auth][write] Insert MULTIPLE plugs (e.g. 5 fragments, or several armor mods) into ONE item in a single pass, assigning each to a DISTINCT socket. Reads socket state once and tracks assignments locally, so it avoids the read-after-write collisions you get from repeated insert_plug_by_name. Must be in orbit/Tower.',
    {
      properties: {
        itemId: str('Item instance ID (subclass or armor piece)'),
        plugNames: strArr('Plug names to apply, in order (e.g. the 5 Echo fragments)'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
      },
      required: ['itemId', 'plugNames', 'characterId'],
    },
    async (ctx, a) => {
      const { membershipType, membershipId } = await resolveMembership(
        ctx,
        a.membershipType as number | undefined,
        a.membershipId as string | undefined
      );
      const itemId = a.itemId as string;
      const names = (a.plugNames as string[]).map((n) => n.trim());

      const {
        sockets,
        energy,
        socketCount,
        candidates: candHashes,
        defs,
        nameOf,
        isEmpty,
      } = await loadItemSockets(ctx, membershipType, membershipId, itemId);
      // Running energy tally — each placed mod changes how much is free for the next.
      let energyUsed = energy?.energyUsed ?? 0;

      const used = new Set<number>();
      const results: any[] = [];
      for (const rawName of names) {
        const want = rawName.toLowerCase();
        const cands: Array<{ idx: number; hash: number; already: boolean; empty: boolean }> = [];
        for (let i = 0; i < socketCount; i++) {
          if (used.has(i)) continue;
          for (const h of candHashes(i)) {
            if (nameOf(h) === want)
              cands.push({
                idx: i,
                hash: h,
                already: sockets[i]?.plugHash === h,
                empty: isEmpty(i),
              });
          }
        }
        if (cands.length === 0) {
          results.push({
            plug: rawName,
            applied: false,
            reason: 'no free socket offers this plug',
          });
          continue;
        }
        cands.sort(
          (x, y) =>
            (x.already ? 0 : x.empty ? 1 : 2) - (y.already ? 0 : y.empty ? 1 : 2) || x.idx - y.idx
        );
        let done = false;
        const tried: string[] = [];
        for (const c of cands) {
          if (c.already) {
            used.add(c.idx);
            results.push({
              plug: rawName,
              applied: true,
              alreadyEquipped: true,
              socketIndex: c.idx,
            });
            done = true;
            break;
          }
          try {
            const oldCost = plugEnergyCost(defs, sockets[c.idx]?.plugHash);
            assertEnergyFits({
              energy: { energyCapacity: energy?.energyCapacity, energyUsed },
              curSocketHash: sockets[c.idx]?.plugHash,
              newHash: c.hash,
              defs,
            });
            await ctx.api.insertSocketPlugFree({
              plug: { socketIndex: c.idx, socketArrayType: 0, plugItemHash: c.hash },
              itemId,
              characterId: a.characterId as string,
              membershipType,
            });
            used.add(c.idx);
            sockets[c.idx] = { plugHash: c.hash }; // local bookkeeping (avoid laggy re-read)
            energyUsed += plugEnergyCost(defs, c.hash) - oldCost; // keep running tally accurate
            results.push({ plug: rawName, applied: true, socketIndex: c.idx });
            done = true;
            break;
          } catch (e) {
            tried.push(`s${c.idx}: ${e instanceof Error ? e.message.slice(0, 50) : ''}`);
          }
        }
        if (!done) results.push({ plug: rawName, applied: false, reason: tried.join(' | ') });
      }
      return {
        itemId,
        applied: results.filter((r) => r.applied).length,
        total: names.length,
        results,
      };
    },
    { write: true }
  ),

  // -- Armor with stats + tier + energy in one call --------------------------
  tool(
    'get_armor',
    'List owned armor (with the class each piece is for) and resolved Armor 3.0 stats (Weapons/Health/Class/Grenade/Super/Melee), gearTier (1-5), and energy. Reads a cached snapshot (refreshed hourly) unless refresh=true. Includes vault. Omit membership to use your authenticated account.',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
        slot: str('Filter by slot: helmet | gauntlets | chest | legs | class'),
        class: str('Filter by the class the armor is for: Titan | Hunter | Warlock'),
        nameContains: str('Filter by item name substring (e.g. a set name)'),
        minTier: num('Only return armor at or above this gearTier (1-5)'),
        refresh: bool('Force a live pull instead of using the cached snapshot'),
      },
    },
    async (ctx, a) => {
      const { membershipType, membershipId } = await resolveMembership(
        ctx,
        a.membershipType as number | undefined,
        a.membershipId as string | undefined
      );
      const snap = await ctx.inventory.getOrBuildArmor(
        membershipType,
        membershipId,
        a.refresh === true
      );

      let rows = snap.armor;
      const slot = (a.slot as string | undefined)?.toLowerCase();
      const nameSub = (a.nameContains as string | undefined)?.toLowerCase();
      const minTier = a.minTier as number | undefined;
      const cls = (a.class as string | undefined)?.toLowerCase();
      if (slot) rows = rows.filter((r) => r.slot === slot);
      if (cls) rows = rows.filter((r) => r.class.toLowerCase() === cls);
      if (nameSub) rows = rows.filter((r) => r.name.toLowerCase().includes(nameSub));
      if (minTier !== undefined) rows = rows.filter((r) => (r.tier ?? 0) >= minTier);

      return {
        membershipType,
        membershipId,
        fetchedAt: new Date(snap.fetchedAt).toISOString(),
        ageSeconds: Math.round((Date.now() - snap.fetchedAt) / 1000),
        count: rows.length,
        armor: rows,
      };
    }
  ),

  // -- Loadout slot status ---------------------------------------------------
  tool(
    'get_character_loadouts',
    "Show a character's in-game loadout slots: name and item names for used slots, plus which are free / locked (snapshotting needs a free slot). Omit membership to use your authenticated account.",
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
      const [prof, snap, names] = await Promise.all([
        ctx.api.getCharacterLoadouts(membershipType, membershipId),
        ctx.inventory.getOrBuild(membershipType, membershipId),
        ctx.manifest.getAll('DestinyLoadoutNameDefinition'),
      ]);
      const data: any[] =
        prof.Response?.characterLoadouts?.data?.[a.characterId as string]?.loadouts ?? [];
      const loadoutName = new Map<number, string>(names.map((n) => [n.hash, n.name]));
      const itemName = new Map(snap.items.map((i) => [i.instanceId, i.name]));
      const slots = data.map((l, i) => {
        const items = (l.items ?? []).filter(
          (it: any) => it.itemInstanceId && it.itemInstanceId !== '0'
        );
        let status: 'used' | 'free' | 'locked';
        if (l.nameHash === LOADOUT_SENTINEL) status = 'locked';
        else if (items.length > 0) status = 'used';
        else status = 'free';
        if (status !== 'used') return { index: i, status };
        return {
          index: i,
          status,
          name: loadoutName.get(l.nameHash),
          items: items.map(
            (it: any) => itemName.get(it.itemInstanceId) ?? `(missing ${it.itemInstanceId})`
          ),
        };
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
