import { ToolDef, tool, num, str } from './registry.js';

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
    'Resolve a definition hash from the locally cached manifest (fast, no per-call API request)',
    {
      properties: {
        table: str('Definition table (e.g. DestinyInventoryItemDefinition)'),
        hash: num('Definition hash to resolve'),
      },
      required: ['table', 'hash'],
    },
    async (ctx, a) => {
      const def = await ctx.manifest.getDefinition(a.table as string, a.hash as number);
      if (def === null) {
        return { found: false, table: a.table, hash: a.hash };
      }
      return def;
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
