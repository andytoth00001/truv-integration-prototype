/**
 * FILE SUMMARY: Truv Funded Notification Endpoint Stub
 * DATA FLOW: BSS (bss-admin.js) --> POST /api/funded/:order_id --> billingStore
 * INTEGRATION PATTERN: Implements the Truv-side funded notification handler (Steps 1-7
 *   from PRD Section 4.5.3). Verifies BSS signature and credentials, enforces two
 *   idempotency gates, creates or voids billing records, persists idempotency keys.
 */

import { Router } from 'express';
import { verifyBssSign } from '../bss-signing.js';

const BSS_CLIENT_ID      = process.env.BSS_CLIENT_ID      || 'bss_wc_001';
const BSS_ACCESS_SECRET  = process.env.BSS_ACCESS_SECRET  || 'bss_secret_dev';
const BSS_SIGNING_SECRET = process.env.BSS_SIGNING_SECRET || 'bss_signing_dev';

export default function fundedRoutes({ db, billingStore }) {
  const router = Router();

  // POST /api/funded/:order_id — funded notification handler, Steps 1-7.
  // All db and billingStore calls are synchronous; no async needed.
  router.post('/api/funded/:order_id', (req, res) => {
    // Step 1 — Verify BSS payload signature (X-BSS-Webhook-Sign: plain hex, no v1= prefix)
    const headerSig = req.headers['x-bss-webhook-sign'];
    if (!verifyBssSign(req.rawBody, BSS_SIGNING_SECRET, headerSig)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Step 2 — Validate credentials from headers; client_id is the trust anchor
    const clientId     = req.headers['x-access-client-id'];
    const accessSecret = req.headers['x-access-secret'];
    if (clientId !== BSS_CLIENT_ID || accessSecret !== BSS_ACCESS_SECRET) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Step 3 — Look up order (metadata only — not a billing key source)
    const order = db.getOrder(req.params.order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Step 4 — Idempotency gates
    const { idempotency_key, loan_number, funded, funded_at } = req.body;
    const orderId = req.params.order_id;

    // Gate A: exact-retry guard (applies to both fund and reversal requests)
    if (billingStore.has(idempotency_key)) {
      return res.status(409).json({ error: 'Gate A duplicate', gate: 'A' });
    }

    // Gate B: structural dedup — funded events only; reversals need the record to exist
    if (funded && billingStore.exists(clientId, loan_number)) {
      return res.status(409).json({ error: 'Gate B duplicate', gate: 'B' });
    }

    // Steps 5 / 6 — Create or void billing event
    if (funded) {
      // Step 5: Create billing record; check reversal queue and apply void immediately if held
      billingStore.create(clientId, loan_number, {
        orderId,
        orderIds:   [orderId],
        fundedAt:   funded_at,
        loanNumber: loan_number,
        status:     'pending',
      });

      const held = billingStore.getReversal(clientId, loan_number);
      if (held) {
        billingStore.void(clientId, loan_number);
        billingStore.deleteReversal(clientId, loan_number);
      }
    } else {
      // Step 6: Void existing record, or hold the reversal until the funded event arrives
      if (billingStore.exists(clientId, loan_number)) {
        billingStore.void(clientId, loan_number);
      } else {
        billingStore.holdReversal(clientId, loan_number, req.body);
      }
    }

    // Step 7 — Persist idempotency key and return
    billingStore.set(idempotency_key);

    return res.status(200).json({
      message:   'ok',
      gate_a_key: idempotency_key,
      gate_b_key: `${clientId}:${loan_number}`,
    });
  });

  // GET /api/billing — Debug: full billing store dump (all three maps).
  router.get('/api/billing', (_req, res) => {
    res.json({
      billing:        billingStore.getAll(),
      gate_a:         billingStore.getAllGateA(),
      reversal_queue: billingStore.getAllReversalQueue(),
    });
  });

  return router;
}
