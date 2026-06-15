import { ToolDef, tool, num, str, bool } from './registry.js';

/**
 * Legacy clan Fireteam service (all require auth). NOTE: the modern
 * "Fireteam Finder" system is not in Bungie's published API spec, so it is
 * intentionally not implemented here.
 */
export const fireteamTools: ToolDef[] = [
  tool(
    'get_available_clan_fireteams',
    '[auth] List available fireteams within a clan',
    {
      properties: {
        groupId: str('Clan group ID'),
        platform: num('Platform (1=Xbox, 2=PSN, 3=Steam, 0=Any)'),
        activityType: num('Fireteam activity type filter (0=All)'),
        dateRange: num('Date range filter (0=All)'),
        slotFilter: num('Slot filter (0=None, 1=Available)'),
        publicOnly: num('Public only (0=No, 1=Yes)'),
        page: num('Page number (0-based)'),
        langFilter: str('Optional language filter'),
      },
      required: ['groupId', 'platform', 'activityType', 'dateRange', 'slotFilter', 'publicOnly'],
    },
    (ctx, a) =>
      ctx.api.getAvailableClanFireteams(
        a.groupId as string,
        a.platform as number,
        a.activityType as number,
        a.dateRange as number,
        a.slotFilter as number,
        a.publicOnly as number,
        (a.page as number) ?? 0,
        a.langFilter as string | undefined
      )
  ),

  tool(
    'search_public_clan_fireteams',
    '[auth] Search public clan fireteams across all clans',
    {
      properties: {
        platform: num('Platform (1=Xbox, 2=PSN, 3=Steam, 0=Any)'),
        activityType: num('Activity type filter (0=All)'),
        dateRange: num('Date range filter (0=All)'),
        slotFilter: num('Slot filter (0=None, 1=Available)'),
        page: num('Page number (0-based)'),
        langFilter: str('Optional language filter'),
      },
      required: ['platform', 'activityType', 'dateRange', 'slotFilter'],
    },
    (ctx, a) =>
      ctx.api.searchPublicAvailableClanFireteams(
        a.platform as number,
        a.activityType as number,
        a.dateRange as number,
        a.slotFilter as number,
        (a.page as number) ?? 0,
        a.langFilter as string | undefined
      )
  ),

  tool(
    'get_my_clan_fireteams',
    '[auth] List the fireteams the authenticated user is part of within a clan',
    {
      properties: {
        groupId: str('Clan group ID'),
        platform: num('Platform (1=Xbox, 2=PSN, 3=Steam, 0=Any)'),
        includeClosed: bool('Include closed fireteams'),
        page: num('Page number (0-based)'),
        groupFilter: bool('Restrict to this clan only'),
        langFilter: str('Optional language filter'),
      },
      required: ['groupId', 'platform', 'includeClosed'],
    },
    (ctx, a) =>
      ctx.api.getMyClanFireteams(
        a.groupId as string,
        a.platform as number,
        a.includeClosed as boolean,
        (a.page as number) ?? 0,
        (a.groupFilter as boolean) ?? false,
        a.langFilter as string | undefined
      )
  ),

  tool(
    'get_clan_fireteam',
    '[auth] Get the details of a single clan fireteam',
    {
      properties: { groupId: str('Clan group ID'), fireteamId: str('Fireteam ID') },
      required: ['groupId', 'fireteamId'],
    },
    (ctx, a) => ctx.api.getClanFireteam(a.groupId as string, a.fireteamId as string)
  ),
];
