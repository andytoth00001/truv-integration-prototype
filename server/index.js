/**
 * FILE SUMMARY: Express Server Entry Point
 * DATA FLOW: Frontend (Browser on localhost) --> Express (port 3000) --> Truv API
 * INTEGRATION PATTERN: Supports both Orders flow and Bridge flow via sub-routes.
 *
 * Initializes the Express app, registers middleware, and defines top-level routes
 * for company/provider search, webhook ingestion, and polling endpoints. Delegates
 * demo-specific logic to sub-route modules (orders, reports, bridge, uploads, user-reports).
 */

// Imports: environment config, Express framework, CORS, and all server modules
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import express from 'express';
import cors from 'cors';
import { TruvClient } from './truv.js';
import * as db from './db.js';
import * as apiLogger from './api-logger.js';
import { verifyWebhookSignature } from './webhooks.js';
import { setupWebhook, teardownWebhook } from './webhook-setup.js';
import ordersRoutes from './routes/orders.js';
import reportsRoutes from './routes/reports.js';
import bridgeRoutes from './routes/bridge.js';
import uploadDocumentsRoutes from './routes/upload-documents.js';
import userReportsRoutes from './routes/user-reports.js';
import coverageAnalysisRoutes from './routes/coverage-analysis.js';
import { BillingStore } from './billing-store.js';
import bssAdminRoutes from './routes/bss-admin.js';
import fundedRoutes from './routes/funded.js';
import auditRoutes from './routes/audit.js';
import billingDashboardRoutes from './routes/billing-dashboard.js';

// Configuration: read API credentials from .env and validate they exist
const PORT = process.env.PORT || 3000;
const { API_CLIENT_ID, API_SECRET } = process.env;

if (!API_CLIENT_ID || !API_SECRET) {
  console.error('Missing API_CLIENT_ID or API_SECRET in .env');
  process.exit(1);
}

// Initialization: create the shared TruvClient and initialize the SQLite database.
// These are injected into all sub-route modules as dependencies.
const truv = new TruvClient({ clientId: API_CLIENT_ID, secret: API_SECRET });
const billingStore = new BillingStore();
db.initDb();

// Express setup: JSON body parsing (with raw body capture for webhook HMAC verification)
// and CORS restricted to localhost origins only.
const app = express();
app.use(express.json({ limit: '100mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf-8'); } }));
app.use(cors({ origin: /^http:\/\/localhost(:\d+)?$/ }));

// --- Company search ---
// Frontend --> GET /api/companies?q=... --> Truv company-mappings-search API.
// Used by payroll-based demos to find employers. Logs the API call for the activity panel.
app.get('/api/companies', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.json([]);
    const result = await truv.searchCompanies(query, req.query.product_type);
    apiLogger.logApiCall({ sessionId: req.query.session_id, method: 'GET', endpoint: `/v1/company-mappings-search/?query=${query}`, responseBody: result.data, statusCode: result.statusCode, durationMs: result.durationMs });
    res.json(result.data || []);
  } catch (err) { console.error(err); res.json([]); }
});

// --- Provider search (financial institutions) ---
// Frontend --> GET /api/providers?q=... --> Truv providers API.
// Used by bank/assets demos to find financial institutions.
app.get('/api/providers', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.json([]);
    const result = await truv.searchProviders(query, req.query.product_type, req.query.data_source);
    apiLogger.logApiCall({ sessionId: req.query.session_id, method: 'GET', endpoint: `/v1/providers/?query=${query}`, responseBody: result.data, statusCode: result.statusCode, durationMs: result.durationMs });
    const data = result.data?.results || result.data || [];
    res.json(Array.isArray(data) ? data : []);
  } catch (err) { console.error(err); res.json([]); }
});

// --- Webhook receiver ---
// Truv API --> POST /api/webhooks/truv --> this handler.
// Verifies HMAC-SHA256 signature, updates order status on completion,
// and stores the event in the database for the frontend polling endpoint.
let tunnelUrl = null;

