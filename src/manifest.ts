import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { BungieConfig } from './types.js';
import { DestinyAPI } from './destiny-api.js';

const BUNGIE_HOST = 'https://www.bungie.net';

/** Weekday name in Bungie's timezone (Pacific), DST-aware. */
const pacificWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday: 'short',
});

/**
 * How long a manifest version check stays fresh. The manifest only changes on
 * game patches, which land on Tuesdays (Pacific), so check every 3h on
 * Tuesday and daily otherwise. Lookup misses trigger an earlier check.
 */
function versionCheckMs(now = new Date()): number {
  return (pacificWeekday.format(now) === 'Tue' ? 3 : 24) * 60 * 60_000;
}
/** Minimum gap between miss-triggered version checks (hash 0 etc. miss legitimately). */
const MISS_RECHECK_MS = 5 * 60_000;

/** Compact, display-ready item info resolved from the manifest. */
export interface ResolvedItem {
  name: string;
  itemType: string;
  tier: string;
  itemTypeEnum: number;
  tierEnum: number;
}

/**
 * Local Destiny 2 manifest backed by Bungie's native SQLite database
 * (`mobileWorldContentPaths`). The DB is downloaded + unzipped once per
 * manifest version, cached on disk, and queried row-by-row — so a single hash
 * lookup never loads an entire (tens-of-MB) definition table into memory.
 *
 * Bungie stores each definition table as `(id INTEGER, json TEXT)` where `id`
 * is the definition hash reinterpreted as a SIGNED 32-bit integer.
 */
export class ManifestManager {
  private api: DestinyAPI;
  private locale: string;
  private rootDir: string;
  private version: string | null = null;
  private db: Database.Database | null = null;
  private tableNames = new Set<string>();
  /** ms epoch of the last successful version check against Bungie. */
  private lastChecked = 0;
  private inflight: Promise<void> | null = null;
  /** Per-table [id, lowercased name] lists, built lazily for name search. */
  private nameIndex = new Map<string, Array<[number, string]>>();

  constructor(api: DestinyAPI, config: BungieConfig, locale = 'en') {
    this.api = api;
    this.locale = locale;
    this.rootDir = path.join(config.dataDir!, 'manifest');
  }

  // -- Lifecycle ----------------------------------------------------------

