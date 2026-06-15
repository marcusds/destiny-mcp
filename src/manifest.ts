import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { BungieConfig } from './types.js';
import { DestinyAPI } from './destiny-api.js';

const BUNGIE_HOST = 'https://www.bungie.net';

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

  constructor(api: DestinyAPI, config: BungieConfig, locale = 'en') {
    this.api = api;
    this.locale = locale;
    this.rootDir = path.join(config.dataDir!, 'manifest');
  }

  // -- Lifecycle ----------------------------------------------------------

  /** Ensure the SQLite DB for the current manifest version is open. */
  async ensure(forceRefresh = false): Promise<void> {
    const manifest = await this.api.getManifest();
    const resp = manifest.Response;
    const version: string = resp.version;
    const dbPath: string | undefined = resp.mobileWorldContentPaths?.[this.locale];
    if (!dbPath) {
      throw new Error(`No mobileWorldContentPaths for locale "${this.locale}".`);
    }

    if (!forceRefresh && this.db && this.version === version) return;

    const localPath = path.join(this.rootDir, version, 'world.content');
    if (forceRefresh || !fs.existsSync(localPath)) {
      await this.download(dbPath, localPath);
    }

    this.openDb(localPath, version);
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
    fs.writeFileSync(localPath, entries[0].getData());
  }

  private openDb(localPath: string, version: string): void {
    this.db?.close();
    this.db = new Database(localPath, { readonly: true, fileMustExist: true });
    this.version = version;
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
    await this.ensure();
    this.assertTable(table);
    const row = this.requireDb()
      .prepare(`SELECT json FROM ${table} WHERE id = ?`)
      .get(toSignedId(hash)) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  async getDefinitions(
    table: string,
    hashes: Array<number | string>
  ): Promise<Record<string, any>> {
    await this.ensure();
    this.assertTable(table);
    const stmt = this.requireDb().prepare(`SELECT json FROM ${table} WHERE id = ?`);
    const out: Record<string, any> = {};
    for (const h of hashes) {
      const row = stmt.get(toSignedId(h)) as { json: string } | undefined;
      out[String(h)] = row ? JSON.parse(row.json) : null;
    }
    return out;
  }

  /**
   * Case-insensitive substring search over `displayProperties.name`. Uses a
   * SQL `LIKE` prefilter so only candidate rows are parsed in JS.
   */
  async searchByName(table: string, query: string, limit = 25): Promise<any[]> {
    await this.ensure();
    this.assertTable(table);
    const rows = this.requireDb()
      .prepare(`SELECT json FROM ${table} WHERE json LIKE ? LIMIT 5000`)
      .all(`%${query}%`) as Array<{ json: string }>;

    const needle = query.toLowerCase();
    const results: any[] = [];
    for (const row of rows) {
      const def = JSON.parse(row.json);
      const name: string | undefined = def?.displayProperties?.name;
      if (name && name.toLowerCase().includes(needle)) {
        results.push(def);
        if (results.length >= limit) break;
      }
    }
    return results;
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
