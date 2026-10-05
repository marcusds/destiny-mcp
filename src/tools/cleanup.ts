import { ToolDef, tool, num, str, bool, fields } from './registry.js';
import { resolveMembership } from './membership.js';

const VAULT_BUCKET = 138197802;

/** Character weapon + armor buckets that make_room manages. */
const BUCKETS: Record<number, { name: string; kind: 'weapon' | 'armor' }> = {
  1498876634: { name: 'Kinetic Weapons', kind: 'weapon' },
  2465295065: { name: 'Energy Weapons', kind: 'weapon' },
  953998645: { name: 'Power Weapons', kind: 'weapon' },
  3448274439: { name: 'Helmet', kind: 'armor' },
  3551918588: { name: 'Gauntlets', kind: 'armor' },
  14239492: { name: 'Chest Armor', kind: 'armor' },
  20886954: { name: 'Leg Armor', kind: 'armor' },
  1585787867: { name: 'Class Armor', kind: 'armor' },
};

type Candidate = {
  instanceId: string;
  hash: number;
  name: string;
  tier: number;
  /** Armor: total of its stats. Weapons: power level. */
  score: number;
  reason: string;
};

export const cleanupTools: ToolDef[] = [
  tool(
    'make_room',
    "[auth][write] Free inventory slots on a character by moving its WORST unequipped weapons/armor to the vault. Never moves equipped items or items used in any of the character's in-game loadouts. Ranks by gear tier (lowest first), then armor stat total or weapon power. Previews by default; pass apply=true to move.",
    {
      properties: {
        characterId: fields.characterId(),
        freeSlots: num(
          'Free slots wanted per bucket (default 3; a character holds 9 unequipped per bucket)'
        ),
        kind: str('Limit to "weapons" or "armor" (default both)'),
        apply: bool('Actually move the items (default false = preview only)'),
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
      const characterId = a.characterId as string;
      const freeSlots = Math.max(1, Math.min(9, (a.freeSlots as number) ?? 3));
      const kind = (a.kind as string | undefined)?.toLowerCase().replace(/s$/, '');

      const profile = await ctx.api.getProfile(
        membershipType,
        membershipId,
        [102, 201, 205, 206, 300, 304]
      );
      const R = profile.Response ?? {};
      const items: any[] = R.characterInventories?.data?.[characterId]?.items ?? [];
      if (!R.characterInventories?.data?.[characterId]) {
        throw new Error('Character not found on this account.');
      }
      const instances: Record<string, any> = R.itemComponents?.instances?.data ?? {};
      const stats: Record<string, any> = R.itemComponents?.stats?.data ?? {};

      // Anything referenced by any of this character's loadouts stays put, and so
      // does anything our cache knows we just equipped (Bungie's reads can lag).
      const inLoadout = new Set<string>(
        (ctx.inventory.get(membershipType, membershipId)?.items ?? [])
          .filter((r) => r.location === 'equipped' && r.instanceId)
          .map((r) => r.instanceId!)
      );
      for (const l of R.characterLoadouts?.data?.[characterId]?.loadouts ?? []) {
        for (const it of l.items ?? []) inLoadout.add(it.itemInstanceId);
      }

      const [defs, bucketDefs] = await Promise.all([
        ctx.manifest.getDefinitions(
          'DestinyInventoryItemDefinition',
          items.map((it) => it.itemHash)
        ),
        ctx.manifest.getDefinitions('DestinyInventoryBucketDefinition', [
          ...Object.keys(BUCKETS),
          VAULT_BUCKET,
        ]),
      ]);

      const vaultUsed = (R.profileInventory?.data?.items ?? []).filter(
        (it: any) => it.bucketHash === VAULT_BUCKET
      ).length;
      let vaultFree = (bucketDefs[VAULT_BUCKET]?.itemCount ?? 0) - vaultUsed;

      const plan: Array<{
        bucket: string;
        unequipped: number;
        capacity: number;
        move: Candidate[];
        kept: number;
      }> = [];
      for (const [bucketHash, info] of Object.entries(BUCKETS)) {
        if (kind && info.kind !== kind) continue;
        const capacity = (bucketDefs[bucketHash]?.itemCount ?? 10) - 1; // one slot is equipped
        const inBucket = items.filter((it) => String(it.bucketHash) === bucketHash);
        const want = Math.max(0, inBucket.length - (capacity - freeSlots));
        if (want === 0) continue;

        const candidates: Candidate[] = inBucket
          .filter((it) => it.itemInstanceId && !inLoadout.has(it.itemInstanceId))
          .map((it) => {
            const inst = instances[it.itemInstanceId] ?? {};
            const def = defs[String(it.itemHash)];
            // Exotics carry no gear tier; rank them after everything else.
            const exotic = def?.inventory?.tierType === 6;
            const tier: number = exotic ? 6 : (inst.gearTier ?? 0);
            const score =
              info.kind === 'armor'
                ? Object.values<any>(stats[it.itemInstanceId]?.stats ?? {}).reduce(
                    (sum, s) => sum + (s.value ?? 0),
                    0
                  )
                : (inst.primaryStat?.value ?? 0);
            return {
              instanceId: it.itemInstanceId,
              hash: it.itemHash,
              name: def?.displayProperties?.name ?? String(it.itemHash),
              tier,
              score,
              reason: `${exotic ? 'exotic' : `tier ${tier}`}, ${info.kind === 'armor' ? 'stat total' : 'power'} ${score}`,
            };
          })
          .sort((x, y) => x.tier - y.tier || x.score - y.score);

        plan.push({
          bucket: info.name,
          unequipped: inBucket.length,
          capacity,
          move: candidates.slice(0, want),
          kept: inBucket.length - Math.min(want, candidates.length),
        });
      }

      const total = plan.reduce((n, b) => n + b.move.length, 0);
      if (a.apply !== true) {
        return {
          preview: true,
          vaultFree,
          total,
          plan,
          next: total ? 'Call again with apply=true to move these.' : 'Nothing to move.',
        };
      }

      const moved: string[] = [];
      const failed: string[] = [];
      for (const b of plan) {
        for (const c of b.move) {
          if (vaultFree <= 0) {
            failed.push(`${c.name}: vault is full`);
            continue;
          }
          try {
            await ctx.api.transferItem({
              itemReferenceHash: c.hash,
              stackSize: 1,
              transferToVault: true,
              itemId: c.instanceId,
              characterId,
              membershipType,
            });
            ctx.inventory.noteTransfer(
              membershipType,
              c.instanceId,
              true,
              characterId,
              membershipId
            );
            vaultFree--;
            moved.push(`${c.name} (${b.bucket}; ${c.reason})`);
          } catch (e) {
            failed.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      return { applied: true, moved, failed, vaultFree };
    },
    { write: true }
  ),
];
