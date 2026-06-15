import { ToolDef, tool, num, str, numArr, fields } from './registry.js';

/** Public read tools: profiles, characters, items, search, milestones, vendors. */
export const readTools: ToolDef[] = [
  tool(
    'get_destiny_profile',
    'Get Destiny 2 profile information for a player (characters, inventory, progression, etc. via components)',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        components: numArr(
          'Component types (100=Profiles, 200=Characters, 201=CharacterInventories, 205=CharacterEquipment, 300=ItemInstances, 800=Collectibles, 900=Records)'
        ),
      },
      required: ['membershipType', 'membershipId'],
    },
    (ctx, a) =>
      ctx.api.getProfile(
        a.membershipType as number,
        a.membershipId as string,
        (a.components as number[]) ?? [100, 200]
      )
  ),

  tool(
    'get_destiny_character',
    'Get detailed information about a specific Destiny 2 character',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
        components: numArr('Component types to include'),
      },
      required: ['membershipType', 'membershipId', 'characterId'],
    },
    (ctx, a) =>
      ctx.api.getCharacter(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string,
        (a.components as number[]) ?? [200]
      )
  ),

  tool(
    'get_destiny_item',
    'Get detailed instance information about a specific item (perks, stats, sockets)',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        itemInstanceId: str('Item instance ID'),
        components: numArr('Component types (300=Instances, 302=Perks, 304=Stats, 305=Sockets)'),
      },
      required: ['membershipType', 'membershipId', 'itemInstanceId'],
    },
    (ctx, a) =>
      ctx.api.getItem(
        a.membershipType as number,
        a.membershipId as string,
        a.itemInstanceId as string,
        (a.components as number[]) ?? [300, 302, 304, 305]
      )
  ),

  tool(
    'search_destiny_player',
    'Search for a Destiny 2 player by display name on a platform',
    {
      properties: {
        membershipType: fields.membershipType(),
        displayName: str('Player display name to search for'),
      },
      required: ['membershipType', 'displayName'],
    },
    (ctx, a) => ctx.api.searchDestinyPlayer(a.membershipType as number, a.displayName as string)
  ),

  tool(
    'search_destiny_player_by_bungie_name',
    'Search for a Destiny player using their Bungie Name and 4-digit code (e.g. Guardian#1234)',
    {
      properties: {
        membershipType: fields.membershipType(),
        displayName: str('Bungie display name (without the #code)'),
        displayNameCode: num('Bungie name code / discriminator (the digits after #)'),
      },
      required: ['membershipType', 'displayName', 'displayNameCode'],
    },
    (ctx, a) =>
      ctx.api.searchDestinyPlayerByBungieName(
        a.membershipType as number,
        a.displayName as string,
        a.displayNameCode as number
      )
  ),

  tool(
    'get_linked_profiles',
    'Get all linked/cross-save profiles for a Destiny 2 player across platforms',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
      },
      required: ['membershipType', 'membershipId'],
    },
    (ctx, a) => ctx.api.getLinkedProfiles(a.membershipType as number, a.membershipId as string)
  ),

  tool(
    'get_public_milestones',
    'Get current public milestones (weekly activities/challenges) available to all players',
    { properties: {} },
    (ctx) => ctx.api.getPublicMilestones()
  ),

  tool(
    'get_public_milestone_content',
    'Get detailed content for a specific milestone',
    {
      properties: { milestoneHash: num('Milestone hash identifier') },
      required: ['milestoneHash'],
    },
    (ctx, a) => ctx.api.getPublicMilestoneContent(a.milestoneHash as number)
  ),

  tool(
    'get_public_vendors',
    'Get public (sale) vendor information and inventories',
    {
      properties: {
        components: numArr('Vendor components (400=Vendors, 401=Categories, 402=Sales)'),
      },
    },
    (ctx, a) => ctx.api.getPublicVendors((a.components as number[]) ?? [400, 401, 402])
  ),
];
