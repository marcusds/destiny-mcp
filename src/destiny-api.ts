import axios, { AxiosInstance } from 'axios';
import { BungieConfig } from './types.js';
import { RateLimiter } from './rate-limiter.js';
import { BungieAuth } from './auth.js';

/**
 * Thin, typed wrapper over the Bungie.net Platform API.
 *
 * Two request paths share rate limiting and error handling:
 *   - makePublicRequest:  X-API-Key only (public reads)
 *   - makeAuthRequest:     X-API-Key + Bearer token (authenticated reads/writes)
 */
export class DestinyAPI {
  private client: AxiosInstance;
  private config: BungieConfig;
  private rateLimiter: RateLimiter;
  private auth: BungieAuth;

  constructor(config: BungieConfig, auth: BungieAuth) {
    this.config = config;
    this.auth = auth;
    this.rateLimiter = new RateLimiter(25, 10000);
    this.client = axios.create({
      baseURL: config.baseUrl || 'https://www.bungie.net/Platform',
      headers: { 'X-API-Key': config.apiKey },
    });
  }

  // -- Core request plumbing ----------------------------------------------

  private async makePublicRequest(url: string, params?: any): Promise<any> {
    return this.request('get', url, { params });
  }

  /**
   * GET that opportunistically attaches a Bearer token when authenticated.
   * Public profiles work without it; private profiles / a user's own full
   * inventory return more data when a token is present.
   */
  private async makeReadRequest(url: string, params?: any): Promise<any> {
    const token = await this.auth.getAccessTokenIfAuthed();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    return this.request('get', url, { params, headers });
  }