app.post('/api/webhooks/truv', (req, res) => {
  const sigMatch = verifyWebhookSignature(req.rawBody, API_SECRET, req.headers['x-webhook-sign']);
  if (!sigMatch) { console.warn('Webhook signature mismatch'); return res.status(401).end(); }
  console.log(`Webhook: ${req.body.event_type} (${req.body.status || '-'}) user=${req.body.user_id || '-'}`);

  const payload = req.body;
  let userId = payload.user_id || null;
  const linkId = payload.link_id || null;

  // When an order completes, update its status and auto-fetch the report so
  // db.upsertReport() runs regardless of which frontend is active (audit log §3).
  if (userId && payload.event_type === 'order-status-updated' && payload.status === 'completed') {
    const order = db.findOrderByUserId(userId);
    if (order) {
      db.updateOrder(order.id, { status: 'completed' });
      fetch(`http://localhost:${PORT}/api/orders/${order.id}/report`)
        .catch(err => console.error('Auto report fetch failed:', err.message));
    }
  }

  // task-status-updated payloads omit user_id but include link_id. Resolve via
  // prior webhooks for the same link, which carry user_id (link-connected,
  // statements-created, etc.) and seed the lookup as a side-effect of ingestion.
  if (!userId && linkId) userId = db.findUserByLinkInEvents(linkId);

  // Persist the webhook event so the frontend can poll for it
  apiLogger.pushWebhookEvent({ userId, webhookId: payload.webhook_id, eventType: payload.event_type, status: payload.status, payload });
  res.status(200).end();
});

// Returns the ngrok tunnel URL so the frontend can display it
app.get('/api/tunnel-url', (_req, res) => res.json({ url: tunnelUrl }));

// --- Polling endpoints ---
// Frontend polls these to display real-time webhook events and API logs in the activity panel.
app.get('/api/users/:userId/webhooks', (req, res) => res.json(db.getWebhookEventsByUserId(req.params.userId)));
app.get('/api/users/:userId/logs', (req, res) => res.json(db.getApiLogsByUserId(req.params.userId, req.query.session_id)));

// --- Demo routes ---
// Mounts sub-route modules. Each receives the shared { truv, db, apiLogger } dependencies.
const deps = { truv, db, apiLogger, billingStore };
app.use(ordersRoutes(deps));
app.use(reportsRoutes(deps));
app.use(bridgeRoutes(deps));
app.use(uploadDocumentsRoutes(deps));
app.use(userReportsRoutes(deps));
app.use(coverageAnalysisRoutes(deps));
app.use(bssAdminRoutes(deps));
app.use(fundedRoutes(deps));
app.use(auditRoutes(deps));
app.use(billingDashboardRoutes(deps));

// --- Health check ---
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- Static files (production) ---
// In production (after `npm run build`), serve the Vite-built frontend from dist/.
// IMPORTANT: The catch-all '*' route must remain the last registered route.
// Any non-/api route added after this block will be shadowed by the SPA fallback.
const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', 'dist');
if (existsSync(join(distPath, 'index.html'))) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(distPath, 'index.html'), (err) => { if (err) next(err); });
  });
}

// --- Start ---
// Launches the server and registers a webhook URL via ngrok (if NGROK_URL is set in .env).
const server = app.listen(PORT, async () => {
  console.log(`Truv Demo Apps running on http://localhost:${PORT}`);
  try { tunnelUrl = await setupWebhook({ path: '/api/webhooks/truv', truvClient: truv }); } catch (err) { console.error('Webhook setup failed:', err.message); }
});

// Graceful shutdown: tears down webhook, drains connections, then exits.
async function gracefulShutdown() {
  try {
    await Promise.race([teardownWebhook(truv), new Promise(r => setTimeout(r, 5000))]);
  } catch (err) {
    console.error('Webhook teardown failed:', err.message);
  }
  await new Promise((resolve) => {
    server.close((err) => {
      if (err) console.error('Server close failed:', err.message);
      resolve();
    });
  });
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
