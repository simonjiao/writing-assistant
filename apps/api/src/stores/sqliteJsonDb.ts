import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type DatabaseLike = { exec(sql: string): void; prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown; run(...args: unknown[]): unknown }; close(): void };
type SqliteModule = { DatabaseSync: new (path: string) => DatabaseLike };
type JsonRow = { json: string };

let sqliteModule: SqliteModule | undefined;
function loadSqlite(): SqliteModule {
  if (!sqliteModule) sqliteModule = require('node:sqlite') as SqliteModule;
  return sqliteModule;
}

export class SqliteJsonDb<T extends { id: string }> {
  private readonly db: DatabaseLike;

  constructor(dbPath: string, private readonly namespace: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new (loadSqlite().DatabaseSync)(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS json_records (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, id)
      );
      CREATE INDEX IF NOT EXISTS idx_json_records_namespace_updated ON json_records(namespace, updated_at);
    `);
  }

  async list(): Promise<T[]> {
    const rows = this.db.prepare('SELECT json FROM json_records WHERE namespace = ? ORDER BY updated_at DESC').all(this.namespace) as JsonRow[];
    return rows.map((row) => JSON.parse(row.json) as T);
  }

  async get(id: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT json FROM json_records WHERE namespace = ? AND id = ?').get(this.namespace, id) as JsonRow | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  async upsert(record: T): Promise<T> {
    this.db.prepare(`INSERT INTO json_records(namespace, id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(this.namespace, record.id, JSON.stringify(record), new Date().toISOString());
    return record;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const current = await this.get(id);
    if (!current) throw new Error(`Record not found: ${id}`);
    const updated = { ...current, ...patch } as T;
    await this.upsert(updated);
    return updated;
  }

  close(): void { this.db.close(); }
}
