import { ToolContext } from './registry.js';

/** Explicit membership if given, else the authenticated account's primary one. */
export async function resolveMembership(
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

export const CLASS_NAMES: Record<number, string> = { 0: 'Titan', 1: 'Hunter', 2: 'Warlock' };