  /**
   * Ensure the SQLite DB for the current manifest version is open. Bungie's
   * manifest pointer is only re-checked per versionCheckMs(), and concurrent
   * callers share one in-flight check/download.
   */
  async ensure(forceRefresh = false): Promise<void> {
    if (!forceRefresh && this.db && Date.now() - this.lastChecked < versionCheckMs()) return;
    this.inflight ??= this.sync(forceRefresh).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async sync(forceRefresh: boolean): Promise<void> {
    let resp: any;
    try {
      resp = (await this.api.getManifest()).Response;
    } catch (error) {
      // Keep serving the DB we have if Bungie is briefly unreachable.
      if (this.db && !forceRefresh) {
        this.lastChecked = Date.now();
        return;
      }
      throw error;
    }
    const version: string = resp.version;
    const dbPath: string | undefined = resp.mobileWorldContentPaths?.[this.locale];
    if (!dbPath) {
      throw new Error(`No mobileWorldContentPaths for locale "${this.locale}".`);
    }

    if (!forceRefresh && this.db && this.version === version) {
      this.lastChecked = Date.now();
      return;
    }

    const localPath = path.join(this.rootDir, version, 'world.content');
    if (forceRefresh || !fs.existsSync(localPath)) {
      await this.download(dbPath, localPath);
    }

    this.openDb(localPath, version);
    this.lastChecked = Date.now();
    this.pruneOldVersions(version);
  }

  private async download(relPath: string, localPath: string): Promise<void> {
    const { data } = await axios.get<ArrayBuffer>(`${BUNGIE_HOST}${relPath}`, {
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    // The manifest path points at a .zip containing a single SQLite file.
    const zip = new AdmZip(Buffer.from(data));
    const entries = zip.getEntries();
    if (entries.length === 0) throw new Error('Manifest archive was empty.');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    // Write-then-rename so an interrupted download never leaves a truncated DB
    // that existsSync() would accept forever.
    const tmpPath = `${localPath}.tmp`;
    fs.writeFileSync(tmpPath, entries[0].getData());
    fs.renameSync(tmpPath, localPath);
  }

  private openDb(localPath: string, version: string): void {
    this.db?.close();
    this.db = new Database(localPath, { readonly: true, fileMustExist: true });
    this.version = version;
    this.nameIndex.clear();
    this.tableNames = new Set(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r: any) => r.name as string)
    );
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('Manifest not initialized.');
    return this.db;
  }

  /** Validate a table name before interpolating it into SQL. */
  private assertTable(table: string): void {
    if (!this.tableNames.has(table)) {
      throw new Error(
        `Unknown manifest table "${table}". Use manifest_list_tables to see valid names.`
      );
    }
  }

  getVersion(): string | null {
    return this.version;
  }

  // -- Lookups ------------------------------------------------------------

  async getDefinition(table: string, hash: number | string): Promise<any | null> {
    return (await this.getDefinitions(table, [hash]))[String(hash)];
  }

  async getDefinitions(
    table: string,
    hashes: Array<number | string>
  ): Promise<Record<string, any>> {
    await this.ensure();
    this.assertTable(table);
    let out = this.lookup(table, hashes);
    // A miss may mean the game was patched since our last version check.
    if (Object.values(out).includes(null) && (await this.recheckVersion())) {
      this.assertTable(table);
      out = this.lookup(table, hashes);
    }
    return out;
  }

  private lookup(table: string, hashes: Array<number | string>): Record<string, any> {
    const stmt = this.requireDb().prepare(`SELECT json FROM ${table} WHERE id = ?`);
    const out: Record<string, any> = {};
    for (const h of hashes) {
      const row = stmt.get(toSignedId(h)) as { json: string } | undefined;
      out[String(h)] = row ? JSON.parse(row.json) : null;
    }
    return out;
  }

  /** Re-check the manifest version early (rate-limited). Returns true if it changed. */
  private async recheckVersion(): Promise<boolean> {
    if (Date.now() - this.lastChecked < MISS_RECHECK_MS) return false;
    const before = this.version;
    this.lastChecked = 0;
    await this.ensure();
    return this.version !== before;
  }

  /**
   * Resolve many item hashes to compact, display-ready info in one pass.
   * Used by name-resolving tools so callers never see raw hashes.
   */
  async resolveItems(hashes: Array<number | string>): Promise<Record<string, ResolvedItem | null>> {
    const defs = await this.getDefinitions('DestinyInventoryItemDefinition', hashes);
    const out: Record<string, ResolvedItem | null> = {};
    for (const [hash, def] of Object.entries(defs)) {
      out[hash] = def
        ? {
            name: def.displayProperties?.name ?? '',
            itemType: def.itemTypeDisplayName ?? '',
            tier: def.inventory?.tierTypeName ?? '',
            itemTypeEnum: def.itemType ?? 0,
            tierEnum: def.inventory?.tierType ?? 0,
          }
        : null;
    }
    return out;
  }

  /**
   * Case-insensitive substring search over `displayProperties.name`. The first
   * search on a table builds an in-memory name index (one full scan); later
   * searches only touch the index and fetch the matching rows by id.
   */
  async searchByName(table: string, query: string, limit = 25): Promise<any[]> {
    await this.ensure();
    this.assertTable(table);
    const needle = query.toLowerCase();
    const stmt = this.requireDb().prepare(`SELECT json FROM ${table} WHERE id = ?`);
    const results: any[] = [];
    for (const [id, name] of this.namesFor(table)) {
      if (!name.includes(needle)) continue;
      const row = stmt.get(id) as { json: string } | undefined;
      if (row) results.push(JSON.parse(row.json));
      if (results.length >= limit) break;
    }
    return results;
  }

  private namesFor(table: string): Array<[number, string]> {
    let names = this.nameIndex.get(table);
    if (!names) {
      names = [];
      const rows = this.requireDb().prepare(`SELECT id, json FROM ${table}`).iterate() as Iterable<{
        id: number;
        json: string;
      }>;
      for (const row of rows) {
        const name = JSON.parse(row.json)?.displayProperties?.name;
        if (typeof name === 'string' && name) names.push([row.id, name.toLowerCase()]);
      }
      this.nameIndex.set(table, names);
    }
    return names;
  }

  async listTables(): Promise<string[]> {
    await this.ensure();
    return [...this.tableNames].sort();
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

/** Reinterpret an unsigned Destiny hash as the signed 32-bit id used as the PK. */
function toSignedId(hash: number | string): number {
  const n = Number(hash) >>> 0;
  return n > 0x7fffffff ? n - 0x100000000 : n;
}
