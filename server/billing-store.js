/**
 * FILE SUMMARY: BSS Billing In-Memory Store
 * DATA FLOW: POST /api/funded/:order_id --> funded route --> BillingStore --> 200/409
 * INTEGRATION PATTERN: Instantiated once in index.js, injected into deps for funded + bss-admin routes.
 *
 * Enforces two idempotency gates for the funded notification endpoint:
 *   Gate A — exact-retry guard keyed on idempotency_key (90-day TTL stub)
 *   Gate B — structural dedup keyed on {client_id}:{loan_number} (permanent)
 * client_id for Gate B MUST come from the verified auth header, never the payload.
 * Also holds a reversal queue for reversals that arrive before their billing record exists.
 */

const TTL_GATE_A_MS   = 90 * 24 * 60 * 60 * 1000;  // 90 days
const TTL_REVERSAL_MS = 72 * 60 * 60 * 1000;        // 72 hours

export class BillingStore {
  constructor() {
    this._gateA        = new Map();  // idempotency_key -> { receivedAt }
    this._billing      = new Map();  // `${clientId}:${loanNumber}` -> record
    this._reversalQueue = new Map(); // `${clientId}:${loanNumber}` -> { payload, heldAt }
  }

  // Builds the Gate B composite key. clientId must come from the auth header — never the payload.
  _key(clientId, loanNumber) {
    return `${clientId}:${loanNumber}`;
  }

  // --- Gate A ---

  // Returns true if the idempotency_key has been seen within the 90-day TTL; evicts on expiry.
  has(key) {
    const entry = this._gateA.get(key);
    if (!entry) return false;
    if (Date.now() - entry.receivedAt > TTL_GATE_A_MS) { this._gateA.delete(key); return false; }
    return true;
  }

  // Marks an idempotency_key as seen with the current timestamp.
  set(key) {
    this._gateA.set(key, { receivedAt: Date.now() });
  }

  // --- Gate B / Billing ---

  // Returns true if a billing record already exists for this client+loan pair (permanent).
  exists(clientId, loanNumber) {
    return this._billing.has(this._key(clientId, loanNumber));
  }

  // Creates a new billing record keyed on the server-side composite key.
  create(clientId, loanNumber, event) {
    const pk = this._key(clientId, loanNumber);
    this._billing.set(pk, { pk, ...event, status: event.status ?? 'pending', createdAt: new Date().toISOString() });
  }

  // Marks a billing record as voided.
  void(clientId, loanNumber) {
    const pk = this._key(clientId, loanNumber);
    const entry = this._billing.get(pk);
    if (!entry) return;
    this._billing.set(pk, { ...entry, status: 'voided', voidedAt: new Date().toISOString() });
  }

  // Returns all billing records as a plain object (for GET /api/billing).
  getAll() {
    return Object.fromEntries(this._billing);
  }

  // --- Reversal queue ---

  // Holds a reversal payload for 72 hours when the billing record doesn't exist yet.
  holdReversal(clientId, loanNumber, payload) {
    this._reversalQueue.set(this._key(clientId, loanNumber), { payload, heldAt: Date.now() });
  }

  // Returns a held reversal if within TTL, or null (and evicts) if expired.
  getReversal(clientId, loanNumber) {
    const pk = this._key(clientId, loanNumber);
    const entry = this._reversalQueue.get(pk);
    if (!entry) return null;
    if (Date.now() - entry.heldAt > TTL_REVERSAL_MS) { this._reversalQueue.delete(pk); return null; }
    return entry;
  }

  // Removes a held reversal after the billing record is created and void is applied.
  deleteReversal(clientId, loanNumber) {
    this._reversalQueue.delete(this._key(clientId, loanNumber));
  }

  // --- Debug ---

  // Returns all Gate A entries as a plain object.
  getAllGateA() {
    return Object.fromEntries(this._gateA);
  }

  // Returns all reversal queue entries as a plain object.
  getAllReversalQueue() {
    return Object.fromEntries(this._reversalQueue);
  }
}