  /** Authenticated GET/POST. Injects a fresh Bearer token, refreshing if needed. */
  private async makeAuthRequest(
    method: 'get' | 'post',
    url: string,
    opts: { params?: any; data?: any } = {}
  ): Promise<any> {
    const token = await this.auth.getValidAccessToken();
    return this.request(method, url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async request(
    method: 'get' | 'post',
    url: string,
    opts: { params?: any; data?: any; headers?: Record<string, string> } = {}
  ): Promise<any> {
    await this.rateLimiter.acquire();
    try {
      const response = await this.client.request({
        method,
        url,
        params: opts.params,
        data: opts.data,
        headers: opts.headers,
      });

      if (response.data?.ErrorCode !== undefined && response.data.ErrorCode !== 1) {
        throw new Error(
          `Bungie API Error ${response.data.ErrorCode} (${response.data.ErrorStatus}): ${response.data.Message}`
        );
      }
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        const apiMsg: string | undefined = data?.Message;
        const apiCode: number | undefined = data?.ErrorCode;
        // Bungie returns HTTP 500 for many *gameplay* errors (e.g. equipping
        // while in an activity) with a meaningful ErrorCode/Message in the body.
        // Surface that first rather than masking it as a generic server error.
        if (apiMsg && apiCode !== undefined && apiCode !== 1) {
          throw new Error(`Bungie API Error ${apiCode} (${data?.ErrorStatus}): ${apiMsg}`);
        }
        if (status === 401) {
          throw new Error('Unauthorized — token invalid/expired. Re-run `d2-mcp auth`.');
        }
        if (status === 429) {
          throw new Error('Rate limit exceeded. Please wait before retrying.');
        }
        if (status && status >= 500) {
          throw new Error('Bungie API server error. Please try again later.');
        }
        if (apiMsg) throw new Error(`Bungie API Error: ${apiMsg}`);
      }
      throw error;
    }
  }

  private static components(components: number[]): string {
    return components.join(',');
  }

  // =======================================================================
  // PUBLIC READS
  // =======================================================================

  getProfile(membershipType: number, membershipId: string, components: number[] = [100, 200]) {
    return this.makeReadRequest(`/Destiny2/${membershipType}/Profile/${membershipId}/`, {
      components: DestinyAPI.components(components),
    });
  }

  /**
   * Minimal component set for an inventory snapshot: characters (200),
   * profile/vault inventory (102), character inventories (201), equipment (205).
   * Auth-aware so a logged-in user's full private inventory resolves.
   */
  getInventoryProfile(membershipType: number, membershipId: string) {
    return this.makeReadRequest(`/Destiny2/${membershipType}/Profile/${membershipId}/`, {
      components: '200,102,201,205',
    });
  }

  /** Profile with armor item lists + per-instance stats/tier/energy for stat optimization. */
  getArmorProfile(membershipType: number, membershipId: string) {
    return this.makeReadRequest(`/Destiny2/${membershipType}/Profile/${membershipId}/`, {
      components: '200,102,201,205,300,304',
    });
  }

  /** Character loadout slots (component 206). */
  getCharacterLoadouts(membershipType: number, membershipId: string) {
    return this.makeReadRequest(`/Destiny2/${membershipType}/Profile/${membershipId}/`, {
      components: '206',
    });
  }

  getCharacter(
    membershipType: number,
    membershipId: string,
    characterId: string,
    components: number[] = [200]
  ) {
    return this.makeReadRequest(
      `/Destiny2/${membershipType}/Profile/${membershipId}/Character/${characterId}/`,
      { components: DestinyAPI.components(components) }
    );
  }

  getItem(
    membershipType: number,
    membershipId: string,
    itemInstanceId: string,
    components: number[] = [300, 302, 304, 305]
  ) {
    return this.makeReadRequest(
      `/Destiny2/${membershipType}/Profile/${membershipId}/Item/${itemInstanceId}/`,
      { components: DestinyAPI.components(components) }
    );
  }

  searchDestinyPlayer(membershipType: number, displayName: string) {
    return this.makePublicRequest(
      `/Destiny2/SearchDestinyPlayer/${membershipType}/${encodeURIComponent(displayName)}/`
    );
  }

  searchDestinyPlayerByBungieName(
    membershipType: number,
    displayName: string,
    displayNameCode: number
  ) {
    return this.request('post', `/Destiny2/SearchDestinyPlayerByBungieName/${membershipType}/`, {
      data: { displayName, displayNameCode },
    });
  }

  getLinkedProfiles(membershipType: number, membershipId: string, getAllMemberships = true) {
    return this.makePublicRequest(
      `/Destiny2/${membershipType}/Profile/${membershipId}/LinkedProfiles/`,
      { getAllMemberships }
    );
  }

  getActivityHistory(
    membershipType: number,
    membershipId: string,
    characterId: string,
    count = 25,
    mode?: number,
    page?: number
  ) {
    const params: any = { count };
    if (mode !== undefined) params.mode = mode;
    if (page !== undefined) params.page = page;
    return this.makePublicRequest(
      `/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/Activities/`,
      params
    );
  }

  getHistoricalStats(
    membershipType: number,
    membershipId: string,
    characterId: string,
    periodType?: number,
    modes?: number[],
    groups?: number[]
  ) {
    const params: any = {};
    if (periodType !== undefined) params.periodType = periodType;
    if (modes?.length) params.modes = modes.join(',');
    if (groups?.length) params.groups = groups.join(',');
    return this.makePublicRequest(
      `/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/`,
      params
    );
  }

  /** Account-wide historical stats (merged across characters). */
  getHistoricalStatsForAccount(membershipType: number, membershipId: string, groups?: number[]) {
    const params: any = {};
    if (groups?.length) params.groups = groups.join(',');
    return this.makePublicRequest(
      `/Destiny2/${membershipType}/Account/${membershipId}/Stats/`,
      params
    );
  }

  getDestinyAggregateActivityStats(
    membershipType: number,
    membershipId: string,
    characterId: string
  ) {
    return this.makePublicRequest(
      `/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/AggregateActivityStats/`
    );
  }

  getUniqueWeaponHistory(membershipType: number, membershipId: string, characterId: string) {
    return this.makePublicRequest(
      `/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/UniqueWeapons/`
    );
  }

  getLeaderboards(
    membershipType: number,
    membershipId: string,
    maxtop?: number,
    modes?: string,
    statid?: string
  ) {
    const params: any = {};
    if (maxtop !== undefined) params.maxtop = maxtop;
    if (modes) params.modes = modes;
    if (statid) params.statid = statid;
    return this.makePublicRequest(
      `/Destiny2/Stats/Leaderboards/${membershipType}/${membershipId}/`,
      params
    );
  }

  getPostGameCarnageReport(activityId: string) {
    return this.makePublicRequest(`/Destiny2/Stats/PostGameCarnageReport/${activityId}/`);
  }

  getManifest() {
    return this.makePublicRequest('/Destiny2/Manifest/');
  }

  getDestinyEntityDefinition(entityType: string, hashIdentifier: number) {
    return this.makePublicRequest(`/Destiny2/Manifest/${entityType}/${hashIdentifier}/`);
  }

  getPublicMilestones() {
    return this.makePublicRequest('/Destiny2/Milestones/');
  }

  getPublicMilestoneContent(milestoneHash: number) {
    return this.makePublicRequest(`/Destiny2/Milestones/${milestoneHash}/Content/`);
  }

  getPublicVendors(components: number[] = [400, 401, 402]) {
    return this.makePublicRequest('/Destiny2/Vendors/', {
      components: DestinyAPI.components(components),
    });
  }

  // =======================================================================
  // USER
  // =======================================================================

  getBungieNetUserById(membershipId: string) {
    return this.makePublicRequest(`/User/GetBungieNetUserById/${membershipId}/`);
  }

  getMembershipDataById(membershipId: string, membershipType: number) {
    return this.makePublicRequest(`/User/GetMembershipsById/${membershipId}/${membershipType}/`);
  }

  /** Resolve players by Bungie name prefix (paged). */
  searchByGlobalNamePrefix(displayNamePrefix: string, page = 0) {
    return this.request('post', `/User/Search/GlobalName/${page}/`, {
      data: { displayNamePrefix },
    });
  }

  // =======================================================================
  // CLANS (GroupV2) — public reads
  // =======================================================================

  getGroup(groupId: string) {
    return this.makePublicRequest(`/GroupV2/${groupId}/`);
  }

  getGroupByName(groupName: string, groupType = 1) {
    return this.makePublicRequest(`/GroupV2/Name/${encodeURIComponent(groupName)}/${groupType}/`);
  }

  getMembersOfGroup(groupId: string, currentpage = 1, memberType?: number, nameSearch?: string) {
    const params: any = { currentpage: Math.max(1, Math.floor(currentpage) || 1) };
    if (memberType !== undefined) params.memberType = memberType;
    if (nameSearch) params.nameSearch = nameSearch;
    return this.makePublicRequest(`/GroupV2/${groupId}/Members/`, params);
  }

  getAdminsAndFounderOfGroup(groupId: string, currentpage = 1) {
    return this.makePublicRequest(`/GroupV2/${groupId}/AdminsAndFounder/`, { currentpage });
  }

  getGroupsForMember(membershipType: number, membershipId: string, filter = 0, groupType = 1) {
    return this.makePublicRequest(
      `/GroupV2/User/${membershipType}/${membershipId}/${filter}/${groupType}/`
    );
  }

  getClanWeeklyRewardState(groupId: string) {
    return this.makePublicRequest(`/Destiny2/Clan/${groupId}/WeeklyRewardState/`);
  }

  getClanBannerSource() {
    return this.makePublicRequest('/Destiny2/Clan/ClanBannerDictionary/');
  }

  // =======================================================================
  // AUTHENTICATED READS
  // =======================================================================

  /** Who am I — memberships for the authenticated Bungie.net account. */
  getMembershipsForCurrentUser() {
    return this.makeAuthRequest('get', '/User/GetMembershipsForCurrentUser/');
  }

  /** Live vendor inventories for one of your characters (requires auth). */
  getVendors(
    membershipType: number,
    membershipId: string,
    characterId: string,
    components: number[] = [400, 401, 402]
  ) {
    return this.makeAuthRequest(
      'get',
      `/Destiny2/${membershipType}/Profile/${membershipId}/Character/${characterId}/Vendors/`,
      { params: { components: DestinyAPI.components(components) } }
    );
  }

  getVendor(
    membershipType: number,
    membershipId: string,
    characterId: string,
    vendorHash: number,
    components: number[] = [400, 401, 402]
  ) {
    return this.makeAuthRequest(
      'get',
      `/Destiny2/${membershipType}/Profile/${membershipId}/Character/${characterId}/Vendors/${vendorHash}/`,
      { params: { components: DestinyAPI.components(components) } }
    );
  }

  getPendingMemberships(groupId: string, currentpage = 1) {
    return this.makeAuthRequest('get', `/GroupV2/${groupId}/Members/Pending/`, {
      params: { currentpage },
    });
  }

  // =======================================================================
  // AUTHENTICATED WRITE ACTIONS (Destiny2/Actions)
  // =======================================================================

  transferItem(args: {
    itemReferenceHash: number;
    stackSize: number;
    transferToVault: boolean;
    itemId: string;
    characterId: string;
    membershipType: number;
  }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Items/TransferItem/', { data: args });
  }

  pullFromPostmaster(args: {
    itemReferenceHash: number;
    stackSize: number;
    itemId: string;
    characterId: string;
    membershipType: number;
  }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Items/PullFromPostmaster/', {
      data: args,
    });
  }

  equipItem(args: { itemId: string; characterId: string; membershipType: number }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Items/EquipItem/', { data: args });
  }

  equipItems(args: { itemIds: string[]; characterId: string; membershipType: number }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Items/EquipItems/', { data: args });
  }

  setItemLockState(args: {
    state: boolean;
    itemId: string;
    characterId: string;
    membershipType: number;
  }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Items/SetLockState/', { data: args });
  }

  setQuestTrackedState(args: {
    state: boolean;
    itemId: string;
    characterId: string;
    membershipType: number;
  }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Items/SetTrackedState/', {
      data: args,
    });
  }

  /** Per-item promise chain so concurrent plug writes to ONE item can't race
   * (Bungie applies them serially anyway; parallel client calls otherwise read
   * the same pre-write socket state and collide on the same socket). */
  #plugWriteChain = new Map<string, Promise<unknown>>();

  insertSocketPlugFree(args: {
    plug: { socketIndex: number; socketArrayType: number; plugItemHash: number };
    itemId: string;
    characterId: string;
    membershipType: number;
  }) {
    const key = args.itemId;
    const prev = this.#plugWriteChain.get(key) ?? Promise.resolve();
    // Run after any in-flight write to the same item; a prior failure must not
    // break the chain for subsequent writes.
    const run = prev
      .catch(() => undefined)
      .then(() =>
        this.makeAuthRequest('post', '/Destiny2/Actions/Items/InsertSocketPlugFree/', {
          data: args,
        })
      );
    const settled = run.catch(() => undefined);
    this.#plugWriteChain.set(key, settled);
    // Drop the entry once it's the tail and has settled, to bound the map size.
    void settled.then(() => {
      if (this.#plugWriteChain.get(key) === settled) this.#plugWriteChain.delete(key);
    });
    return run;
  }

  equipLoadout(args: { loadoutIndex: number; characterId: string; membershipType: number }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Loadouts/EquipLoadout/', {
      data: args,
    });
  }

  snapshotLoadout(args: {
    loadoutIndex: number;
    characterId: string;
    membershipType: number;
    colorHash?: number;
    iconHash?: number;
    nameHash?: number;
  }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Loadouts/SnapshotLoadout/', {
      data: args,
    });
  }

  // -- Clan management writes ---------------------------------------------

  inviteMemberToGroup(groupId: string, membershipType: number, membershipId: string, message = '') {
    return this.makeAuthRequest(
      'post',
      `/GroupV2/${groupId}/Members/IndividualInvite/${membershipType}/${membershipId}/`,
      { data: { message } }
    );
  }

  kickMember(groupId: string, membershipType: number, membershipId: string) {
    return this.makeAuthRequest(
      'post',
      `/GroupV2/${groupId}/Members/${membershipType}/${membershipId}/Kick/`
    );
  }

  banMember(
    groupId: string,
    membershipType: number,
    membershipId: string,
    comment = '',
    length = 0
  ) {
    return this.makeAuthRequest(
      'post',
      `/GroupV2/${groupId}/Members/${membershipType}/${membershipId}/Ban/`,
      { data: { comment, length } }
    );
  }

  unbanMember(groupId: string, membershipType: number, membershipId: string) {
    return this.makeAuthRequest(
      'post',
      `/GroupV2/${groupId}/Members/${membershipType}/${membershipId}/Unban/`
    );
  }

  approvePending(groupId: string, membershipType: number, membershipId: string, message = '') {
    return this.makeAuthRequest(
      'post',
      `/GroupV2/${groupId}/Members/Approve/${membershipType}/${membershipId}/`,
      { data: { message } }
    );
  }

  // -- GroupV2: additional reads & admin ----------------------------------

  groupSearch(query: {
    name: string;
    groupType?: number;
    sortBy?: number;
    itemsPerPage?: number;
    currentPage?: number;
    tagText?: string;
  }) {
    return this.request('post', '/GroupV2/Search/', {
      data: { groupType: 1, currentPage: 0, ...query },
    });
  }

  editGroup(groupId: string, edits: Record<string, unknown>) {
    return this.makeAuthRequest('post', `/GroupV2/${groupId}/Edit/`, { data: edits });
  }

  editClanBanner(groupId: string, banner: Record<string, number>) {
    return this.makeAuthRequest('post', `/GroupV2/${groupId}/EditClanBanner/`, { data: banner });
  }

  getBannedMembersOfGroup(groupId: string, currentpage = 1) {
    return this.makeAuthRequest('get', `/GroupV2/${groupId}/Banned/`, { params: { currentpage } });
  }

  getInvitedIndividuals(groupId: string, currentpage = 1) {
    return this.makeAuthRequest('get', `/GroupV2/${groupId}/Members/InvitedIndividuals/`, {
      params: { currentpage },
    });
  }

  approveAllPending(groupId: string, message = '') {
    return this.makeAuthRequest('post', `/GroupV2/${groupId}/Members/ApproveAll/`, {
      data: { message },
    });
  }

  denyAllPending(groupId: string, message = '') {
    return this.makeAuthRequest('post', `/GroupV2/${groupId}/Members/DenyAll/`, {
      data: { message },
    });
  }

  getPotentialGroupsForMember(
    membershipType: number,
    membershipId: string,
    filter = 0,
    groupType = 1
  ) {
    return this.makePublicRequest(
      `/GroupV2/User/Potential/${membershipType}/${membershipId}/${filter}/${groupType}/`
    );
  }

  // =======================================================================
  // SOCIAL / FRIENDS (all require auth except platform friends)
  // =======================================================================

  getFriendList() {
    return this.makeAuthRequest('get', '/Social/Friends/');
  }

  getFriendRequestList() {
    return this.makeAuthRequest('get', '/Social/Friends/Requests/');
  }

  issueFriendRequest(membershipId: string) {
    return this.makeAuthRequest('post', `/Social/Friends/Add/${membershipId}/`);
  }

  acceptFriendRequest(membershipId: string) {
    return this.makeAuthRequest('post', `/Social/Friends/Requests/Accept/${membershipId}/`);
  }

  declineFriendRequest(membershipId: string) {
    return this.makeAuthRequest('post', `/Social/Friends/Requests/Decline/${membershipId}/`);
  }

  removeFriend(membershipId: string) {
    return this.makeAuthRequest('post', `/Social/Friends/Remove/${membershipId}/`);
  }

  removeFriendRequest(membershipId: string) {
    return this.makeAuthRequest('post', `/Social/Friends/Requests/Remove/${membershipId}/`);
  }

  getPlatformFriendList(friendPlatform: number, page = 0) {
    return this.makePublicRequest(`/Social/PlatformFriends/${friendPlatform}/${page}/`);
  }

  // =======================================================================
  // DESTINY2 — niche reads
  // =======================================================================

  searchDestinyEntities(type: string, searchTerm: string, page = 0) {
    return this.makePublicRequest(
      `/Destiny2/Armory/Search/${type}/${encodeURIComponent(searchTerm)}/`,
      { page }
    );
  }

  getCollectibleNodeDetails(
    membershipType: number,
    membershipId: string,
    characterId: string,
    collectiblePresentationNodeHash: number,
    components: number[] = [800]
  ) {
    return this.makeReadRequest(
      `/Destiny2/${membershipType}/Profile/${membershipId}/Character/${characterId}/Collectibles/${collectiblePresentationNodeHash}/`,
      { components: DestinyAPI.components(components) }
    );
  }

  getClanLeaderboards(groupId: string, maxtop?: number, modes?: string, statid?: string) {
    const params: any = {};
    if (maxtop !== undefined) params.maxtop = maxtop;
    if (modes) params.modes = modes;
    if (statid) params.statid = statid;
    return this.makePublicRequest(`/Destiny2/Stats/Leaderboards/Clans/${groupId}/`, params);
  }

  getClanAggregateStats(groupId: string, modes?: string) {
    const params: any = {};
    if (modes) params.modes = modes;
    return this.makePublicRequest(`/Destiny2/Stats/AggregateClanStats/${groupId}/`, params);
  }

  getLeaderboardsForCharacter(
    membershipType: number,
    membershipId: string,
    characterId: string,
    maxtop?: number,
    modes?: string,
    statid?: string
  ) {
    const params: any = {};
    if (maxtop !== undefined) params.maxtop = maxtop;
    if (modes) params.modes = modes;
    if (statid) params.statid = statid;
    return this.makePublicRequest(
      `/Destiny2/Stats/Leaderboards/${membershipType}/${membershipId}/${characterId}/`,
      params
    );
  }

  getHistoricalStatsDefinition() {
    return this.makePublicRequest('/Destiny2/Stats/Definition/');
  }

  reportPostGameCarnageReportPlayer(
    activityId: string,
    args: { reasonCategoryHashes: number[]; reasonHashes: number[]; offendingCharacterId: string }
  ) {
    return this.makeAuthRequest(
      'post',
      `/Destiny2/Stats/PostGameCarnageReport/${activityId}/Report/`,
      { data: args }
    );
  }

  // -- Loadout identifier writes ------------------------------------------

  clearLoadout(args: { loadoutIndex: number; characterId: string; membershipType: number }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Loadouts/ClearLoadout/', { data: args });
  }

  updateLoadoutIdentifiers(args: {
    loadoutIndex: number;
    characterId: string;
    membershipType: number;
    colorHash?: number;
    iconHash?: number;
    nameHash?: number;
  }) {
    return this.makeAuthRequest('post', '/Destiny2/Actions/Loadouts/UpdateLoadoutIdentifiers/', {
      data: args,
    });
  }

  // -- AWA (Advanced Write Actions) — out-of-band approval flow -----------

  awaInitializeRequest(args: {
    type: number;
    affectedItemId?: string;
    membershipType: number;
    characterId: string;
  }) {
    return this.makeAuthRequest('post', '/Destiny2/Awa/Initialize/', { data: args });
  }

  awaGetActionToken(correlationId: string) {
    return this.makeAuthRequest('get', `/Destiny2/Awa/GetActionToken/${correlationId}/`);
  }
}
