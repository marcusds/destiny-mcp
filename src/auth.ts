import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as readline from 'readline';
import { URL } from 'url';
import { BungieConfig, OAuthTokenResponse, StoredTokens } from './types.js';

const BUNGIE_AUTHORIZE_URL = 'https://www.bungie.net/en/OAuth/Authorize';
const BUNGIE_TOKEN_URL = 'https://www.bungie.net/Platform/App/OAuth/token/';

/** Refresh the access token this many ms before it actually expires. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Handles the Bungie OAuth 2.0 authorization-code flow with:
 *  - on-disk token persistence (survives restarts),
 *  - correct absolute-timestamp expiry tracking (the original code compared
 *    `now` against `expires_in`, a duration, so it always reported expired),
 *  - automatic refresh when the access token is stale,
 *  - a local HTTP callback listener with a manual-paste fallback.
 */
export class BungieAuth {
  private config: BungieConfig;
  private tokens: StoredTokens | null = null;
  private readonly tokenPath: string;

  constructor(config: BungieConfig) {
    this.config = config;
    this.tokenPath = path.join(config.dataDir!, 'tokens.json');
    this.loadTokens();
  }

  // -- Persistence ---------------------------------------------------------

  private loadTokens(): void {
    try {
      if (fs.existsSync(this.tokenPath)) {
        this.tokens = JSON.parse(fs.readFileSync(this.tokenPath, 'utf-8'));
      }
    } catch {
      this.tokens = null;
    }
  }

  private saveTokens(): void {
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    fs.writeFileSync(this.tokenPath, JSON.stringify(this.tokens, null, 2), {
      mode: 0o600,
    });
  }

  private store(raw: OAuthTokenResponse): StoredTokens {
    const now = Date.now();
    this.tokens = {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      tokenType: raw.token_type || 'Bearer',
      membershipId: raw.membership_id,
      accessExpiresAt: now + raw.expires_in * 1000,
      refreshExpiresAt: raw.refresh_expires_in ? now + raw.refresh_expires_in * 1000 : undefined,
    };
    this.saveTokens();
    return this.tokens;
  }

  // -- State -------------------------------------------------------------

  /** Re-read tokens from disk if we don't have them in memory yet. Lets a
   * long-running process pick up a login performed by a separate `auth` run. */
  private ensureLoaded(): void {
    if (!this.tokens) this.loadTokens();
  }

  isAuthenticated(): boolean {
    this.ensureLoaded();
    return this.tokens !== null;
  }

  /** Membership id of the authenticated Bungie.net account, if any. */
  getMembershipId(): string | null {
    this.ensureLoaded();
    return this.tokens?.membershipId ?? null;
  }

  private accessTokenExpired(): boolean {
    if (!this.tokens) return true;
    return Date.now() >= this.tokens.accessExpiresAt - EXPIRY_SKEW_MS;
  }

  private refreshTokenExpired(): boolean {
    if (!this.tokens?.refreshToken) return true;
    if (this.tokens.refreshExpiresAt === undefined) return false;
    return Date.now() >= this.tokens.refreshExpiresAt;
  }

  // -- Authorization-code flow -------------------------------------------

