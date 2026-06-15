// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BungieConfig {
  apiKey: string;
  baseUrl: string;
  /** OAuth client id (numeric). Required only for authenticated tools. */
  clientId?: string;
  /** OAuth client secret (confidential apps). Omit for public clients. */
  clientSecret?: string;
  /**
   * Redirect URL registered with the Bungie application. Must match exactly.
   * Defaults to http://localhost:<oauthPort>/callback for the built-in flow.
   */
  redirectUri?: string;
  /** Local port the OAuth callback listener binds to. Default 7777. */
  oauthPort?: number;
  /** Directory used to persist tokens and the cached manifest. */
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** Raw token payload as returned by Bungie's token endpoint. */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  membership_id: string;
}

/** Tokens as we persist them, with absolute expiry timestamps (ms epoch). */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  membershipId: string;
  /** ms epoch when the access token expires. */
  accessExpiresAt: number;
  /** ms epoch when the refresh token expires (if known). */
  refreshExpiresAt?: number;
}

// ---------------------------------------------------------------------------
// Platform / membership types
// ---------------------------------------------------------------------------

export enum BungieMembershipType {
  None = 0,
  Xbox = 1,
  PSN = 2,
  Steam = 3,
  Blizzard = 4,
  Stadia = 5,
  Epic = 6,
  Demon = 10,
  BungieNext = 254,
  All = -1,
}

// ---------------------------------------------------------------------------
// Lightweight response shapes (most endpoints return `any` — these are the
// ones the typed methods lean on).
// ---------------------------------------------------------------------------

export interface BungieResponse<T = unknown> {
  Response: T;
  ErrorCode: number;
  ThrottleSeconds: number;
  ErrorStatus: string;
  Message: string;
  MessageData: Record<string, string>;
}

export interface DestinyProfile {
  Response: {
    profile?: {
      data?: {
        userInfo: {
          membershipType: number;
          membershipId: string;
          displayName: string;
        };
        dateLastPlayed: string;
        versionsOwned: number;
        characterIds: string[];
      };
    };
    characters?: {
      data?: Record<string, any>;
    };
  };
}
