/**
 * FILE SUMMARY: Billing Dashboard Route
 * DATA FLOW: Browser --> GET /billing-dashboard --> billingStore --> inline HTML
 * INTEGRATION PATTERN: Server-rendered dashboard (same pattern as /bss and /audit).
 *   Shows billing events as cards, Gate A idempotency store, and reversal queue.
 *   Auto-refreshes every 5 seconds.
 */

import { Router } from 'express';

const TTL_GATE_A_MS   = 90 * 24 * 60 * 60 * 1000;
const TTL_REVERSAL_MS = 72 * 60 * 60 * 1000;

function fmtTtl(remainingMs) {
  if (remainingMs <= 0) return 'expired';
  const days  = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) return `${days}d ${hours}h remaining`;
  const mins = Math.floor((remainingMs % (60 * 60 * 1000)) / 60000);
  return `${hours}h ${mins}m remaining`;
}

export default function billingDashboardRoutes({ billingStore }) {
  const router = Router();

  router.get('/billing-dashboard', (req, res) => {
    try {
      const billing       = billingStore.getAll();
      const gateA         = billingStore.getAllGateA();
      const reversalQueue = billingStore.getAllReversalQueue();
      const now           = Date.now();

      // ── §1 Billing Event Cards ─────────────────────────────────────────────
      const billingEntries = Object.entries(billing);
      const billingCards = billingEntries.length === 0
        ? '<p class="empty">No billing events yet. Use BSS Admin to mark an order funded.</p>'
        : billingEntries.map(([pk, r]) => {
            const [clientId, loanNumber] = pk.split(':');
            const isVoided = r.status === 'voided';
            const pill = isVoided
              ? '<span class="pill voided">VOIDED</span>'
              : '<span class="pill pending">PENDING</span>';
            const voidedRow = isVoided && r.voidedAt
              ? `<tr><th>voidedAt</th><td>${r.voidedAt}</td></tr>` : '';
            const orderIdsList = (r.orderIds || [r.orderId]).filter(Boolean).join(', ');
            return `
<div class="card ${isVoided ? 'card-voided' : 'card-pending'}">
  <div class="card-header">${pill} <code>${pk}</code></div>
  <table class="card-table">
    <tr><th>pk</th>         <td><code>${pk}</code></td></tr>
    <tr><th>loan_number</th><td><code>${loanNumber || '—'}</code></td></tr>
    <tr><th>client_id</th>  <td><code>${clientId || '—'}</code></td></tr>
    <tr><th>fundedAt</th>   <td>${r.fundedAt || '—'}</td></tr>
    <tr><th>createdAt</th>  <td>${r.createdAt || '—'}</td></tr>
    ${voidedRow}
    <tr><th>orderIds</th>   <td><code>${orderIdsList || '—'}</code></td></tr>
  </table>
</div>`;
          }).join('');

      // ── §2 Gate A Idempotency Store ────────────────────────────────────────
      const gateAEntries = Object.entries(gateA);
      const gateARows = gateAEntries.length === 0
        ? `<tr><td colspan="3" class="empty">No idempotency keys recorded yet</td></tr>`
        : gateAEntries.map(([key, entry]) => {
            const remaining = TTL_GATE_A_MS - (now - entry.receivedAt);
            return `
      <tr>
        <td><code>${key}</code></td>
        <td>${new Date(entry.receivedAt).toISOString()}</td>
        <td class="ttl">${fmtTtl(remaining)}</td>
      </tr>`;
          }).join('');

      // ── §3 Reversal Queue ──────────────────────────────────────────────────
      const reversalEntries = Object.entries(reversalQueue);
      const reversalRows = reversalEntries.length === 0
        ? `<tr><td colspan="3" class="empty">No pending reversals</td></tr>`
        : reversalEntries.map(([key, entry]) => {
            const remaining = TTL_REVERSAL_MS - (now - entry.heldAt);
            return `
      <tr>
        <td><code>${key}</code></td>
        <td>${new Date(entry.heldAt).toISOString()}</td>
        <td class="ttl">${fmtTtl(remaining)}</td>
      </tr>`;
          }).join('');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Billing Dashboard</title>
  <style>
    body  { font-family: monospace; padding: 2rem; background: #f9f9f9; max-width: 1100px; margin: 0 auto; }
    h1    { margin-bottom: 0.25rem; }
    .meta { color: #888; font-size: 0.8rem; margin-bottom: 1.25rem; }
    nav   { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 2rem; }
    nav a { color: #1a3a5c; text-decoration: none; font-size: 0.85rem;
            padding: 0.3rem 0.9rem; border: 1px solid #bbb; border-radius: 4px; }
    nav a:hover { background: #e8eef4; border-color: #1a3a5c; }
    h2    { margin: 2.5rem 0 0.75rem; font-size: 0.8rem; text-transform: uppercase;
            letter-spacing: 0.1em; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 0.4rem; }

    /* Billing event cards */
    .cards      { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1rem; }
    .card       { background: white; border-radius: 8px; border: 1px solid #ccc;
                  overflow: hidden; }
    .card-pending { border-left: 4px solid #1a7f37; }
    .card-voided  { border-left: 4px solid #aaa; }
    .card-header  { padding: 0.6rem 1rem; background: #f5f5f5; border-bottom: 1px solid #e0e0e0;
                    display: flex; align-items: center; gap: 0.75rem; font-size: 0.8rem; }
    .card-table   { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .card-table th { text-align: left; padding: 0.3rem 0.8rem; color: #666;
                     font-weight: 600; width: 30%; border-bottom: 1px solid #f0f0f0; }
    .card-table td { padding: 0.3rem 0.8rem; border-bottom: 1px solid #f0f0f0; }

    /* Gate A + Reversal Queue tables */
    table.section { border-collapse: collapse; width: 100%; background: white; margin-bottom: 0.5rem; }
    table.section th, table.section td { border: 1px solid #ccc; padding: 0.4rem 0.8rem;
                                          text-align: left; font-size: 0.85rem; }
    table.section th { background: #eee; font-weight: 600; }

    .pill    { display: inline-block; font-weight: bold; padding: 0.15rem 0.6rem;
               border-radius: 3px; font-size: 0.75rem; }
    .pending { color: #1a7f37; background: #dafbe1; }
    .voided  { color: #666;    background: #e8e8e8; }
    .ttl     { color: #888; font-size: 0.8rem; }
    .empty   { color: #aaa; font-style: italic; padding: 0.75rem 0.8rem; }
    code     { font-family: monospace; }
  </style>
</head>
<body>
  <h1>Billing Dashboard</h1>
  <p class="meta">Auto-refreshes every 5 seconds &nbsp;·&nbsp; <span id="countdown">5</span>s until next refresh</p>

  <nav>
    <a href="/bss">BSS Admin</a>
    <a href="/audit">Audit Log</a>
  </nav>

  <h2>§1 — Billing Events</h2>
  <div class="cards">${billingCards}</div>

  <h2>§2 — Gate A Idempotency Store</h2>
  <table class="section">
    <thead><tr><th>idempotency_key</th><th>receivedAt</th><th>TTL remaining (90d stub)</th></tr></thead>
    <tbody>${gateARows}</tbody>
  </table>

  <h2>§3 — Reversal Queue</h2>
  <table class="section">
    <thead><tr><th>composite key</th><th>heldAt</th><th>TTL remaining (72h)</th></tr></thead>
    <tbody>${reversalRows}</tbody>
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
