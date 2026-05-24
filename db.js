const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'docs_generator.db');

function normalizePath(filePath) {
  if (!filePath) return filePath;
  let resolved = path.resolve(filePath);
  if (process.platform === 'win32' && /^[a-z]:/i.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}


// ---------------------------------------------------------------------------
// Singleton database — sql.js requires async init, so we expose a ready()
// promise. After ready() resolves, all helpers work synchronously.
// ---------------------------------------------------------------------------

let db = null;

/**
 * Initialise (or re-use) the SQLite database.
 * Call `await ready()` once at startup before using any helper function.
 * Subsequent calls return the same db instance.
 */
async function ready() {
  if (db) return db;

  const SQL = await initSqlJs();

  // Load existing database file if it exists
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON;');

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS code_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      file_path     TEXT    NOT NULL,
      signature     TEXT,
      source_text   TEXT,
      ast_hash      TEXT,
      item_type     TEXT,
      created_at    TEXT    DEFAULT (datetime('now')),
      updated_at    TEXT    DEFAULT (datetime('now')),
      UNIQUE(name, file_path)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS documentation (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      code_item_id      INTEGER NOT NULL,
      content           TEXT,
      overall_score     REAL,
      description_score REAL,
      params_score      REAL,
      return_score      REAL,
      examples_score    REAL,
      edge_cases_score  REAL,
      missing_fields    TEXT,
      status            TEXT    CHECK(status IN ('draft','review','ready','published'))
                                DEFAULT 'draft',
      created_at        TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (code_item_id) REFERENCES code_items(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT    NOT NULL,
      payload     TEXT,
      status      TEXT    CHECK(status IN ('pending','processing','done','failed'))
                          DEFAULT 'pending',
      error_msg   TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Persistence — sql.js is in-memory; we flush to disk after every write
// ---------------------------------------------------------------------------

function persist() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ---------------------------------------------------------------------------
// Internal query helpers  (thin wrappers around sql.js)
// ---------------------------------------------------------------------------

/**
 * Run a SELECT that returns multiple rows as an array of plain objects.
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Run a SELECT that returns a single row (or undefined).
 */
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

/**
 * Run an INSERT / UPDATE / DELETE statement.
 * Returns { lastInsertRowid, changes }.
 */
function execute(sql, params = []) {
  db.run(sql, params);
  const info = db.exec('SELECT last_insert_rowid() AS id, changes() AS changes');
  const row = info.length > 0 ? info[0].values[0] : [0, 0];
  persist();
  return { lastInsertRowid: row[0], changes: row[1] };
}

// ---------------------------------------------------------------------------
// Helper functions (same public API as before)
// ---------------------------------------------------------------------------

/**
 * Retrieve a single code_item by its id.
 */
function getItem(id) {
  return queryOne('SELECT * FROM code_items WHERE id = ?', [id]);
}

/**
 * Retrieve a code_item by name + file_path (the natural key).
 */
function getItemByNameAndPath(name, filePath) {
  const normPath = normalizePath(filePath);
  return queryOne(
    'SELECT * FROM code_items WHERE name = ? AND file_path = ?',
    [name, normPath]
  );
}

/**
 * Retrieve all code_items, optionally filtered by item_type.
 */
function getAllItems(itemType) {
  if (itemType) {
    return queryAll('SELECT * FROM code_items WHERE item_type = ?', [itemType]);
  }
  return queryAll('SELECT * FROM code_items');
}

/**
 * Insert a new code_item. Returns the inserted row info.
 */
function insertItem({ name, file_path, signature, source_text, ast_hash, item_type }) {
  const normPath = normalizePath(file_path);
  return execute(
    `INSERT INTO code_items (name, file_path, signature, source_text, ast_hash, item_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, normPath, signature, source_text, ast_hash, item_type]
  );
}

/**
 * Update an existing code_item when its ast_hash has changed.
 */
function updateItem(id, { signature, source_text, ast_hash }) {
  return execute(
    `UPDATE code_items
        SET signature   = ?,
            source_text = ?,
            ast_hash    = ?,
            updated_at  = datetime('now')
      WHERE id = ?`,
    [signature, source_text, ast_hash, id]
  );
}

/**
 * Upsert a code_item — insert if new, update only when ast_hash differs.
 * Returns { id, isNew, changed }.
 */
function upsertItem({ name, file_path, signature, source_text, ast_hash, item_type }) {
  const normPath = normalizePath(file_path);
  const existing = getItemByNameAndPath(name, normPath);

  if (!existing) {
    const info = insertItem({ name, file_path: normPath, signature, source_text, ast_hash, item_type });
    return { id: info.lastInsertRowid, isNew: true, changed: false };
  }

  if (existing.ast_hash !== ast_hash) {
    updateItem(existing.id, { signature, source_text, ast_hash });
    return { id: existing.id, isNew: false, changed: true };
  }

  return { id: existing.id, isNew: false, changed: false };
}

/**
 * Save (insert) a documentation record for a code_item.
 */
function saveDoc({
  code_item_id,
  content,
  overall_score,
  description_score,
  params_score,
  return_score,
  examples_score,
  edge_cases_score,
  missing_fields,
  status,
}) {
  return execute(
    `INSERT INTO documentation
       (code_item_id, content, overall_score, description_score, params_score,
        return_score, examples_score, edge_cases_score, missing_fields, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      code_item_id,
      content,
      overall_score,
      description_score,
      params_score,
      return_score,
      examples_score,
      edge_cases_score,
      typeof missing_fields === 'object' ? JSON.stringify(missing_fields) : missing_fields,
      status || 'draft',
    ]
  );
}

/**
 * Get the latest documentation for a given code_item_id.
 */
function getDocForItem(codeItemId) {
  return queryOne(
    'SELECT * FROM documentation WHERE code_item_id = ? ORDER BY created_at DESC LIMIT 1',
    [codeItemId]
  );
}

/**
 * Insert a new event into the events table.
 */
function insertEvent({ event_type, payload, status }) {
  return execute(
    `INSERT INTO events (event_type, payload, status)
     VALUES (?, ?, ?)`,
    [
      event_type,
      typeof payload === 'object' ? JSON.stringify(payload) : payload,
      status || 'pending',
    ]
  );
}

/**
 * Update the status (and optional error message) of an event.
 */
function updateEventStatus(id, status, errorMsg) {
  return execute(
    'UPDATE events SET status = ?, error_msg = ? WHERE id = ?',
    [status, errorMsg || null, id]
  );
}

/**
 * Get pending events, oldest first.
 */
function getPendingEvents(limit = 50) {
  return queryAll(
    "SELECT * FROM events WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
    [limit]
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ready,
  persist,
  getDb: () => db,
  getItem,
  getItemByNameAndPath,
  getAllItems,
  insertItem,
  updateItem,
  upsertItem,
  saveDoc,
  getDocForItem,
  insertEvent,
  updateEventStatus,
  getPendingEvents,
};
