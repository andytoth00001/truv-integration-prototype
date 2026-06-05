/**
 * FILE SUMMARY: LION POS — Loan Officer Income Verification
 * DATA FLOW: Form submit -> POST /api/orders -> TruvBridge (inline embed)
 *            -> onSuccess -> success screen with BSS Admin + Audit Log links
 * INTEGRATION PATTERN: Orders flow with embedded Bridge. B2B mortgage officer UI.
 *   Navy/white professional styling — not consumer-facing.
 */

import { useState, useRef, useEffect } from 'preact/hooks';
import { API_BASE } from '../components/hooks.js';

export function LionPosPage() {
  const [form, setForm]           = useState(() => {
    const FIRST = ['James','Maria','David','Sarah','Michael','Linda','Robert','Patricia','William','Barbara'];
    const LAST  = ['Johnson','Martinez','Thompson','Garcia','Anderson','Wilson','Taylor','Moore','Jackson','White'];
    const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
    return { firstName: pick(FIRST), lastName: pick(LAST), loanNumber: `2026-WC-${Date.now().toString().slice(-6)}` };
  });
  const [submitting, setSubmitting] = useState(false);
  const [order, setOrder]         = useState(null);
  const [bridgeDone, setBridgeDone] = useState(false);
  const [error, setError]         = useState(null);
  const containerRef  = useRef(null);
  const bridgeInitRef = useRef(false);
  const bridgeDoneRef = useRef(false);   // ref copy avoids stale closure in onClose

  // Initialize TruvBridge once we have a bridge_token and a mounted container.
  useEffect(() => {
    if (!order?.bridge_token || !containerRef.current || bridgeInitRef.current) return;
    if (!window.TruvBridge) { setError('TruvBridge SDK not loaded'); return; }
    bridgeInitRef.current = true;

    const b = window.TruvBridge.init({
      bridgeToken: order.bridge_token,
      isOrder: true,
      position: { type: 'inline', container: containerRef.current },
      onSuccess: () => {
        bridgeDoneRef.current = true;
        setBridgeDone(true);
        // Background fetch — triggers db.upsertReport() so audit log §3 populates.
        fetch(`${API_BASE}/api/orders/${order.order_id}/report`).catch(() => {});
      },
      onClose: () => {
        if (!bridgeDoneRef.current) { setOrder(null); bridgeInitRef.current = false; }
      },
    });
    b.open();
    return () => { try { b.close(); } catch {} };
  }, [order?.bridge_token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const resp = await fetch(`${API_BASE}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name:  form.firstName,
          last_name:   form.lastName,
          loan_number: form.loanNumber,
          products:    ['income'],
          demo_id:     'lion-pos',
        }),
      });
      const data = await resp.json();
      if (!resp.ok) { setError(data.error || 'Order creation failed'); setSubmitting(false); return; }
      setOrder(data);
    } catch {
      setError('Network error. Please try again.');
    }
    setSubmitting(false);
  }

  // ── Success screen ──────────────────────────────────────────────────────────
  if (bridgeDone) {
    return (
      <div class="min-h-screen bg-[#f0f4f8] flex flex-col">
        <NavBar />
        <div class="flex-1 flex items-center justify-center p-6">
          <div class="bg-white rounded-2xl shadow-sm border border-[#d2d2d7] max-w-md w-full p-8 text-center">
            <div class="w-14 h-14 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-5">
              <svg class="w-7 h-7 text-[#34c759]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 class="text-[20px] font-semibold text-[#171717] mb-2">Verification Complete</h2>
            <p class="text-[15px] text-[#8E8E93] mb-6">
              Loan{' '}
              <span class="font-mono font-semibold text-[#171717]">{form.loanNumber}</span>
              {' '}is ready to fund.
            </p>
            <div class="text-[12px] font-mono text-[#8E8E93] mb-8 bg-[#f5f5f7] rounded-lg p-3 text-left space-y-1">
              <div>order_id:&nbsp;&nbsp;&nbsp;<span class="text-[#171717]">{order?.order_id}</span></div>
              <div>loan_number: <span class="text-[#171717]">{form.loanNumber}</span></div>
            </div>
            <div class="flex flex-col gap-3">
              <a href="http://localhost:3000/bss"
                class="block w-full py-3 bg-[#1a3a5c] text-white text-[14px] font-semibold rounded-xl hover:bg-[#163354] text-center">
                Go to BSS Admin
              </a>
              <a href="http://localhost:3000/audit"
                class="block w-full py-3 border border-[#d2d2d7] text-[#171717] text-[14px] font-semibold rounded-xl hover:border-[#1a3a5c] hover:text-[#1a3a5c] text-center">
                View Audit Log
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Bridge screen ───────────────────────────────────────────────────────────
  if (order) {
    return (
      <div class="min-h-screen bg-[#f0f4f8] flex flex-col">
        <NavBar right={
          <div class="text-right text-[12px] font-mono text-[#7a9cbd]">
            <div>Loan: <span class="text-white font-semibold">{form.loanNumber}</span></div>
            <div>Order: <span class="text-[#a8c4d8]">{order.order_id}</span></div>
          </div>
        } />
        <div class="flex-1 flex flex-col items-center pt-6 px-6 pb-10">
          <p class="w-full max-w-3xl mb-4 text-[13px] text-[#6b7280]">
            <span class="font-semibold text-[#374151]">{form.firstName} {form.lastName}</span>
            {' '}— complete income verification below.
          </p>
          {error
            ? <div class="w-full max-w-3xl bg-red-50 border border-red-200 text-red-700 text-[13px] rounded-xl px-4 py-3">{error}</div>
            : (
              <div
                ref={containerRef}
                class="w-full max-w-3xl mx-auto rounded-2xl overflow-hidden shadow-sm border border-[#d2d2d7] bg-white [&_iframe]:w-full [&_iframe]:!h-full [&_iframe]:border-none"
                style="min-width:400px; height:600px;"
              />
            )
          }
        </div>
      </div>
    );
  }

  // ── Intake form ─────────────────────────────────────────────────────────────
  return (
    <div class="min-h-screen bg-[#f0f4f8] flex flex-col">
      <NavBar />
      <div class="flex-1 flex items-start justify-center pt-14 px-6 pb-20">
        <div class="bg-white rounded-2xl shadow-sm border border-[#d2d2d7] max-w-md w-full p-8">
          <div class="mb-7">
            <span class="inline-block bg-[#1a3a5c] text-white text-[11px] font-semibold tracking-widest uppercase px-3 py-1 rounded mb-4">
              Income Verification
            </span>
            <h1 class="text-[22px] font-semibold text-[#171717] tracking-tight leading-snug">
              Start borrower verification
            </h1>
            <p class="text-[14px] text-[#8E8E93] mt-1">
              Enter borrower details to initiate income verification through Truv.
            </p>
          </div>

          <form onSubmit={handleSubmit} class="space-y-5">
            <div class="grid grid-cols-2 gap-4">
              <Field label="First Name">
                <input
                  type="text" required
                  value={form.firstName}
                  onInput={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                  placeholder="Jane"
                  class={inputCls}
                />
              </Field>
              <Field label="Last Name">
                <input
                  type="text" required
                  value={form.lastName}
                  onInput={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                  placeholder="Smith"
                  class={inputCls}
                />
              </Field>
            </div>

            <Field label="Loan Number">
              <input
                type="text" required
                value={form.loanNumber}
                onInput={e => setForm(f => ({ ...f, loanNumber: e.target.value }))}
                placeholder="2026-WC-008812"
                class={`${inputCls} font-mono`}
              />
            </Field>

            {error && (
              <div class="bg-red-50 border border-red-200 text-red-700 text-[13px] rounded-lg px-4 py-3">{error}</div>
            )}

            <button
              type="submit"
              disabled={submitting}
              class="w-full py-3 bg-[#1a3a5c] text-white text-[14px] font-semibold rounded-xl hover:bg-[#163354] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-1"
            >
              {submitting
                ? <><span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Creating order…</>
                : 'Start Income Verification'}
            </button>
          </form>

          <p class="mt-6 pt-5 border-t border-[#f5f5f7] text-[11px] text-[#8E8E93]">
            Borrower will complete verification via embedded Bridge widget.
            Results are available immediately upon completion.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Shared sub-components ────────────────────────────────────────────────────

const inputCls = 'w-full px-3 py-2.5 text-[14px] border border-[#d2d2d7] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1a3a5c]/30 focus:border-[#1a3a5c]';

function Field({ label, children }) {
  return (
    <div>
      <label class="block text-[11px] font-semibold text-[#374151] uppercase tracking-wider mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function NavBar({ right }) {
  return (
    <header class="bg-[#1a3a5c] px-6 py-4 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-3">
        <span class="text-white font-semibold text-[15px] tracking-tight">LION POS</span>
        <span class="text-[#7a9cbd] text-[13px]">Loan Income &amp; Employment Network</span>
      </div>
      {right || (
        <a href="#" class="text-[#7a9cbd] text-[12px] hover:text-white">← Back to demos</a>
      )}
    </header>
  );
}
