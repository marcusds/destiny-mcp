import { ToolDef, tool, num, str, numArr, fields } from './registry.js';

/** Activity history, historical/account stats, leaderboards, PGCR. */
export const statsTools: ToolDef[] = [
  tool(
    'get_activity_history',
    'Get recent activity history for a Destiny 2 character',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
        count: num('Number of activities to return (default 25, max 250)'),
        mode: num('Activity mode filter (e.g. 4=Raid, 5=AllPvP, 7=AllPvE)'),
        page: num('Page number for pagination (0-based)'),
      },
      required: ['membershipType', 'membershipId', 'characterId'],
    },
    (ctx, a) =>
      ctx.api.getActivityHistory(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string,
        (a.count as number) ?? 25,
        a.mode as number | undefined,
        a.page as number | undefined
      )
  ),

  tool(
    'get_historical_stats',
    'Get historical game statistics for a single character',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
        periodType: num('Period type (0=All, 1=Daily, 2=Monthly... use 0/None for lifetime)'),
        modes: numArr('Game mode filters'),
        groups: numArr('Stat group filters (1=General, 2=Weapons, 3=Medals)'),
      },
      required: ['membershipType', 'membershipId', 'characterId'],
    },
    (ctx, a) =>
      ctx.api.getHistoricalStats(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string,
        a.periodType as number | undefined,
        a.modes as number[] | undefined,
        a.groups as number[] | undefined
      )
  ),

  tool(
    'get_historical_stats_for_account',
    'Get account-wide historical statistics merged across all characters',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        groups: numArr('Stat group filters (1=General, 2=Weapons, 3=Medals)'),
      },
      required: ['membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.getHistoricalStatsForAccount(
        a.membershipType as number,
        a.membershipId as string,
        a.groups as number[] | undefined
      )
  ),

  tool(
    'get_aggregate_activity_stats',
    'Get per-activity aggregate statistics for a character (completions, fastest times, etc.)',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
      },
      required: ['membershipType', 'membershipId', 'characterId'],
    },
    (ctx, a) =>
      ctx.api.getDestinyAggregateActivityStats(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string
      )
  ),

  tool(
    'get_unique_weapon_history',
    'Get unique weapon usage history (kills per weapon) for a character',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
      },
      required: ['membershipType', 'membershipId', 'characterId'],
    },
    (ctx, a) =>
      ctx.api.getUniqueWeaponHistory(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string
      )
  ),

  tool(
    'get_leaderboards',
    'Get leaderboard data for a player',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        maxtop: num('Maximum number of top entries to return'),
        modes: str('Comma-separated game modes to include'),
        statid: str('Stat ID to query'),
      },
      required: ['membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.getLeaderboards(
        a.membershipType as number,
        a.membershipId as string,
        a.maxtop as number | undefined,
        a.modes as string | undefined,
        a.statid as string | undefined
      )
  ),

  tool(
    'get_post_game_carnage_report',
    'Get a detailed Post-Game Carnage Report (PGCR) for an activity instance: all participants, stats, loadouts',
    {
      properties: {
        activityId: str('Activity instance ID (from activity history instanceId field)'),
      },
      required: ['activityId'],
    },
    (ctx, a) => ctx.api.getPostGameCarnageReport(a.activityId as string)
  ),

  tool(
    'get_leaderboards_for_character',
    'Get leaderboard data for a specific character',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
        maxtop: num('Max top entries'),
        modes: str('Comma-separated game modes'),
        statid: str('Stat ID'),
      },
      required: ['membershipType', 'membershipId', 'characterId'],
    },
    (ctx, a) =>
      ctx.api.getLeaderboardsForCharacter(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string,
        a.maxtop as number | undefined,
        a.modes as string | undefined,
        a.statid as string | undefined
      )
  ),

  tool(
    'get_clan_leaderboards',
    'Get leaderboard data aggregated for a clan',
    {
      properties: {
        groupId: str('Clan group ID'),
        maxtop: num('Max top entries'),
        modes: str('Comma-separated game modes'),
        statid: str('Stat ID'),
      },
      required: ['groupId'],
    },
    (ctx, a) =>
      ctx.api.getClanLeaderboards(
        a.groupId as string,
        a.maxtop as number | undefined,
        a.modes as string | undefined,
        a.statid as string | undefined
      )
  ),

  tool(
    'get_clan_aggregate_stats',
    'Get aggregate PvP stats for a clan',
    {
      properties: { groupId: str('Clan group ID'), modes: str('Comma-separated game modes') },
      required: ['groupId'],
    },
    (ctx, a) => ctx.api.getClanAggregateStats(a.groupId as string, a.modes as string | undefined)
  ),

  tool(
    'get_historical_stats_definition',
    'Get the definitions of all historical stats (what each stat ID means)',
    { properties: {} },
    (ctx) => ctx.api.getHistoricalStatsDefinition()
  ),

  tool(
    'report_pgcr_player',
    '[auth][write] Report a player from a Post-Game Carnage Report for offensive behavior',
    {
      properties: {
        activityId: str('Activity instance ID'),
        offendingCharacterId: str('Character ID of the offending player'),
        reasonCategoryHashes: numArr('Reason category hashes'),
        reasonHashes: numArr('Specific reason hashes'),
      },
      required: ['activityId', 'offendingCharacterId', 'reasonCategoryHashes', 'reasonHashes'],
    },
    (ctx, a) =>
      ctx.api.reportPostGameCarnageReportPlayer(a.activityId as string, {
        offendingCharacterId: a.offendingCharacterId as string,
        reasonCategoryHashes: a.reasonCategoryHashes as number[],
        reasonHashes: a.reasonHashes as number[],
      }),
    { write: true }
  ),
];
