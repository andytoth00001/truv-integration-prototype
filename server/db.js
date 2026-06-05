/**
 * FILE SUMMARY: SQLite Database Schema and CRUD Operations
 * DATA FLOW: Express route handlers --> db.* functions --> SQLite (demo-apps.db)
 * INTEGRATION PATTERN: Shared by both Orders flow and Bridge flow.
 *
 * Defines the database schema (orders, api_logs, webhook_events, reports,
 * document_collections) and exposes helper functions for all reads and writes.
 * JSON serialization is handled automatically so callers pass plain objects.
 */

// Imports: better-sqlite3 for synchronous SQLite, crypto for ID generation
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// Database file path: stored at project root as demo-apps.db
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'demo-apps.db');

// Singleton database connection with lazy initialization
let db;

// Returns the singleton connection, creating it on first call.
// Enables WAL mode for concurrent reads and foreign key enforcement.
function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// Schema initialization: creates all tables and indexes if they don't exist.
// Also runs safe migrations to add columns that may be missing from older schemas.
// SQLite DDL exec -- not child_process.exec
export function initDb() {
  const conn = getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      truv_order_id TEXT,
      user_id TEXT,
      demo_id TEXT,
      bridge_token TEXT,
      share_url TEXT,
      status TEXT DEFAULT 'created',
      raw_response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      session_id TEXT,
      method TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      request_body TEXT,
      response_body TEXT,
      status_code INTEGER,
      duration_ms REAL,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      webhook_id TEXT,
      event_type TEXT,
      status TEXT,
      payload TEXT,
      received_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      report_type TEXT NOT NULL,
      truv_report_id TEXT,
      status TEXT DEFAULT 'pending',
      response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_order_type ON reports(order_id, report_type);
    CREATE INDEX IF NOT EXISTS idx_reports_order_id ON reports(order_id);

    CREATE TABLE IF NOT EXISTS document_collections (
      id TEXT PRIMARY KEY,
      truv_collection_id TEXT,
      user_id TEXT,
      demo_id TEXT,
      status TEXT DEFAULT 'created',
      raw_response TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_user_id ON webhook_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_logs_user_id ON api_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
  `);

  // Migrate: add columns to existing tables if missing
  try { conn.exec('ALTER TABLE webhook_events ADD COLUMN user_id TEXT'); } catch {}
  try { conn.exec('ALTER TABLE api_logs ADD COLUMN user_id TEXT'); } catch {}
  try { conn.exec('ALTER TABLE orders ADD COLUMN product_type TEXT'); } catch {}
  try { conn.exec('ALTER TABLE document_collections ADD COLUMN user_id TEXT'); } catch {}
  try { conn.exec('ALTER TABLE orders ADD COLUMN loan_number TEXT'); } catch {}
}

// Generates a short random ID for local records (not sent to Truv)
export function generateId() {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

// --- Orders ---
// Orders track the lifecycle of a Truv verification request (created -> completed).

// Inserts a new order row and returns the created record.
export function createOrder({ orderId, truvOrderId, userId, demoId, bridgeToken, shareUrl, status = 'created', rawResponse, loanNumber }) {
  const conn = getDb();
  conn.prepare(
    'INSERT INTO orders (id, truv_order_id, user_id, demo_id, bridge_token, share_url, status, raw_response, loan_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(orderId, truvOrderId || null, userId || null, demoId || null, bridgeToken || null, shareUrl || null, status, rawResponse ? JSON.stringify(rawResponse) : null, loanNumber || null);
  return conn.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

// Retrieves a single order by its local ID.
export function getOrder(orderId) {
  return getDb().prepare('SELECT * FROM orders WHERE id = ?').get(orderId) || null;
}

// Whitelist of columns allowed in order updates (prevents SQL injection via key names)
const ORDER_ALLOWED_COLS = new Set(['status', 'raw_response', 'bridge_token', 'share_url', 'product_type', 'loan_number']);

// Updates allowed fields on an existing order. Objects are JSON-serialized automatically.
export function updateOrder(orderId, fields) {
  const keys = Object.keys(fields).filter(k => ORDER_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => {
    const v = fields[k];
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
  });
  vals.push(orderId);
  getDb().prepare(`UPDATE orders SET ${sets} WHERE id = ?`).run(...vals);
}

// Finds the most recent order for a given Truv user ID. Used by the webhook
// handler to look up which local order corresponds to an incoming event.
export function findOrderByUserId(userId) {
  return getDb().prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) || null;
}

// Returns all orders for a demo ID, sorted newest first.
export function getOrdersByDemoId(demoId) {
  return getDb().prepare('SELECT * FROM orders WHERE demo_id = ? ORDER BY created_at DESC').all(demoId);
}

// Returns all orders across all demos.
export function getAllOrders() {
  return getDb().prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
}

// --- API Logs ---
// Stores redacted API call logs for display in the frontend activity panel.

// Inserts a new API log entry and returns the created record.
export function insertApiLog({ userId, sessionId, method, endpoint, requestBody, responseBody, statusCode, durationMs }) {
  const conn = getDb();
  const info = conn.prepare(
    'INSERT INTO api_logs (user_id, session_id, method, endpoint, request_body, response_body, status_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId || null, sessionId || null, method, endpoint, requestBody || null, responseBody || null, statusCode || null, durationMs || null);
  return conn.prepare('SELECT * FROM api_logs WHERE id = ?').get(info.lastInsertRowid);
}

// Retrieves API logs for a user. When session_id is provided, also includes
// session-scoped logs with no user_id (e.g., pre-order company search calls).
export function getApiLogsByUserId(userId, sessionId) {
  if (sessionId) {
    // Return user-scoped logs + session-scoped logs that have no user_id (pre-order search calls)
    return getDb().prepare('SELECT * FROM api_logs WHERE user_id = ? OR (user_id IS NULL AND session_id = ?) ORDER BY id ASC').all(userId, sessionId);
  }
  return getDb().prepare('SELECT * FROM api_logs WHERE user_id = ? ORDER BY id ASC').all(userId);
}

// --- Webhook Events ---
// Stores inbound webhook events so the frontend can poll for them.

// Inserts a webhook event and returns the created record.
export function insertWebhookEvent({ userId, webhookId, eventType, status, payload }) {
  const conn = getDb();
  const info = conn.prepare(
    'INSERT INTO webhook_events (user_id, webhook_id, event_type, status, payload) VALUES (?, ?, ?, ?, ?)'
  ).run(userId || null, webhookId || null, eventType || null, status || null, payload ? JSON.stringify(payload) : null);
  return conn.prepare('SELECT * FROM webhook_events WHERE id = ?').get(info.lastInsertRowid);
}

// Returns all webhook events for a user, ordered chronologically.
export function getWebhookEventsByUserId(userId) {
  return getDb().prepare('SELECT * FROM webhook_events WHERE user_id = ? ORDER BY id ASC').all(userId);
}

// Resolves user_id for an inbound webhook that lacks one in its payload, by
// consulting prior webhook events for the same link_id. Truv's task-status-updated
// payloads omit user_id but include link_id, while earlier event types
// (link-connected, statements-created, etc.) carry both — so the mapping is
// available as a side-effect of normal webhook ingestion, with no extra schema
// or API calls.
export function findUserByLinkInEvents(linkId) {
  if (!linkId) return null;
  return getDb().prepare(`
    SELECT user_id FROM webhook_events
    WHERE user_id IS NOT NULL
      AND json_extract(payload, '$.link_id') = ?
    ORDER BY received_at DESC LIMIT 1
  `).get(linkId)?.user_id || null;
}



// --- Reports ---
// Tracks async report generation. Uses UPSERT to handle create-then-update in a single call.

// Creates or updates a report record keyed by (order_id, report_type).
// On conflict, merges non-null fields from the new values.
export function upsertReport({ orderId, reportType, truvReportId, status, response }) {
  const conn = getDb();
  const responseStr = response ? (typeof response === 'object' ? JSON.stringify(response) : response) : null;
  conn.prepare(
    `INSERT INTO reports (order_id, report_type, truv_report_id, status, response)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(order_id, report_type) DO UPDATE SET
       truv_report_id = COALESCE(excluded.truv_report_id, truv_report_id),
       status = COALESCE(excluded.status, status),
       response = COALESCE(excluded.response, response)`
  ).run(orderId, reportType, truvReportId || null, status || 'pending', responseStr);
  return conn.prepare('SELECT * FROM reports WHERE order_id = ? AND report_type = ?').get(orderId, reportType);
}

// Retrieves a single report by order ID and report type.
export function getReport(orderId, reportType) {
  return getDb().prepare('SELECT * FROM reports WHERE order_id = ? AND report_type = ?').get(orderId, reportType) || null;
}

// --- Document Collections ---
// Tracks document upload collections for paystub/W2 verification flows.

// Inserts a new document collection record and returns it.
export function createDocCollection({ collectionId, truvCollectionId, userId, demoId, status = 'created', rawResponse }) {
  const conn = getDb();
  conn.prepare(
    'INSERT INTO document_collections (id, truv_collection_id, user_id, demo_id, status, raw_response) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(collectionId, truvCollectionId || null, userId || null, demoId || null, status, rawResponse ? JSON.stringify(rawResponse) : null);
  return conn.prepare('SELECT * FROM document_collections WHERE id = ?').get(collectionId);
}

// Retrieves a document collection by its local ID.
export function getDocCollection(collectionId) {
  return getDb().prepare('SELECT * FROM document_collections WHERE id = ?').get(collectionId) || null;
}

// Whitelist of columns allowed in document collection updates
const DOC_COLLECTION_ALLOWED_COLS = new Set(['status', 'raw_response']);

// Updates allowed fields on an existing document collection.
export function updateDocCollection(collectionId, fields) {
  const keys = Object.keys(fields).filter(k => DOC_COLLECTION_ALLOWED_COLS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => {
    const v = fields[k];
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
  });
  vals.push(collectionId);
  getDb().prepare(`UPDATE document_collections SET ${sets} WHERE id = ?`).run(...vals);
}

// Returns all webhook events across all users, newest first. Used by audit log.
export function getAllWebhookEvents() {
  return getDb().prepare('SELECT * FROM webhook_events ORDER BY id DESC').all();
}

// Returns all reports across all orders, newest first. Used by audit log.
export function getAllReports() {
  return getDb().prepare('SELECT * FROM reports ORDER BY id DESC').all();
}

// Test-only: inject a different Database instance (e.g., in-memory)
export function _setTestDb(testDb) {
  db = testDb;
}
