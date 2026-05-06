import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { Table } from "@lancedb/lancedb";

export type ChunkRecord = Record<string, unknown> & {
  id: string;       // `${path}::${chunk_idx}`
  path: string;
  chunk_idx: number;
  heading: string;
  text: string;
  mtime: string;
  hash: string;
  vector: number[];
}

const VAULT_ROOT = process.env.COMPANION_VAULT
  ? path.resolve(process.env.COMPANION_VAULT)
  : path.resolve(process.cwd(), "..");

const DB_PATH = path.join(VAULT_ROOT, ".lancedb");
const TABLE_NAME = "chunks";

let _db: lancedb.Connection | null = null;
let _table: Table | null = null;

async function getDb(): Promise<lancedb.Connection> {
  if (!_db) {
    _db = await lancedb.connect(DB_PATH);
  }
  return _db;
}

async function getTable(): Promise<Table> {
  if (_table) return _table;
  const db = await getDb();

  const tableNames = await db.tableNames();
  if (tableNames.includes(TABLE_NAME)) {
    _table = await db.openTable(TABLE_NAME);
  } else {
    // Create with a dummy row to establish schema, then delete it
    const dummy: ChunkRecord = {
      id: "__init__",
      path: "",
      chunk_idx: 0,
      heading: "",
      text: "",
      mtime: new Date(0).toISOString(),
      hash: "",
      vector: new Array(384).fill(0) as number[],
    };
    _table = await db.createTable(TABLE_NAME, [dummy]);
    await _table.delete('id = "__init__"');
  }
  return _table;
}

function safeSqlPath(p: string): string {
  // Only allow characters safe in vault paths; reject anything that could break the predicate
  if (!/^[\w/.\-]+$/.test(p)) throw new Error(`Unsafe path rejected: ${p}`);
  // Escape single quotes for SQL string literal
  return p.replace(/'/g, "''");
}

export async function upsertChunks(records: ChunkRecord[]): Promise<void> {
  if (records.length === 0) return;
  const table = await getTable();
  // Delete existing rows for these paths first (merge by path)
  const paths = [...new Set(records.map((r) => r.path))];
  for (const p of paths) {
    await table.delete(`path = '${safeSqlPath(p)}'`);
  }
  await table.add(records);
}

export async function deleteByPath(filePath: string): Promise<void> {
  const table = await getTable();
  await table.delete(`path = '${safeSqlPath(filePath)}'`).catch(() => {});
}

export async function search(vector: number[], limit: number = 8): Promise<ChunkRecord[]> {
  const table = await getTable();
  const results = await table.search(vector).limit(limit).toArray();
  return results as unknown as ChunkRecord[];
}

export async function getAllPaths(): Promise<Map<string, { mtime: string; hash: string }>> {
  const table = await getTable();
  // Query distinct path+mtime+hash
  const rows = await table.query().select(["path", "mtime", "hash"]).toArray();
  const map = new Map<string, { mtime: string; hash: string }>();
  for (const row of rows as unknown as { path: string; mtime: string; hash: string }[]) {
    if (!map.has(row.path)) {
      map.set(row.path, { mtime: row.mtime, hash: row.hash });
    }
  }
  return map;
}

export async function getAllForDupeCheck(): Promise<{ path: string; vector: number[] }[]> {
  const table = await getTable();
  // Get one representative chunk per file (chunk_idx = 0)
  const rows = await table.query().where("chunk_idx = 0").select(["path", "vector"]).toArray();
  return rows as unknown as { path: string; vector: number[] }[];
}
