import { ToolDef, tool, num, str, bool, fields } from './registry.js';
import { InventoryRow, InventorySnapshot } from '../inventory.js';

/**
 * Inventory tools backed by the server-side snapshot cache. Reads hit the
 * cached (hourly-refreshed) snapshot and return compact, name-resolved rows —
 * no 25k-line profile dumps, no client-side hash resolution.
 */
export const inventoryTools: ToolDef[] = [
  tool(
    'get_inventory_summary',
    'Filtered, paginated, name-resolved inventory from the server cache. Omit membership to use your authenticated account. Reads the hourly snapshot unless refresh=true.',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
        location: str('Filter by location: vault | inventory | equipped | postmaster | vendor'),
        itemType: str('Filter by item type substring (e.g. "Hand Cannon", "Helmet")'),
        tier: str('Filter by tier: Exotic | Legendary | Rare | Common | Uncommon'),
        nameContains: str('Filter by item name substring'),
        limit: num('Max rows to return (default 50, max 500)'),
        offset: num('Row offset for pagination (default 0)'),
        refresh: bool('Force a live refresh instead of using the cached snapshot'),
      },
    },
    async (ctx, a) => {
      let membershipType = a.membershipType as number | undefined;
      let membershipId = a.membershipId as string | undefined;

      if (!membershipId) {
        const primary = await ctx.inventory.resolvePrimary();
        if (!primary) {
          throw new Error(
            'No membership given and not authenticated. Provide membershipType+membershipId, or run `d2-mcp auth`.'
          );
        }
        membershipType = primary.membershipType;
        membershipId = primary.membershipId;
      }
      if (membershipType === undefined) {
        throw new Error('membershipType is required when membershipId is provided.');
      }

      const snap = await ctx.inventory.getOrBuild(membershipType, membershipId, a.refresh === true);

      const rows = filterRows(snap.items, {
        location: a.location as string | undefined,
        itemType: a.itemType as string | undefined,
        tier: a.tier as string | undefined,
        nameContains: a.nameContains as string | undefined,
      });

      const limit = clamp((a.limit as number) ?? 50, 1, 500);
      const offset = Math.max(0, (a.offset as number) ?? 0);
      const page = rows.slice(offset, offset + limit);

      return {
        membershipType,
        membershipId,
        fetchedAt: new Date(snap.fetchedAt).toISOString(),
        ageSeconds: Math.round((Date.now() - snap.fetchedAt) / 1000),
        total: rows.length,
        count: page.length,
        offset,
        limit,
        items: page,
      };
    }
  ),

  tool(
    'reload_inventory',
    'Force a fresh inventory pull now, bypassing the hourly cache. Omit membership to refresh your authenticated account.',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: str('Destiny membership ID (omit to use your authenticated account)'),
      },
    },
    async (ctx, a) => {
      let snap: InventorySnapshot | undefined;
      if (a.membershipId) {
        if (a.membershipType === undefined) {
          throw new Error('membershipType is required when membershipId is provided.');
        }
        snap = await ctx.inventory.refresh(a.membershipType as number, a.membershipId as string);
      } else {
        snap = await ctx.inventory.refreshPrimary();
        if (!snap) {
          throw new Error(
            'Not authenticated. Run `d2-mcp auth` or pass membershipType+membershipId.'
          );
        }
      }
      return {
        refreshed: true,
        membershipType: snap.membershipType,
        membershipId: snap.membershipId,
        fetchedAt: new Date(snap.fetchedAt).toISOString(),
        itemCount: snap.items.length,
      };
    }
  ),
];

function filterRows(
  rows: InventoryRow[],
  f: { location?: string; itemType?: string; tier?: string; nameContains?: string }
): InventoryRow[] {
  const loc = f.location?.toLowerCase();
  const type = f.itemType?.toLowerCase();
  const tier = f.tier?.toLowerCase();
  const name = f.nameContains?.toLowerCase();
  return rows.filter((r) => {
    if (loc && r.location !== loc) return false;
    if (type && !r.itemType.toLowerCase().includes(type)) return false;
    if (tier && r.tier.toLowerCase() !== tier) return false;
    if (name && !r.name.toLowerCase().includes(name)) return false;
    return true;
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(n)));
}
