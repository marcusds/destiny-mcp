import { ToolDef, tool, str } from './registry.js';

/**
 * OAuth helper tools. Because an MCP server runs non-interactively, the full
 * browser login is driven by the `d2-mcp auth` CLI command. These tools let an
 * agent check status and complete the flow by pasting a code/redirect URL.
 */
export const authTools: ToolDef[] = [
  tool(
    'auth_status',
    'Check whether the server is authenticated with Bungie OAuth (required for [auth] tools)',
    { properties: {} },
    async (ctx) => ({
      authenticated: ctx.auth.isAuthenticated(),
      membershipId: ctx.auth.getMembershipId(),
      hint: ctx.auth.isAuthenticated()
        ? 'Authenticated. [auth] tools are available.'
        : 'Not authenticated. Run `d2-mcp auth` in a terminal, or use get_auth_url + submit_auth_code.',
    })
  ),

  tool(
    'get_auth_url',
    'Get the Bungie OAuth authorization URL to open in a browser. After approving, pass the redirected URL (or code) to submit_auth_code.',
    { properties: {} },
    async (ctx) => {
      // Random state isn't verifiable across separate tool calls, so we use a
      // fixed marker; the CSRF-protected path is the `d2-mcp auth` CLI command.
      const url = ctx.auth.getAuthorizationUrl('mcp');
      return { authorizationUrl: url, next: 'Open the URL, approve, then call submit_auth_code.' };
    }
  ),

  tool(
    'submit_auth_code',
    'Complete OAuth by submitting the authorization code (or the full redirect URL) obtained from get_auth_url',
    {
      properties: {
        codeOrUrl: str('The authorization code, or the full redirect URL containing ?code='),
      },
      required: ['codeOrUrl'],
    },
    async (ctx, a) => {
      const raw = (a.codeOrUrl as string).trim();
      let code = raw;
      const idx = raw.indexOf('code=');
      if (idx >= 0) {
        code = raw.slice(idx + 5).split('&')[0];
      }
      const tokens = await ctx.auth.exchangeCodeForToken(code);
      return { authenticated: true, membershipId: tokens.membershipId };
    }
  ),
];
