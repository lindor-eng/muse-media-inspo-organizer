import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from './schema';

let db: Database.Database | null = null;

export function getLibraryPath(): string {
  const libraryPath = path.join(app.getPath('userData'), 'library');
  fs.mkdirSync(libraryPath, { recursive: true });
  fs.mkdirSync(path.join(libraryPath, 'originals'), { recursive: true });
  fs.mkdirSync(path.join(libraryPath, 'thumbnails'), { recursive: true });
  return libraryPath;
}

export function initDatabase(): Database.Database {
  if (db) return db;

  const libraryPath = getLibraryPath();
  const dbPath = path.join(libraryPath, 'library.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  sqliteVec.load(db);

  runMigrations(db);

  return db;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}
