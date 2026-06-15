import { ToolDef, tool, num, str, bool, fields } from './registry.js';

/** Clan (GroupV2) reads + authenticated management actions. */
export const clanTools: ToolDef[] = [
  // -- Reads ---------------------------------------------------------------
  tool(
    'get_clan',
    'Get clan/group details by group ID',
    { properties: { groupId: str('Clan group ID') }, required: ['groupId'] },
    (ctx, a) => ctx.api.getGroup(a.groupId as string)
  ),

  tool(
    'get_clan_by_name',
    'Find a clan by its exact name',
    {
      properties: {
        groupName: str('Exact clan name'),
        groupType: num('Group type (1=Clan, default 1)'),
      },
      required: ['groupName'],
    },
    (ctx, a) => ctx.api.getGroupByName(a.groupName as string, (a.groupType as number) ?? 1)
  ),

  tool(
    'get_clan_members',
    'List members of a clan',
    {
      properties: {
        groupId: str('Clan group ID'),
        currentpage: num('Page number (1-based, default 1)'),
        memberType: num('Filter by member type (1=Beginner,2=Member,3=Admin,5=Founder)'),
        nameSearch: str('Filter members by name'),
      },
      required: ['groupId'],
    },
    (ctx, a) =>
      ctx.api.getMembersOfGroup(
        a.groupId as string,
        (a.currentpage as number) ?? 1,
        a.memberType as number | undefined,
        a.nameSearch as string | undefined
      )
  ),

  tool(
    'get_clan_admins',
    'List the admins and founder of a clan',
    {
      properties: { groupId: str('Clan group ID'), currentpage: num('Page (1-based)') },
      required: ['groupId'],
    },
    (ctx, a) =>
      ctx.api.getAdminsAndFounderOfGroup(a.groupId as string, (a.currentpage as number) ?? 1)
  ),

  tool(
    'get_groups_for_member',
    'List the clans/groups a player belongs to',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        filter: num('Group filter (0=All, default 0)'),
        groupType: num('Group type (1=Clan, default 1)'),
      },
      required: ['membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.getGroupsForMember(
        a.membershipType as number,
        a.membershipId as string,
        (a.filter as number) ?? 0,
        (a.groupType as number) ?? 1
      )
  ),

  tool(
    'get_clan_weekly_reward_state',
    'Get the weekly reward state for a clan',
    { properties: { groupId: str('Clan group ID') }, required: ['groupId'] },
    (ctx, a) => ctx.api.getClanWeeklyRewardState(a.groupId as string)
  ),

  tool(
    'get_clan_banner_source',
    'Get the dictionary of available clan banner options',
    { properties: {} },
    (ctx) => ctx.api.getClanBannerSource()
  ),

  // -- Authenticated management -------------------------------------------
  tool(
    'get_clan_pending_members',
    '[auth] List members pending approval to join a clan',
    {
      properties: { groupId: str('Clan group ID'), currentpage: num('Page (1-based)') },
      required: ['groupId'],
    },
    (ctx, a) => ctx.api.getPendingMemberships(a.groupId as string, (a.currentpage as number) ?? 1)
  ),

  tool(
    'invite_clan_member',
    '[auth][write] Invite a player to a clan',
    {
      properties: {
        groupId: str('Clan group ID'),
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        message: str('Optional invite message'),
      },
      required: ['groupId', 'membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.inviteMemberToGroup(
        a.groupId as string,
        a.membershipType as number,
        a.membershipId as string,
        (a.message as string) ?? ''
      ),
    { write: true }
  ),

  tool(
    'approve_clan_member',
    '[auth][write] Approve a pending clan membership',
    {
      properties: {
        groupId: str('Clan group ID'),
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        message: str('Optional message'),
      },
      required: ['groupId', 'membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.approvePending(
        a.groupId as string,
        a.membershipType as number,
        a.membershipId as string,
        (a.message as string) ?? ''
      ),
    { write: true }
  ),

  tool(
    'kick_clan_member',
    '[auth][write] Kick a member from a clan',
    {
      properties: {
        groupId: str('Clan group ID'),
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
      },
      required: ['groupId', 'membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.kickMember(a.groupId as string, a.membershipType as number, a.membershipId as string),
    { write: true }
  ),

  tool(
    'ban_clan_member',
    '[auth][write] Ban a member from a clan',
    {
      properties: {
        groupId: str('Clan group ID'),
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        comment: str('Optional ban reason'),
        length: num('Ban length code (0=permanent)'),
      },
      required: ['groupId', 'membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.banMember(
        a.groupId as string,
        a.membershipType as number,
        a.membershipId as string,
        (a.comment as string) ?? '',
        (a.length as number) ?? 0
      ),
    { write: true }
  ),

  tool(
    'unban_clan_member',
    '[auth][write] Unban a member from a clan',
    {
      properties: {
        groupId: str('Clan group ID'),
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
      },
      required: ['groupId', 'membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.unbanMember(
        a.groupId as string,
        a.membershipType as number,
        a.membershipId as string
      ),
    { write: true }
  ),

  tool(
    'search_clans',
    'Search for clans/groups by name',
    {
      properties: {
        name: str('Name to search for'),
        groupType: num('Group type (1=Clan, default 1)'),
        itemsPerPage: num('Results per page'),
        currentPage: num('Page number (0-based)'),
      },
      required: ['name'],
    },
    (ctx, a) =>
      ctx.api.groupSearch({
        name: a.name as string,
        groupType: (a.groupType as number) ?? 1,
        itemsPerPage: a.itemsPerPage as number | undefined,
        currentPage: (a.currentPage as number) ?? 0,
      })
  ),

  tool(
    'get_potential_groups_for_member',
    'List clans/groups a player could potentially join or has pending with',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        filter: num('Group filter (0=All)'),
        groupType: num('Group type (1=Clan)'),
      },
      required: ['membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.getPotentialGroupsForMember(
        a.membershipType as number,
        a.membershipId as string,
        (a.filter as number) ?? 0,
        (a.groupType as number) ?? 1
      )
  ),

  tool(
    'get_clan_banned_members',
    '[auth] List banned members of a clan',
    {
      properties: { groupId: str('Clan group ID'), currentpage: num('Page (1-based)') },
      required: ['groupId'],
    },
    (ctx, a) => ctx.api.getBannedMembersOfGroup(a.groupId as string, (a.currentpage as number) ?? 1)
  ),

  tool(
    'get_clan_invited_individuals',
    '[auth] List individuals currently invited to a clan',
    {
      properties: { groupId: str('Clan group ID'), currentpage: num('Page (1-based)') },
      required: ['groupId'],
    },
    (ctx, a) => ctx.api.getInvitedIndividuals(a.groupId as string, (a.currentpage as number) ?? 1)
  ),

  tool(
    'approve_all_clan_pending',
    '[auth][write] Approve ALL pending clan membership requests',
    {
      properties: { groupId: str('Clan group ID'), message: str('Optional message') },
      required: ['groupId'],
    },
    (ctx, a) => ctx.api.approveAllPending(a.groupId as string, (a.message as string) ?? ''),
    { write: true }
  ),

  tool(
    'deny_all_clan_pending',
    '[auth][write] Deny ALL pending clan membership requests',
    {
      properties: { groupId: str('Clan group ID'), message: str('Optional message') },
      required: ['groupId'],
    },
    (ctx, a) => ctx.api.denyAllPending(a.groupId as string, (a.message as string) ?? ''),
    { write: true }
  ),

  tool(
    'edit_clan',
    '[auth][write] Edit clan settings (name, about, motto, etc.). Pass only the fields to change.',
    {
      properties: {
        groupId: str('Clan group ID'),
        name: str('New clan name'),
        about: str('New about text'),
        motto: str('New motto'),
        callsign: str('New clan callsign/tag'),
        isPublic: bool('Whether the clan is public'),
        membershipOption: num('Join setting (0=Reviewed, 1=Open, 2=Closed)'),
      },
      required: ['groupId'],
    },
    (ctx, a) => {
      const { groupId, ...edits } = a as Record<string, unknown>;
      // Drop undefined keys so we only send intended changes.
      const clean = Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined));
      return ctx.api.editGroup(groupId as string, clean);
    },
    { write: true }
  ),

  tool(
    'edit_clan_banner',
    '[auth][write] Edit a clan banner (all banner component hashes required)',
    {
      properties: {
        groupId: str('Clan group ID'),
        decalId: num('Decal ID'),
        decalColorId: num('Decal color ID'),
        decalBackgroundColorId: num('Decal background color ID'),
        gonfalonId: num('Gonfalon ID'),
        gonfalonColorId: num('Gonfalon color ID'),
        gonfalonDetailId: num('Gonfalon detail ID'),
        gonfalonDetailColorId: num('Gonfalon detail color ID'),
      },
      required: [
        'groupId',
        'decalId',
        'decalColorId',
        'decalBackgroundColorId',
        'gonfalonId',
        'gonfalonColorId',
        'gonfalonDetailId',
        'gonfalonDetailColorId',
      ],
    },
    (ctx, a) => {
      const { groupId, ...banner } = a as Record<string, number | string>;
      return ctx.api.editClanBanner(groupId as string, banner as Record<string, number>);
    },
    { write: true }
  ),
];
