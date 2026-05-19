/**
 * FILE SUMMARY: CoverageRunner — shared bulk-CSV runner for Payroll & Financial Accounts Coverage demos.
 * DATA FLOW: Browser file picker --> POST /api/coverage/:kind/jobs --> poll GET .../jobs/:id
 *            --> render live progress + results table --> GET .../jobs/:id/csv on export.
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import { API_BASE } from './hooks.js';

const POLL_INTERVAL_MS = 1500;

// Props:
//   kind            : 'payroll' | 'bank'
//   productOptions  : [{ value, label }]
//   sampleUrl       : URL to the bundled sample CSV
//   sampleFilename  : filename used when downloading the sample
//   onStepChange    : optional callback to drive Panel.currentStep (0..3)
//   sessionId       : tied to usePanel's sessionId so API logs flow into the sidebar
export function CoverageRunner({ kind, productOptions, sampleUrl, sampleFilename, onStepChange, sessionId }) {
  const [productType, setProductType] = useState(productOptions[0]?.value || 'income');
  const [job, setJob] = useState(null);            // { job_id, total }
  const [status, setStatus] = useState('idle');    // idle | uploading | running | completed | failed
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');     // all | covered | not_found | error
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function step(n) { onStepChange && onStepChange(n); }

  // CSV parsing in-browser, mirrors server/lib/csv.js logic. Returns array of {name,state?,domain?}.
  function parseCsvText(text) {
    const out = [];
    const rows = [];
    let row = []; let cell = ''; let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) return [];
    const first = rows[0].map(c => String(c).trim().toLowerCase());
    const hasHeader = first.includes('name');
    const idxName = hasHeader ? first.indexOf('name') : 0;
    const idxState = hasHeader ? first.indexOf('state') : 1;
    const idxDomain = hasHeader ? first.indexOf('domain') : (kind === 'bank' ? 1 : 2);
    const data = hasHeader ? rows.slice(1) : rows;
    for (const r of data) {
      const name = (r[idxName] || '').toString().trim();
      if (!name) continue;
      out.push({
        name,
        state: idxState >= 0 ? (r[idxState] || '').toString().trim() : '',
        domain: idxDomain >= 0 ? (r[idxDomain] || '').toString().trim() : '',
      });
    }
    return out;
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setStatus('uploading');
    step(1);
    try {
      const text = await file.text();
      const parsed = parseCsvText(text);
      if (!parsed.length) { setError('CSV is empty or could not be parsed.'); setStatus('idle'); return; }
      if (parsed.length > 10_000) { setError('CSV exceeds 10,000 row limit.'); setStatus('idle'); return; }

      const resp = await fetch(`${API_BASE}/api/coverage/${kind}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: parsed, product_type: productType, session_id: sessionId }),
      });
      const body = await resp.json();
      if (!resp.ok) { setError(body.error || 'Upload failed'); setStatus('idle'); return; }

      setJob({ job_id: body.job_id, total: body.total });
      setRows(parsed.map((r, i) => ({ index: i, status: 'pending', input_name: r.name, input_state: r.state, input_domain: r.domain })));
      setProgress({ processed: 0, total: body.total });
      setStatus('running');
      step(2);
      startPolling(body.job_id);
    } catch (err) {
      setError(err.message || 'Failed to read file');
      setStatus('idle');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function startPolling(jobId) {
    if (pollRef.current) clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/coverage/${kind}/jobs/${jobId}`);
        const body = await resp.json();
        if (!resp.ok) { setError(body.error || 'Polling failed'); clearInterval(pollRef.current); return; }
        setProgress({ processed: body.processed, total: body.total });
        setRows(body.rows);
        if (body.status === 'completed') {
          setStatus('completed');
          step(3);
          clearInterval(pollRef.current); pollRef.current = null;
        } else if (body.status === 'failed') {
          setStatus('failed');
          setError(body.error || 'Job failed');
          clearInterval(pollRef.current); pollRef.current = null;
        }
      } catch (err) {
        // network blip; keep polling
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }

  function downloadCsv() {
    if (!job) return;
    window.location.href = `${API_BASE}/api/coverage/${kind}/jobs/${job.job_id}/csv`;
  }

  function reset() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setJob(null); setStatus('idle'); setRows([]); setProgress({ processed: 0, total: 0 }); setError(null); setFilter('all');
    step(0);
  }

  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const visible = filter === 'all' ? rows : rows.filter(r => r.status === filter);
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  // Denominator for the top "Coverage" row is total uploaded rows; denominator for the
  // success-rate breakdown is covered rows only (success_rate is only set on covers).
  const summary = rows.reduce((acc, r) => {
    if (r.status === 'covered') {
      const sr = String(r.success_rate || '').toLowerCase();
      if (sr === 'high' || sr === 'low' || sr === 'unsupported') acc[sr]++;
      else acc.missing++;
    }
    return acc;
  }, { high: 0, low: 0, unsupported: 0, missing: 0 });

  return (
    <div class="px-8 py-10 max-w-[1100px] w-full mx-auto">
      <div class="mb-8">
        <h2 class="text-2xl font-bold text-[#171717]">{kind === 'payroll' ? 'Payroll Coverage Analysis' : 'Financial Accounts Coverage Analysis'}</h2>
        <p class="text-sm text-[#6b7280] mt-1">Upload up to 10,000 {kind === 'payroll' ? 'employers' : 'financial institutions'} and we will look up each one against the Truv {kind === 'payroll' ? 'company-mappings-search' : 'providers'} endpoint.</p>
      </div>

      <div class="flex flex-wrap items-end gap-4 mb-6 pb-6 border-b border-[#e5e7eb]">
        <div>
          <label class="block text-xs font-semibold uppercase tracking-wide text-[#6b7280] mb-1">Product</label>
          <select
            class="border border-[#d1d5db] rounded-md px-3 py-2 text-sm bg-white"
            value={productType}
            onChange={e => setProductType(e.target.value)}
            disabled={status === 'running' || status === 'uploading'}
          >
            {productOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>

        <a
          href={sampleUrl}
          download={sampleFilename}
          class="px-4 py-2 text-sm font-medium text-primary bg-white border border-primary rounded-md hover:bg-[#f5f5f7]"
        >
          Download sample CSV
        </a>

        <label class={`px-4 py-2 text-sm font-medium text-white bg-primary rounded-md cursor-pointer hover:opacity-90 ${status === 'running' || status === 'uploading' ? 'opacity-50 pointer-events-none' : ''}`}>
          Upload CSV
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" class="hidden" onChange={handleFile} />
        </label>

        {status === 'completed' && (
          <button onClick={downloadCsv} class="px-4 py-2 text-sm font-medium text-white bg-[#16a34a] rounded-md hover:opacity-90">
            Export results CSV
          </button>
        )}

        {(status === 'completed' || status === 'failed') && (
          <button onClick={reset} class="px-4 py-2 text-sm font-medium text-[#374151] bg-white border border-[#d1d5db] rounded-md hover:bg-[#f5f5f7]">
            Run another
          </button>
        )}
      </div>

      {error && (
        <div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md">{error}</div>
      )}

      {status === 'idle' && !rows.length && (
        <div class="px-6 py-12 text-center border-2 border-dashed border-[#d1d5db] rounded-lg text-[#6b7280]">
          <p class="text-sm mb-2">Pick a product, then upload a CSV with a <code>name</code> column.</p>
          <p class="text-xs">{kind === 'payroll' ? 'Optional columns: state, domain.' : 'Optional column: domain.'}</p>
        </div>
      )}

      {(status === 'running' || status === 'completed' || status === 'failed') && (
        <>
          <div class="mb-4">
            <div class="flex items-center justify-between mb-1.5">
              <div class="text-sm font-medium text-[#374151]">
                {status === 'running' ? 'Processing…' : status === 'completed' ? 'Completed' : 'Failed'}
                <span class="text-[#6b7280] font-normal ml-2">{progress.processed} / {progress.total}</span>
              </div>
              <div class="text-sm font-semibold text-primary">{pct}%</div>
            </div>
            <div class="h-2 bg-[#e5e7eb] rounded-full overflow-hidden">
              <div class="h-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>

          {status === 'completed' && (
            <SummaryPanel
              total={rows.length}
              covered={counts.covered || 0}
              notFound={counts.not_found || 0}
              errors={counts.error || 0}
              breakdown={summary}
              entityLabel={kind === 'payroll' ? 'employers' : 'institutions'}
            />
          )}

          <div class="flex gap-2 mb-4 text-xs">
            <FilterPill active={filter === 'all'} onClick={() => setFilter('all')} label={`All (${rows.length})`} />
            <FilterPill active={filter === 'covered'} onClick={() => setFilter('covered')} label={`Covered (${counts.covered || 0})`} color="green" />
            <FilterPill active={filter === 'not_found'} onClick={() => setFilter('not_found')} label={`Not found (${counts.not_found || 0})`} color="gray" />
            <FilterPill active={filter === 'error'} onClick={() => setFilter('error')} label={`Errors (${counts.error || 0})`} color="red" />
          </div>

          <div class="border border-[#e5e7eb] rounded-md overflow-hidden">
            <div class="max-h-[60vh] overflow-y-auto">
              <table class="w-full text-sm">
                <thead class="bg-[#f9fafb] sticky top-0">
                  <tr class="text-left text-[11px] font-semibold uppercase tracking-wide text-[#6b7280]">
                    <th class="px-3 py-2">Input</th>
                    <th class="px-3 py-2">Status</th>
                    <th class="px-3 py-2">Matched company</th>
                    <th class="px-3 py-2">Mapping ID</th>
                    <th class="px-3 py-2 text-right">Success rate</th>
                    <th class="px-3 py-2 text-right">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(row => (
                    <tr key={row.index} class="border-t border-[#e5e7eb] align-top">
                      <td class="px-3 py-2 text-[#171717]">
                        <div class="font-medium">{row.input_name}</div>
                        <div class="text-xs text-[#6b7280]">
                          {kind === 'payroll' && row.input_state ? row.input_state : ''}
                          {kind === 'payroll' && row.input_state && row.input_domain ? ' · ' : ''}
                          {row.input_domain}
                        </div>
                      </td>
                      <td class="px-3 py-2"><StatusBadge status={row.status} /></td>
                      <td class="px-3 py-2 text-[#374151]">
                        {row.match_name ? (
                          <div class="flex items-center gap-2.5">
                            {row.match_logo_url ? (
                              <img src={row.match_logo_url} alt="" class="w-8 h-8 rounded-md bg-white border border-[#e5e7eb] object-contain" onError={e => { e.currentTarget.style.display = 'none'; }} />
                            ) : (
                              <div class="w-8 h-8 rounded-md bg-[#f5f5f7] border border-[#e5e7eb]" />
                            )}
                            <div>
                              <div class="font-medium text-[#171717]">{row.match_name}</div>
                              {row.match_domain && <div class="text-xs text-[#6b7280]">{row.match_domain}</div>}
                            </div>
                          </div>
                        ) : row.error ? (
                          <span class="text-xs text-red-600">{row.error}</span>
                        ) : <span class="text-[#9ca3af]">—</span>}
                      </td>
                      <td class="px-3 py-2 text-xs font-mono text-[#6b7280] break-all">{row.match_id || '—'}</td>
                      <td class="px-3 py-2 text-right"><SuccessRateBadge value={row.success_rate} /></td>
                      <td class="px-3 py-2 text-right text-[#374151] tabular-nums">{formatConfidence(row.confidence_level)}</td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan={6} class="px-3 py-8 text-center text-[#9ca3af] text-sm">No rows for this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryPanel({ total, covered, notFound, errors, breakdown, entityLabel }) {
  const pctOfTotal = n => total > 0 ? Math.round((n / total) * 100) : 0;
  const pctOfCovered = n => covered > 0 ? Math.round((n / covered) * 100) : 0;

  return (
    <div class="mb-6 border border-[#e5e7eb] rounded-md bg-[#f9fafb] p-4">
      <div class="text-xs font-semibold uppercase tracking-wide text-[#6b7280] mb-2">Coverage</div>
      <div class="grid grid-cols-3 gap-3 mb-4">
        <SummaryStat label="Covered" value={covered} pct={pctOfTotal(covered)} color="green" />
        <SummaryStat label="Not found" value={notFound} pct={pctOfTotal(notFound)} color="gray" />
        <SummaryStat label="Errors" value={errors} pct={pctOfTotal(errors)} color="red" />
      </div>

      <div class="text-xs font-semibold uppercase tracking-wide text-[#6b7280] mb-1">Success rate</div>
      <div class="text-xs text-[#6b7280] mb-2">Percentages below are of <strong>covered {entityLabel}</strong> ({covered}), not of total uploaded.</div>
      <div class="grid grid-cols-4 gap-3">
        <SummaryStat label="High" value={breakdown.high} pct={pctOfCovered(breakdown.high)} color="green" />
        <SummaryStat label="Low" value={breakdown.low} pct={pctOfCovered(breakdown.low)} color="orange" />
        <SummaryStat label="Unsupported" value={breakdown.unsupported} pct={pctOfCovered(breakdown.unsupported)} color="red" />
        <SummaryStat label="Missing" value={breakdown.missing} pct={pctOfCovered(breakdown.missing)} color="gray" />
      </div>
    </div>
  );
}

function SummaryStat({ label, value, pct, color }) {
  const colorMap = {
    green: 'text-green-700',
    gray: 'text-gray-700',
    red: 'text-red-700',
    orange: 'text-orange-700',
  };
  return (
    <div class="bg-white border border-[#e5e7eb] rounded-md px-3 py-2">
      <div class="text-[11px] font-medium uppercase tracking-wide text-[#6b7280]">{label}</div>
      <div class={`text-lg font-semibold tabular-nums ${colorMap[color] || 'text-[#171717]'}`}>{value}</div>
      <div class="text-xs text-[#6b7280] tabular-nums">{pct}%</div>
    </div>
  );
}

function FilterPill({ active, onClick, label, color }) {
  const colorMap = {
    green: active ? 'bg-green-100 text-green-800' : 'text-green-700 hover:bg-green-50',
    gray: active ? 'bg-gray-200 text-gray-800' : 'text-gray-700 hover:bg-gray-100',
    red: active ? 'bg-red-100 text-red-800' : 'text-red-700 hover:bg-red-50',
  };
  const cls = color ? colorMap[color] : (active ? 'bg-[#f5f5f7] text-primary font-semibold' : 'text-[#6b7280] hover:bg-[#f5f5f7]');
  return <button onClick={onClick} class={`px-2.5 py-1 rounded-full transition-colors ${cls}`}>{label}</button>;
}

// confidence_level is returned as a fractional string like "0.9". Render as percent.
function formatConfidence(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const pct = n <= 1 ? n * 100 : n;
  return `${pct.toFixed(0)}%`;
}

// success_rate is an enum string from Truv: "high" | "medium" | "low" | "unsupported" | null.
function SuccessRateBadge({ value }) {
  if (!value) return <span class="text-[#9ca3af]">—</span>;
  const v = String(value).toLowerCase();
  const colors = {
    high: 'bg-green-100 text-green-800',
    medium: 'bg-yellow-100 text-yellow-800',
    low: 'bg-orange-100 text-orange-800',
    unsupported: 'bg-red-100 text-red-800',
  };
  const cls = colors[v] || 'bg-gray-100 text-gray-800';
  return <span class={`px-2 py-0.5 text-xs font-medium rounded-full uppercase tracking-wide ${cls}`}>{v}</span>;
}

function StatusBadge({ status }) {
  if (status === 'covered') return <span class="px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-800">Covered</span>;
  if (status === 'not_found') return <span class="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700">Not found</span>;
  if (status === 'error') return <span class="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-800">Error</span>;
  return <span class="px-2 py-0.5 text-xs font-medium rounded-full bg-yellow-100 text-yellow-800">Pending</span>;
}
