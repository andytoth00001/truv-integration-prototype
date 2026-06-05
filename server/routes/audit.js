/**
 * FILE SUMMARY: Audit Log Route
 * DATA FLOW: Browser --> GET /audit --> db + billingStore --> inline HTML
 * INTEGRATION PATTERN: Server-rendered audit log (same pattern as /bss).
 *   Shows all four data sources — orders, webhooks, reports, funded notifications —
 *   in one page. Auto-refreshes every 5 seconds.
 */

import { Router } from 'express';

export default function auditRoutes({ db, billingStore }) {
  const router = Router();

  router.get('/audit', (req, res) => {
    try {
      const orders   = db.getAllOrders();
      const webhooks = db.getAllWebhookEvents();
      const reports  = db.getAllReports();
      const billing  = billingStore.getAll();
      const gateA    = billingStore.getAllGateA();

      // ── §1 Orders ──────────────────────────────────────────────────────────
      const orderRows = orders.length === 0
        ? `<tr><td colspan="4" class="empty">No orders yet</td></tr>`
        : orders.map(o => `
      <tr>
        <td>${o.created_at || '—'}</td>
        <td><code>${o.loan_number || '<em style="color:#999">none</em>'}</code></td>
        <td><code>${o.id}</code></td>
        <td><span class="pill ${o.status === 'completed' ? 'ok' : 'pending-pill'}">${o.status}</span></td>
      </tr>`).join('');

      // ── §2 Webhooks Received ───────────────────────────────────────────────
      // All stored events passed HMAC-SHA256 verification before being written.
      const webhookRows = webhooks.length === 0
        ? `<tr><td colspan="4" class="empty">No webhooks received yet</td></tr>`
        : webhooks.map(w => `
      <tr>
        <td>${w.received_at || '—'}</td>
        <td>${w.event_type || '—'}</td>
        <td>${w.status || '—'}</td>
        <td><span class="pill ok">SIG OK</span></td>
      </tr>`).join('');

      // ── §3 Reports Retrieved ───────────────────────────────────────────────
      const reportRows = reports.length === 0
        ? `<tr><td colspan="4" class="empty">No reports yet</td></tr>`
        : reports.map(r => `
      <tr>
        <td>${r.created_at || '—'}</td>
        <td><code>${r.order_id}</code></td>
        <td>${r.report_type}</td>
        <td><span class="pill ${r.status === 'done' ? 'ok' : 'pending-pill'}">${r.status}</span></td>
      </tr>`).join('');

      // ── §4 Funded Notifications ────────────────────────────────────────────
      // Joins billing records with Gate A store to surface the idempotency key used.
      const billingEntries = Object.entries(billing);
      const fundedRows = billingEntries.length === 0
        ? `<tr><td colspan="6" class="empty">No funded notifications yet</td></tr>`
        : billingEntries.map(([bKey, record]) => {
            const loanNum  = record.loanNumber || bKey.split(':')[1] || '—';
            const gateAKey = Object.keys(gateA).find(k => k.includes(loanNum)) || '—';
            const isVoided = record.status === 'voided';
            return `
      <tr>
        <td>${record.createdAt || '—'}</td>
        <td><code>${loanNum}</code></td>
        <td><code style="font-size:0.8em">${gateAKey}</code></td>
        <td><code>${bKey}</code></td>
        <td><span class="pill ${isVoided ? 'voided' : 'ok'}">${record.status?.toUpperCase() || '—'}</span></td>
        <td>—</td>
      </tr>`;
          }).join('');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Audit Log</title>
  <style>
    body  { font-family: monospace; padding: 2rem; background: #f9f9f9; max-width: 1200px; margin: 0 auto; }
    h1    { margin-bottom: 0.25rem; }
    .meta { color: #888; font-size: 0.8rem; margin-bottom: 1.25rem; }
    nav   { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 2rem; }
    nav a { color: #1a3a5c; text-decoration: none; font-size: 0.85rem;
            padding: 0.3rem 0.9rem; border: 1px solid #bbb; border-radius: 4px; }
    nav a:hover { background: #e8eef4; border-color: #1a3a5c; }
    h2    { margin: 2.5rem 0 0.5rem; font-size: 0.8rem; text-transform: uppercase;
            letter-spacing: 0.1em; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 0.4rem; }
    table { border-collapse: collapse; width: 100%; background: white; margin-bottom: 0.5rem; }
    th,td { border: 1px solid #ccc; padding: 0.4rem 0.8rem; text-align: left; font-size: 0.85rem; }
    th    { background: #eee; font-weight: 600; }
    .pill { display: inline-block; font-weight: bold; padding: 0.1rem 0.5rem;
            border-radius: 3px; font-size: 0.75rem; }
    .ok           { color: #1a7f37; background: #dafbe1; }
    .voided       { color: #666;    background: #e8e8e8; }
    .pending-pill { color: #b45309; background: #fef3c7; }
    .empty        { color: #aaa; font-style: italic; padding: 0.75rem 0.8rem; }
    code          { font-family: monospace; }
    .refresh      { float: right; color: #aaa; font-size: 0.75rem; }
  </style>
</head>
<body>
  <h1>Audit Log</h1>
  <p class="meta">Auto-refreshes every 5 seconds &nbsp;·&nbsp; <span id="countdown">5</span>s until next refresh</p>

  <nav>
    <a href="http://localhost:5173/#lion">⊕ New Verification</a>
    <a href="/bss">BSS Admin</a>
    <a href="/billing-dashboard">Billing</a>
  </nav>

  <h2>§1 — Orders</h2>
  <table>
    <thead><tr><th>timestamp</th><th>loan_number</th><th>order_id</th><th>status</th></tr></thead>
    <tbody>${orderRows}</tbody>
  </table>

  <h2>§2 — Webhooks Received</h2>
  <table>
    <thead><tr><th>timestamp</th><th>event_type</th><th>status</th><th>sig_verified</th></tr></thead>
    <tbody>${webhookRows}</tbody>
  </table>

  <h2>§3 — Reports Retrieved</h2>
  <table>
    <thead><tr><th>timestamp</th><th>order_id</th><th>report_type</th><th>status</th></tr></thead>
    <tbody>${reportRows}</tbody>
  </table>

  <h2>§4 — Funded Notifications</h2>
  <table>
    <thead><tr><th>timestamp</th><th>loan_number</th><th>gate_a_key</th><th>gate_b_key</th><th>result</th><th>gate fired</th></tr></thead>
    <tbody>${fundedRows}</tbody>
  </table>

  <script>
    let t = 5;
    const el = document.getElementById('countdown');
    setInterval(() => { t--; el.textContent = t; if (t <= 0) location.reload(); }, 1000);
  </script>
</body>
</html>`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal server error');
    }
  });

  return router;
}
