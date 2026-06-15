import { ToolDef, tool, num, str, numArr } from './registry.js';

/** Manifest tools: pointer, local hash resolution, and name search via cache. */
export const manifestTools: ToolDef[] = [
  tool(
    'get_destiny_manifest',
    'Get the Destiny 2 manifest metadata (version + content paths)',
    { properties: {} },
    (ctx) => ctx.api.getManifest()
  ),

  tool(
    'get_destiny_entity_definition',
    'Get a single definition by entity type + hash directly from the Bungie API',
    {
      properties: {
        entityType: str(
          'Definition table (e.g. DestinyInventoryItemDefinition, DestinyActivityDefinition)'
        ),
        hashIdentifier: num('Hash identifier for the entity'),
      },
      required: ['entityType', 'hashIdentifier'],
    },
    (ctx, a) =>
      ctx.api.getDestinyEntityDefinition(a.entityType as string, a.hashIdentifier as number)
  ),

  tool(
    'manifest_lookup',
    'Resolve one or many definition hashes from the local SQLite cache in a single call (pass `hashes` to batch — one round trip instead of N)',
    {
      properties: {
        table: str('Definition table (e.g. DestinyInventoryItemDefinition)'),
        hash: num('A single definition hash to resolve'),
        hashes: numArr('Multiple definition hashes to resolve at once'),
      },
      required: ['table'],
    },
    async (ctx, a) => {
      const table = a.table as string;
      if (Array.isArray(a.hashes) && a.hashes.length > 0) {
        return ctx.manifest.getDefinitions(table, a.hashes as number[]);
      }
      if (a.hash !== undefined) {
        const def = await ctx.manifest.getDefinition(table, a.hash as number);
        return def ?? { found: false, table, hash: a.hash };
      }
      throw new Error('Provide `hash` (single) or `hashes` (array).');
    }
  ),

  tool(
    'manifest_search',
    'Search the cached manifest for definitions whose name matches a query (e.g. find a weapon by name)',
    {
      properties: {
        table: str('Definition table to search (default DestinyInventoryItemDefinition)'),
        query: str('Name substring to search for'),
        limit: num('Max results (default 25)'),
      },
      required: ['query'],
    },
    (ctx, a) =>
      ctx.manifest.searchByName(
        (a.table as string) ?? 'DestinyInventoryItemDefinition',
        a.query as string,
        (a.limit as number) ?? 25
      )
  ),

  tool(
    'manifest_list_tables',
    'List all definition table names available in the current manifest',
    { properties: {} },
    (ctx) => ctx.manifest.listTables()
  ),

  tool(
    'search_destiny_entities',
    'Search Destiny definitions by text via the Bungie API. NOTE: Bungie has disabled this endpoint server-side (returns 404) — prefer manifest_search, which searches the local cache.',
    {
      properties: {
        type: str('Definition type to search (e.g. DestinyInventoryItemDefinition)'),
        searchTerm: str('Text to search for'),
        page: num('Page number (0-based)'),
      },
      required: ['type', 'searchTerm'],
    },
    (ctx, a) =>
      ctx.api.searchDestinyEntities(
        a.type as string,
        a.searchTerm as string,
        (a.page as number) ?? 0
      )
  ),
];
