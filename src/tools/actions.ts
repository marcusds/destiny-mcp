import { ToolDef, tool, num, str, bool, strArr, numArr, fields } from './registry.js';

/** Authenticated inventory/loadout write actions + authed reads. */
export const actionTools: ToolDef[] = [
  // -- Authenticated reads -------------------------------------------------
  tool(
    'get_current_user',
    '[auth] Get the Destiny memberships for the currently authenticated account ("who am I")',
    { properties: {} },
    (ctx) => ctx.api.getMembershipsForCurrentUser()
  ),

  tool(
    'get_character_vendors',
    '[auth] Get live vendor inventories for one of your characters',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
        components: numArr('Vendor components (400=Vendors, 401=Categories, 402=Sales)'),
      },
      required: ['membershipType', 'membershipId', 'characterId'],
    },
    (ctx, a) =>
      ctx.api.getVendors(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string,
        (a.components as number[]) ?? [400, 401, 402]
      )
  ),

  tool(
    'get_character_vendor',
    '[auth] Get a single vendor for one of your characters',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
        vendorHash: num('Vendor hash'),
        components: numArr('Vendor components (400, 401, 402)'),
      },
      required: ['membershipType', 'membershipId', 'characterId', 'vendorHash'],
    },
    (ctx, a) =>
      ctx.api.getVendor(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string,
        a.vendorHash as number,
        (a.components as number[]) ?? [400, 401, 402]
      )
  ),

  // -- Inventory writes ----------------------------------------------------
  tool(
    'transfer_item',
    '[auth][write] Transfer an item between a character and the vault',
    {
      properties: {
        itemReferenceHash: num('Item hash (definition hash) of the item'),
        itemId: str('Item instance ID (use 0 for non-instanced/stackable items)'),
        stackSize: num('Quantity to transfer (default 1)'),
        transferToVault: bool('true = move to vault, false = move to character'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['itemReferenceHash', 'itemId', 'transferToVault', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.transferItem({
        itemReferenceHash: a.itemReferenceHash as number,
        itemId: a.itemId as string,
        stackSize: (a.stackSize as number) ?? 1,
        transferToVault: a.transferToVault as boolean,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'pull_from_postmaster',
    '[auth][write] Pull an item from the Postmaster to a character',
    {
      properties: {
        itemReferenceHash: num('Item hash of the item to pull'),
        itemId: str('Item instance ID (0 for stackable)'),
        stackSize: num('Quantity (default 1)'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['itemReferenceHash', 'itemId', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.pullFromPostmaster({
        itemReferenceHash: a.itemReferenceHash as number,
        itemId: a.itemId as string,
        stackSize: (a.stackSize as number) ?? 1,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'equip_item',
    '[auth][write] Equip a single item on a character (character must not be in an activity)',
    {
      properties: {
        itemId: str('Item instance ID to equip'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['itemId', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.equipItem({
        itemId: a.itemId as string,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'equip_items',
    '[auth][write] Equip multiple items on a character at once',
    {
      properties: {
        itemIds: strArr('Item instance IDs to equip'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['itemIds', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.equipItems({
        itemIds: a.itemIds as string[],
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'set_item_lock_state',
    '[auth][write] Lock or unlock an item',
    {
      properties: {
        state: bool('true = locked, false = unlocked'),
        itemId: str('Item instance ID'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['state', 'itemId', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.setItemLockState({
        state: a.state as boolean,
        itemId: a.itemId as string,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'set_quest_tracked_state',
    '[auth][write] Track or untrack a quest/objective item',
    {
      properties: {
        state: bool('true = tracked, false = untracked'),
        itemId: str('Item instance ID of the quest'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['state', 'itemId', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.setQuestTrackedState({
        state: a.state as boolean,
        itemId: a.itemId as string,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'insert_socket_plug_free',
    '[auth][write] Insert a plug (mod/shader/perk) into an item socket (only plugs you own)',
    {
      properties: {
        itemId: str('Item instance ID to modify'),
        socketIndex: num('Socket index to change'),
        plugItemHash: num('Plug item hash to insert'),
        socketArrayType: num('Socket array type (0=Default, default 0)'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['itemId', 'socketIndex', 'plugItemHash', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.insertSocketPlugFree({
        plug: {
          socketIndex: a.socketIndex as number,
          socketArrayType: (a.socketArrayType as number) ?? 0,
          plugItemHash: a.plugItemHash as number,
        },
        itemId: a.itemId as string,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'equip_loadout',
    "[auth][write] Equip one of a character's saved loadouts by index (0-9)",
    {
      properties: {
        loadoutIndex: num('Loadout slot index (0-9)'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['loadoutIndex', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.equipLoadout({
        loadoutIndex: a.loadoutIndex as number,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'snapshot_loadout',
    "[auth][write] Save the character's current equipment into a loadout slot",
    {
      properties: {
        loadoutIndex: num('Loadout slot index (0-9) to overwrite'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
        colorHash: num('Optional loadout color hash'),
        iconHash: num('Optional loadout icon hash'),
        nameHash: num('Optional loadout name hash'),
      },
      required: ['loadoutIndex', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.snapshotLoadout({
        loadoutIndex: a.loadoutIndex as number,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
        colorHash: a.colorHash as number | undefined,
        iconHash: a.iconHash as number | undefined,
        nameHash: a.nameHash as number | undefined,
      }),
    { write: true }
  ),

  tool(
    'clear_loadout',
    '[auth][write] Clear a saved loadout slot',
    {
      properties: {
        loadoutIndex: num('Loadout slot index (0-9) to clear'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
      },
      required: ['loadoutIndex', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.clearLoadout({
        loadoutIndex: a.loadoutIndex as number,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
      }),
    { write: true }
  ),

  tool(
    'update_loadout_identifiers',
    "[auth][write] Update a loadout's name/color/icon without changing its equipment",
    {
      properties: {
        loadoutIndex: num('Loadout slot index (0-9)'),
        characterId: fields.characterId(),
        membershipType: fields.membershipType(),
        colorHash: num('Loadout color hash'),
        iconHash: num('Loadout icon hash'),
        nameHash: num('Loadout name hash'),
      },
      required: ['loadoutIndex', 'characterId', 'membershipType'],
    },
    (ctx, a) =>
      ctx.api.updateLoadoutIdentifiers({
        loadoutIndex: a.loadoutIndex as number,
        characterId: a.characterId as string,
        membershipType: a.membershipType as number,
        colorHash: a.colorHash as number | undefined,
        iconHash: a.iconHash as number | undefined,
        nameHash: a.nameHash as number | undefined,
      }),
    { write: true }
  ),

  tool(
    'get_collectible_node_details',
    'Get collectible (e.g. weapon/armor unlock) state under a presentation node for a character',
    {
      properties: {
        membershipType: fields.membershipType(),
        membershipId: fields.membershipId(),
        characterId: fields.characterId(),
        collectiblePresentationNodeHash: num('Presentation node hash to inspect'),
        components: numArr('Components (default [800] Collectibles)'),
      },
      required: [
        'membershipType',
        'membershipId',
        'characterId',
        'collectiblePresentationNodeHash',
      ],
    },
    (ctx, a) =>
      ctx.api.getCollectibleNodeDetails(
        a.membershipType as number,
        a.membershipId as string,
        a.characterId as string,
        a.collectiblePresentationNodeHash as number,
        (a.components as number[]) ?? [800]
      )
  ),

  tool(
    'awa_initialize_request',
    '[auth][write] Begin an Advanced Write Action (out-of-band approval required in-game/companion app)',
    {
      properties: {
        type: num('AWA action type (e.g. 1=InsertPlugs)'),
        membershipType: fields.membershipType(),
        characterId: fields.characterId(),
        affectedItemId: str('Item instance ID the action affects (optional)'),
      },
      required: ['type', 'membershipType', 'characterId'],
    },
    (ctx, a) =>
      ctx.api.awaInitializeRequest({
        type: a.type as number,
        membershipType: a.membershipType as number,
        characterId: a.characterId as string,
        affectedItemId: a.affectedItemId as string | undefined,
      }),
    { write: true }
  ),

  tool(
    'awa_get_action_token',
    '[auth] Retrieve the action token after an AWA request has been approved by the user',
    {
      properties: { correlationId: str('Correlation ID from awa_initialize_request') },
      required: ['correlationId'],
    },
    (ctx, a) => ctx.api.awaGetActionToken(a.correlationId as string)
  ),
];