  getAuthorizationUrl(state: string): string {
    if (!this.config.clientId) {
      throw new Error('BUNGIE_CLIENT_ID is required for OAuth.');
    }
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      state,
    });
    // redirect_uri is optional on the authorize call (Bungie uses the value
    // registered on the app) but we include it when provided for clarity.
    if (this.config.redirectUri) {
      params.set('redirect_uri', this.config.redirectUri);
    }
    return `${BUNGIE_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCodeForToken(authCode: string): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: this.config.clientId!,
    });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);
    if (this.config.redirectUri) body.set('redirect_uri', this.config.redirectUri);

    try {
      const { data } = await axios.post<OAuthTokenResponse>(BUNGIE_TOKEN_URL, body.toString(), {
        headers: this.tokenHeaders(),
      });
      return this.store(data);
    } catch (error) {
      throw new Error(`OAuth token exchange failed: ${describeAxiosError(error)}`);
    }
  }

  private async refresh(): Promise<StoredTokens> {
    if (this.refreshTokenExpired()) {
      throw new Error('Refresh token missing or expired — re-run `d2-mcp auth`.');
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens!.refreshToken!,
      client_id: this.config.clientId!,
    });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);

    try {
      const { data } = await axios.post<OAuthTokenResponse>(BUNGIE_TOKEN_URL, body.toString(), {
        headers: this.tokenHeaders(),
      });
      return this.store(data);
    } catch (error) {
      throw new Error(`Token refresh failed: ${describeAxiosError(error)}`);
    }
  }

  /**
   * Returns a valid access token, transparently refreshing if needed.
   * Throws a clear, actionable error if the user has never authenticated.
   */
  async getValidAccessToken(): Promise<string> {
    this.ensureLoaded();
    if (!this.tokens) {
      throw new Error('Not authenticated. Run `d2-mcp auth` (or the `authenticate` tool) first.');
    }
    if (this.accessTokenExpired()) {
      await this.refresh();
    }
    return this.tokens!.accessToken;
  }

  /**
   * Returns a valid access token if the user is authenticated, otherwise null.
   * Never throws — used by reads that work both publicly and authenticated
   * (e.g. a private profile returns more data when a token is attached).
   */
  async getAccessTokenIfAuthed(): Promise<string | null> {
    this.ensureLoaded();
    if (!this.tokens) return null;
    try {
      if (this.accessTokenExpired()) await this.refresh();
      return this.tokens.accessToken;
    } catch {
      return null;
    }
  }

  private tokenHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-API-Key': this.config.apiKey,
    };
    // Confidential clients may authenticate via HTTP Basic instead of body.
    if (this.config.clientId && this.config.clientSecret) {
      const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
        'base64'
      );
      headers['Authorization'] = `Basic ${basic}`;
    }
    return headers;
  }

  // -- Interactive login --------------------------------------------------

  /**
   * Full interactive login: prints the authorize URL, then waits for the
   * authorization code via a local callback server OR a pasted redirect URL —
   * whichever arrives first. Returns once tokens are stored.
   */
  async login(): Promise<StoredTokens> {
    if (!this.config.clientId) {
      throw new Error('BUNGIE_CLIENT_ID (and secret for confidential apps) required.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    const url = this.getAuthorizationUrl(state);

    console.error('\n=== Bungie OAuth ===');
    console.error('1. Open this URL in your browser and authorize:\n');
    console.error('   ' + url + '\n');
    console.error('2. After approving you will be redirected to your callback URL.');
    console.error('   This will complete automatically, or paste the full');
    console.error('   redirect URL (or just the code) here if it does not.\n');

    const code = await this.awaitCode(state);
    const tokens = await this.exchangeCodeForToken(code);
    console.error('\n✓ Authenticated. Tokens saved to ' + this.tokenPath + '\n');
    return tokens;
  }

  /** Race the local callback listener against manual stdin paste. */
  private awaitCode(expectedState: string): Promise<string> {
    const port = this.config.oauthPort ?? 7777;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try {
          server.close();
        } catch {
          /* ignore */
        }
        rl.close();
        fn();
      };

      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url ?? '', `http://localhost:${port}`);
          const code = reqUrl.searchParams.get('code');
          const state = reqUrl.searchParams.get('state');
          if (!code) {
            res.writeHead(400).end('Missing ?code');
            return;
          }
          if (state && state !== expectedState) {
            res.writeHead(400).end('State mismatch — possible CSRF. Aborting.');
            finish(() => reject(new Error('OAuth state mismatch.')));
            return;
          }
          res
            .writeHead(200, { 'Content-Type': 'text/html' })
            .end(
              '<h2>Authentication complete.</h2>You can close this tab and return to the terminal.'
            );
          finish(() => resolve(code));
        } catch {
          res.writeHead(500).end('Error');
        }
      });
      server.on('error', (e) => {
        // Port busy / unusable — fall back to manual paste only.
        console.error(`(local callback listener unavailable: ${e.message})`);
      });
      server.listen(port, () => {
        console.error(`Listening for the OAuth callback on port ${port}...`);
      });

      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question('Paste redirect URL or code (or wait for the browser): ', (answer) => {
        const code = extractCode(answer.trim());
        if (code) finish(() => resolve(code));
        else finish(() => reject(new Error('Could not parse an authorization code.')));
      });
    });
  }

  logout(): void {
    this.tokens = null;
    try {
      if (fs.existsSync(this.tokenPath)) fs.unlinkSync(this.tokenPath);
    } catch {
      /* ignore */
    }
  }
}

/** Pull an authorization code out of a pasted full redirect URL or bare code. */
function extractCode(input: string): string | null {
  if (!input) return null;
  if (input.includes('code=')) {
    try {
      const u = new URL(input.includes('://') ? input : `http://x/?${input.replace(/^\?/, '')}`);
      const code = u.searchParams.get('code');
      if (code) return code;
    } catch {
      /* fall through */
    }
  }
  // Otherwise assume the whole string is the code.
  return /^[A-Za-z0-9._-]+$/.test(input) ? input : null;
}

function describeAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      return String(d.error_description ?? d.error ?? d.Message ?? error.message);
    }
    return error.message;
  }
  return String(error);
}
