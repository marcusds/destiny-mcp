import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { BungieConfig } from './types.js';

dotenv.config();

/** Build the runtime config from environment variables, applying defaults. */
export function loadConfig(): BungieConfig {
  const oauthPort = parseInt(process.env.BUNGIE_OAUTH_PORT ?? '7777', 10) || 7777;
  const dataDir = process.env.D2_MCP_DATA_DIR || path.join(os.homedir(), '.d2-mcp');

  return {
    apiKey: process.env.BUNGIE_API_KEY ?? '',
    baseUrl: process.env.BUNGIE_BASE_URL ?? 'https://www.bungie.net/Platform',
    clientId: process.env.BUNGIE_CLIENT_ID || undefined,
    clientSecret: process.env.BUNGIE_CLIENT_SECRET || undefined,
    redirectUri: process.env.BUNGIE_REDIRECT_URI || undefined,
    oauthPort,
    dataDir,
  };
}

/** Build the services used across the server + CLI. */
export function createServices() {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error(
      'Warning: BUNGIE_API_KEY is not set. All API calls will fail until it is configured.'
    );
  }
  return config;
}
