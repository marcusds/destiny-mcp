import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { BungieConfig } from './types.js';
import { DestinyAPI } from './destiny-api.js';

const BUNGIE_HOST = 'https://www.bungie.net';

type DefinitionTable = Record<string, any>;

interface ManifestMeta {
  version: string;
  /** locale -> { tableName -> relative path } */
  componentPaths: Record<string, string>;
}

/**
 * Local Destiny 2 manifest cache.
 *
 * Bungie's manifest is enormous, so rather than the single combined world
 * content file we use `jsonWorldComponentContentPaths`, which exposes one URL
 * per definition table. Tables are downloaded on first use, cached on disk
 * keyed by manifest version, and memoized in memory. A version change
 * transparently invalidates the on-disk cache.
 */
export class ManifestManager {
  private api: DestinyAPI;
  private locale: string;
  private rootDir: string;
  private meta: ManifestMeta | null = null;
  private tables = new Map<string, DefinitionTable>();

  constructor(api: DestinyAPI, config: BungieConfig, locale = 'en') {
    this.api = api;
    this.locale = locale;
    this.rootDir = path.join(config.dataDir!, 'manifest');
  }

  // -- Version / metadata -------------------------------------------------

  /** Resolve the current manifest version + per-table paths, caching the meta. */
  async ensure(forceRefresh = false): Promise<ManifestMeta> {
    if (this.meta && !forceRefresh) return this.meta;

    const manifest = await this.api.getManifest();
    const resp = manifest.Response;
    const version: string = resp.version;
    const componentPaths: Record<string, string> =
      resp.jsonWorldComponentContentPaths?.[this.locale] ?? {};

    if (!componentPaths || Object.keys(componentPaths).length === 0) {
      throw new Error(`No manifest component paths for locale "${this.locale}".`);
    }

    this.meta = { version, componentPaths };

    // Prune stale versions so the cache directory doesn't grow unbounded.
    if (forceRefresh) this.tables.clear();
    this.pruneOldVersions(version);
    return this.meta;
  }

  getVersion(): string | null {
    return this.meta?.version ?? null;
  }

  // -- Table loading ------------------------------------------------------

  private versionDir(version: string): string {
    return path.join(this.rootDir, version);
  }

  private async loadTable(tableName: string): Promise<DefinitionTable> {
    const cached = this.tables.get(tableName);
    if (cached) return cached;

    const meta = await this.ensure();
    const relPath = meta.componentPaths[tableName];
    if (!relPath) {
      throw new Error(
        `Unknown manifest table "${tableName}". Examples: DestinyInventoryItemDefinition, DestinyActivityDefinition.`
      );
    }

    const diskPath = path.join(this.versionDir(meta.version), `${tableName}.json`);
    let table: DefinitionTable;

    if (fs.existsSync(diskPath)) {
      table = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
    } else {
      const { data } = await axios.get<DefinitionTable>(`${BUNGIE_HOST}${relPath}`, {
        // Tables can be tens of MB; allow large payloads.
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      table = data;
      fs.mkdirSync(path.dirname(diskPath), { recursive: true });
      fs.writeFileSync(diskPath, JSON.stringify(table));
    }

    this.tables.set(tableName, table);
    return table;
  }

  // -- Public lookups -----------------------------------------------------

  /** Resolve a single definition by table + hash (handles signed/unsigned). */
  async getDefinition(tableName: string, hash: number | string): Promise<any | null> {
    const table = await this.loadTable(tableName);
    const key = String(hash);
    if (key in table) return table[key];
    // Bungie hashes are unsigned 32-bit; callers sometimes pass the signed form.
    const n = Number(hash);
    if (Number.isFinite(n)) {
      const unsigned = String(n >>> 0);
      if (unsigned in table) return table[unsigned];
    }
    return null;
  }

  /** Resolve many hashes from one table in a single load. */
  async getDefinitions(
    tableName: string,
    hashes: Array<number | string>
  ): Promise<Record<string, any>> {
    const table = await this.loadTable(tableName);
    const out: Record<string, any> = {};
    for (const h of hashes) {
      const key = String(h);
      out[key] = table[key] ?? table[String(Number(h) >>> 0)] ?? null;
    }
    return out;
  }

  /** Case-insensitive substring search over `displayProperties.name`. */
  async searchByName(tableName: string, query: string, limit = 25): Promise<any[]> {
    const table = await this.loadTable(tableName);
    const needle = query.toLowerCase();
    const results: any[] = [];
    for (const key of Object.keys(table)) {
      const def = table[key];
      const name: string | undefined = def?.displayProperties?.name;
      if (name && name.toLowerCase().includes(needle)) {
        results.push(def);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /** List the table names available in the current manifest. */
  async listTables(): Promise<string[]> {
    const meta = await this.ensure();
    return Object.keys(meta.componentPaths).sort();
  }

  // -- Cache hygiene ------------------------------------------------------

  private pruneOldVersions(current: string): void {
    try {
      if (!fs.existsSync(this.rootDir)) return;
      for (const entry of fs.readdirSync(this.rootDir)) {
        if (entry !== current) {
          fs.rmSync(path.join(this.rootDir, entry), { recursive: true, force: true });
        }
      }
    } catch {
      /* best-effort cleanup */
    }
  }
}
