import { ToolDef, tool, num, str, fields } from './registry.js';

/** Bungie.net user lookups and global-name search. */
export const userTools: ToolDef[] = [
  tool(
    'get_bungie_user_by_id',
    'Get a Bungie.net user account by its Bungie.net membership ID',
    { properties: { membershipId: str('Bungie.net membership ID') }, required: ['membershipId'] },
    (ctx, a) => ctx.api.getBungieNetUserById(a.membershipId as string)
  ),

  tool(
    'get_membership_data_by_id',
    'Get all Destiny memberships linked to a given membership ID + platform',
    {
      properties: {
        membershipId: fields.membershipId(),
        membershipType: fields.membershipType(),
      },
      required: ['membershipId', 'membershipType'],
    },
    (ctx, a) => ctx.api.getMembershipDataById(a.membershipId as string, a.membershipType as number)
  ),

  tool(
    'search_by_global_name',
    'Search for players by Bungie name prefix across all platforms (paged)',
    {
      properties: {
        displayNamePrefix: str('Bungie name prefix to search for'),
        page: num('Page number (0-based, default 0)'),
      },
      required: ['displayNamePrefix'],
    },
    (ctx, a) =>
      ctx.api.searchByGlobalNamePrefix(a.displayNamePrefix as string, (a.page as number) ?? 0)
  ),
];
