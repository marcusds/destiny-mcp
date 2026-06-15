import { ToolDef, tool, num, str } from './registry.js';

/** Bungie.net friends list and friend-request management (all OAuth). */
export const socialTools: ToolDef[] = [
  tool(
    'get_friend_list',
    "[auth] Get the authenticated user's Bungie.net friends list",
    { properties: {} },
    (ctx) => ctx.api.getFriendList()
  ),

  tool(
    'get_friend_request_list',
    '[auth] Get incoming/outgoing Bungie.net friend requests',
    { properties: {} },
    (ctx) => ctx.api.getFriendRequestList()
  ),

  tool(
    'issue_friend_request',
    '[auth][write] Send a Bungie.net friend request to a user (by any of their membership IDs)',
    {
      properties: { membershipId: str('Target Bungie.net/Destiny membership ID') },
      required: ['membershipId'],
    },
    (ctx, a) => ctx.api.issueFriendRequest(a.membershipId as string),
    { write: true }
  ),

  tool(
    'accept_friend_request',
    '[auth][write] Accept a pending Bungie.net friend request',
    {
      properties: { membershipId: str('Requesting user membership ID') },
      required: ['membershipId'],
    },
    (ctx, a) => ctx.api.acceptFriendRequest(a.membershipId as string),
    { write: true }
  ),

  tool(
    'decline_friend_request',
    '[auth][write] Decline a pending Bungie.net friend request',
    {
      properties: { membershipId: str('Requesting user membership ID') },
      required: ['membershipId'],
    },
    (ctx, a) => ctx.api.declineFriendRequest(a.membershipId as string),
    { write: true }
  ),

  tool(
    'remove_friend',
    '[auth][write] Remove a user from the Bungie.net friends list',
    {
      properties: { membershipId: str('Friend membership ID to remove') },
      required: ['membershipId'],
    },
    (ctx, a) => ctx.api.removeFriend(a.membershipId as string),
    { write: true }
  ),

  tool(
    'remove_friend_request',
    '[auth][write] Cancel an outgoing Bungie.net friend request',
    { properties: { membershipId: str('Target membership ID') }, required: ['membershipId'] },
    (ctx, a) => ctx.api.removeFriendRequest(a.membershipId as string),
    { write: true }
  ),

  tool(
    'get_platform_friend_list',
    'Get a platform (e.g. Steam) friends list by platform type',
    {
      properties: {
        friendPlatform: num('Friend platform type (1=Xbox, 2=PSN, 3=Steam)'),
        page: num('Page number (0-based)'),
      },
      required: ['friendPlatform'],
    },
    (ctx, a) => ctx.api.getPlatformFriendList(a.friendPlatform as number, (a.page as number) ?? 0)
  ),
];
