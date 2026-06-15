#!/usr/bin/env node

import { Command } from 'commander';
import { runStdioServer, runWebSocketServer } from './server.js';
import { BungieAuth } from './auth.js';
import { loadConfig } from './config.js';

const program = new Command();

program
  .name('d2-mcp')
  .description('Comprehensive MCP server for the Bungie.net Destiny 2 API')
  .version('2.0.0');

program
  .command('stdio')
  .description('Run server in stdio mode (default)')
  .action(async () => {
    await runStdioServer().catch(fail);
  });

program
  .command('websocket')
  .description('Run server as a WebSocket server for remote connections')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port number. Must be between 1 and 65535.');
      process.exit(1);
    }
    await runWebSocketServer(port).catch(fail);
  });

program
  .command('auth')
  .description('Run the interactive Bungie OAuth login and store tokens')
  .action(async () => {
    const config = loadConfig();
    if (!config.clientId) {
      console.error(
        'BUNGIE_CLIENT_ID is required for OAuth. Set it (and BUNGIE_CLIENT_SECRET for confidential apps) in your .env.'
      );
      process.exit(1);
    }
    const auth = new BungieAuth(config);
    await auth.login().catch(fail);
    process.exit(0);
  });

program
  .command('logout')
  .description('Delete stored OAuth tokens')
  .action(() => {
    new BungieAuth(loadConfig()).logout();
    console.error('Logged out — stored tokens removed.');
  });

function fail(error: unknown): never {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
}

// Default to stdio when invoked with no subcommand.
if (process.argv.length === 2) {
  runStdioServer().catch(fail);
} else {
  program.parse();
}
