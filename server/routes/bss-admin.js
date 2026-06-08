/**
 * FILE SUMMARY: BSS Admin Simulation Routes
 * DATA FLOW: Browser --> GET /bss (admin UI) --> POST /api/bss/fund|reverse/:order_id
 *            --> generateBssSign() --> POST /api/funded/:order_id (loopback)
 * INTEGRATION PATTERN: Simulates Blue Sage Solutions (LOS) sending funded/reversal
 *   notifications to the Truv stub. Uses loopback fetch so signatures are real.
 */

import { Router } from 'express';
import { generateBssSign } from '../bss-signing.js';

const BSS_CLIENT_ID      = process.env.BSS_CLIENT_ID      || 'bss_wc_001';
const BSS_ACCESS_SECRET  = process.env.BSS_ACCESS_SECRET  || 'bss_secret_dev';
const BSS_SIGNING_SECRET = process.env.BSS_SIGNING_SECRET || 'bss_signing_dev';
const FUNDED_BASE        = `http://localhost:${process.env.PORT || 3000}`;

export default function bssAdminRoutes({ db, billingStore }) {
  const router = Router();

  // GET /bss — Admin HTML page listing all orders with fund / reverse actions.
  // Calls db.getAllOrders() at render time; button results update inline via fetch.
  router.get('/bss', (req, res) => {
    try {
      const orders  = db.getAllOrders();
      const billing = billingStore.getAll();

      const rows = orders.map(order => {
        const key      = `${BSS_CLIENT_ID}:${order.loan_number}`;
        const record   = billing[key];
        const fundedAt = record?.fundedAt || '—';
        const disabled = order.loan_number ? '' : ' disabled title="No loan_number on this order"';
        return `
      <tr>
        <td>${order.loan_number || '<em style="color:#999">none</em>'}</td>
        <td><code style="word-break:break-all;font-size:0.75em">${order.truv_order_id}</code></td>
        <td>${order.status}</td>
        <td>${fundedAt}</td>
        <td>
          <button${disabled} onclick="act('fund','${order.id}',this)">Mark Funded</button>
          <button${disabled} onclick="act('reverse','${order.id}',this)">Reverse</button>
        </td>
        <td id="r-${order.id}"></td>
      </tr>`;
      }).join('');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>BSS Admin</title>
  <style>
    body  { font-family: monospace; padding: 2rem; background: #f9f9f9; }
    h1    { margin-bottom: 0.25rem; }
    .meta { color: #666; margin-bottom: 1.5rem; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th,td { border: 1px solid #ccc; padding: 0.4rem 0.8rem; text-align: left; }
    th    { background: #eee; }
    nav   { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 2rem; }
    nav a { color: #1a3a5c; text-decoration: none; font-size: 0.85rem;
            padding: 0.3rem 0.9rem; border: 1px solid #bbb; border-radius: 4px; }
    nav a:hover { background: #e8eef4; border-color: #1a3a5c; }
    button         { cursor: pointer; padding: 0.2rem 0.6rem; margin: 0 0.15rem; }
    button:disabled{ opacity: 0.45; cursor: default; }
    .res     { font-weight: bold; }
    .res.ok  { color: #1a7f37; }
    .res.err { color: #cf222e; }
  </style>
</head>
<body>
  <h1>BSS Admin — Funded Simulation</h1>
  <p class="meta">Client: <code>${BSS_CLIENT_ID}</code></p>
  <nav>
    <a href="http://localhost:5173/#lion">← New Verification</a>
    <a href="/audit">Audit Log</a>
    <a href="/billing-dashboard">Billing Dashboard</a>
  </nav>
  <table>
    <thead><tr>
      <th>loan_number</th><th>order_id</th><th>status</th>
      <th>funded_at</th><th>actions</th><th>result</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
    async function act(action, orderId, btn) {
      btn.disabled = true;
      const cell = document.getElementById('r-' + orderId);
      cell.textContent = '…';
      cell.className = 'res';
      try {
        const res  = await fetch('/api/bss/' + action + '/' + orderId, { method: 'POST' });
        let body = {};
        try { body = await res.json(); } catch {}
        const label = res.status + (body.error ? ' — ' + body.error : body.message ? ' — ' + body.message : '');
        cell.textContent = label;
        cell.className   = 'res ' + (res.status === 200 ? 'ok' : 'err');
      } catch {
        cell.textContent = 'network error';
        cell.className   = 'res err';
      }
      btn.disabled = false;
    }
  </script>
</body>
</html>`);
    } catch (err) {
      console.error(err);
      res.status(500).send('Internal server error');
    }
  });

  // Shared helper: build, sign, and POST a funded/reversal payload to /api/funded/:order_id.
  // The raw body string is signed before fetch so signature verification in funded.js is real.
  async function callFunded(orderId, funded) {
    const order = db.getOrder(orderId);
    if (!order)            return { status: 404, body: { error: 'Order not found' } };
    if (!order.loan_number) return { status: 400, body: { error: 'Order has no loan_number' } };

    const date   = new Date().toISOString().slice(0, 10);
    const ikey   = `${BSS_CLIENT_ID}-${order.loan_number}-${date}-${funded ? '' : 'reversal-'}v1`;
    const payload = {
      loan_number:     order.loan_number,
      order_id:        orderId,
      funded,
      idempotency_key: ikey,
      ...(funded
        ? { funded_at: new Date().toISOString() }
        : { reversal_reason: 'rescission' }),
    };

    const rawBody = JSON.stringify(payload);
    const sig     = generateBssSign(rawBody, BSS_SIGNING_SECRET);

    const resp = await fetch(`${FUNDED_BASE}/api/funded/${orderId}`, {
      method: 'POST',
      headers: {
        'Content-Type':       'application/json',
        'X-BSS-Webhook-Sign': sig,
        'X-Access-Client-Id': BSS_CLIENT_ID,
        'X-Access-Secret':    BSS_ACCESS_SECRET,
      },
      body: rawBody,
    });

    let body = {};
    try { body = await resp.json(); } catch {}
    return { status: resp.status, body };
  }

  // POST /api/bss/fund/:order_id — Simulate a funding notification from BSS.
  router.post('/api/bss/fund/:order_id', async (req, res) => {
    try {
      const { status, body } = await callFunded(req.params.order_id, true);
      res.status(status).json(body);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/bss/reverse/:order_id — Simulate a reversal notification from BSS.
  router.post('/api/bss/reverse/:order_id', async (req, res) => {
    try {
      const { status, body } = await callFunded(req.params.order_id, false);
      res.status(status).json(body);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
