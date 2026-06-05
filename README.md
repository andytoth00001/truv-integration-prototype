# Truv Integration Prototype
### Andrew Toth — Lead PM, Implementation (Mortgage BU)
### Case Study Submission

---

## Overview

Full-stack prototype demonstrating a Truv
mortgage integration with a net-new PCL
billing notification flow.

Built on the Truv QuickStart, extended with:
- LION POS borrower intake form with embedded Bridge
- BSS Admin simulation (Blue Sage LOS)
- Truv-side funded notification endpoint stub
  implementing PRD Section 4.5.3 Steps 1-7
- Real-time audit log and billing dashboard

---

## Quick Start

**Prerequisites:**
- Node.js 18+
- ngrok (free account at ngrok.com)

**Setup:**
```sh
git clone https://github.com/andytoth00001/truv-integration-prototype
cd demo-apps
cp .env.example .env
# Add your Truv sandbox credentials to .env
# API_CLIENT_ID and API_SECRET from app.truv.com
npm install
```

**Start ngrok (separate terminal):**
```sh
ngrok http 3000
# Copy the https URL to NGROK_URL in .env
```

**Start the app:**
```sh
npm start
# Express on localhost:3000
# Vite on localhost:5173
```

---

## Demo Walkthrough

Follow these four steps in order.
The `loan_number` is the thread connecting all steps.

### Step 1 — LION POS (`localhost:5173/#lion`)
- Loan officer fills borrower intake form
- Borrower completes income verification via Bridge
- Completion screen shows `loan_number` + `order_id`
- Click **"Go to BSS Admin"**

### Step 2 — Audit Log (`localhost:3000/audit`)
- §1 Orders — new order with `loan_number`
- §2 Webhooks — `order-status-updated`, **SIG OK**
- §3 Reports — VOIE report retrieved
- §4 Funded — populates after Step 3

### Step 3 — BSS Admin (`localhost:3000/bss`)
- Row shows `loan_number` with active buttons
- Click **"Mark Funded"** → green `200 ok`
- Click **"Mark Funded"** again → red `409 Gate A duplicate`
- Click **"Reverse"** → `200 voided`

### Step 4 — Billing Dashboard (`localhost:3000/billing-dashboard`)
- §1 Billing Events — card with PENDING or VOIDED status
- §2 Gate A Store — idempotency keys with TTL countdown
- §3 Reversal Queue — held reversals (72h TTL)
- Auto-refreshes every 5 seconds

---

## Architecture

```
localhost:5173 (Vite)
  LION POS borrower form
  TruvBridge inline embed
  Completion screen

localhost:3000 (Express)
  POST /api/orders/            Create Truv order
  POST /api/webhooks/truv      Receive Truv webhooks (HMAC-SHA256 verified)
  GET  /api/orders/:id/report  Retrieve VOIE report
  POST /api/funded/:order_id   Truv funded stub (Steps 1-7, Gate A + Gate B)
  GET  /bss                    BSS admin simulation
  GET  /audit                  Real-time audit log
  GET  /billing-dashboard      PCL billing dashboard
  GET  /api/billing            Raw billing store JSON

SQLite (demo-apps.db)
  orders, webhook_events, reports, api_logs

In-memory billing store
  Gate A: idempotency_key Map (TTL 90d)
  Gate B: {client_id}:{loan_number} Map
  Reversal queue (TTL 72h)
```

---

## Key Design Decisions

**Composite billing key: `{client_id}:{loan_number}`**
- `client_id` derived from `X-Access-Client-Id` header
- Never from payload — trust boundary enforced in billing store

**Two-gate idempotency:**
- Gate A — exact retry guard (same idempotency_key fired twice)
- Gate B — structural dedup (same loan, any event)
- Gate A alone is not sufficient

**Three-layer inbound security:**
1. `X-BSS-Webhook-Sign` HMAC-SHA256 payload signing
2. `X-Access-Client-Id` + `X-Access-Secret` credentials
3. TLS 1.2+ transport

**Funded endpoint:**
- `POST /api/funded/:order_id` handles both webhook trigger and REST fallback
- Same URL, same payload, same processing

**Billing store is in-memory by design**
- Resets on server restart — intentional for prototype
- Production would persist to database

---

## Failure Mode Demo

The 409 Gate A duplicate is built in — no setup needed.

Run Step 3 and click **Mark Funded** twice on any order:
```
First click  → 200 ok              (billing event created)
Second click → 409 Gate A duplicate (exact retry blocked)
```

**Gate B (structural duplicate):**
Fund a loan, then try to fund it again with a different idempotency key — Gate B fires.

**Reversal-before-funded:**
1. Click **Reverse** before **Mark Funded**
2. Check `/billing-dashboard` §3 — reversal held in queue
3. Then click **Mark Funded** — event created and immediately voided, queue clears

---

## PRD

Full integration PRD included: `Truv_PRD_Andrew_Toth_PCL.PDF`

Sections relevant to this prototype:
- Section 4.4 — Truv processing logic Steps 1-7
- Section 4.5 — Truv endpoint specification
- Section 3.5 — Webhook contracts
- Section 3.5.6 — Idempotency design

---

## Demo Walkthrough (Video)

[Loom link — TBA]

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 18+, Express, better-sqlite3 |
| Frontend | Vite + Preact |
| Tunnel | ngrok |
| Persistence | SQLite (orders, events), in-memory Maps (billing) |
| Auth | HMAC-SHA256 (inbound + outbound), credential headers |

---

## Sandbox Credentials

| Field | Value |
|-------|-------|
| Employer | **Home Depot** (or any company) |
| Login | `goodlogin` |
| Password | `goodpassword` |
