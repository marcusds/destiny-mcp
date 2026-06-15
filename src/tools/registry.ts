import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { DestinyAPI } from '../destiny-api.js';
import { BungieAuth } from '../auth.js';
import { ManifestManager } from '../manifest.js';
import { InventoryCache } from '../inventory.js';

/** Shared services handed to every tool handler. */
export interface ToolContext {
  api: DestinyAPI;
  auth: BungieAuth;
  manifest: ManifestManager;
  inventory: InventoryCache;
}

export type ToolArgs = Record<string, unknown>;

/** A tool = its MCP schema + a handler returning raw data (serialized by the server). */
export interface ToolDef {
  definition: Tool;
  handler: (ctx: ToolContext, args: ToolArgs) => Promise<unknown>;
  /** Marks tools that mutate game state — surfaced in descriptions/docs. */
  write?: boolean;
}

// -- Schema helpers (keep tool definitions terse) --------------------------

export const num = (description: string) => ({ type: 'number' as const, description });
export const str = (description: string) => ({ type: 'string' as const, description });
export const bool = (description: string) => ({ type: 'boolean' as const, description });
export const numArr = (description: string) => ({
  type: 'array' as const,
  items: { type: 'number' as const },
  description,
});
export const strArr = (description: string) => ({
  type: 'array' as const,
  items: { type: 'string' as const },
  description,
});

export function tool(
  name: string,
  description: string,
  schema: { properties: Record<string, unknown>; required?: string[] },
  handler: ToolDef['handler'],
  opts: { write?: boolean } = {}
): ToolDef {
  return {
    definition: {
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: schema.properties,
        required: schema.required ?? [],
      },
    },
    handler,
    write: opts.write,
  };
}

const PLATFORM =
  'Platform membershipType (1=Xbox, 2=PSN, 3=Steam, 4=Blizzard, 5=Stadia, 6=Epic, 254=BungieNext, -1=All)';

export const fields = {
  membershipType: () => num(PLATFORM),
  membershipId: () => str('Platform-specific destiny membership ID'),
  characterId: () => str('Character ID'),
};
