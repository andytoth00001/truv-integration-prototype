/**
 * FILE SUMMARY: Coverage Analysis bulk-lookup routes.
 * DATA FLOW: Frontend uploads CSV --> POST /api/coverage/:kind/jobs creates a job
 *            --> background runner batches Truv company-mappings-search / providers
 *                calls with concurrency + retries
 *            --> Frontend polls GET .../jobs/:id and downloads .../jobs/:id/csv.
 * INTEGRATION PATTERN: Standalone bulk processor; reuses TruvClient.searchCompanies
 *                      and searchProviders. Job state is in-memory (per server process).
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { serializeCsv } from '../lib/csv.js';

// Runner config: 5 concurrent workers, with exponential backoff for 5xx errors.
// 429s are never fatal — workers loop on a row until it returns a non-429 status.
// The shared cooldown gate makes the whole pool wait through a throttle window together.
const CONCURRENCY = 5;
const MAX_ATTEMPTS = 4;                                   // attempt budget for 5xx errors
const BACKOFF_MS = [1000, 2000, 4000, 8000];              // 5xx backoff
const NO_HINT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000]; // 429 with no Retry-After hint
const RETRY_AFTER_BUFFER_MS = 10_000;                     // pad the API's hint to clear the window
const MAX_RETRY_AFTER_MS = 5 * 60_000;                    // sanity cap on a single hint (post-buffer)
const MAX_ROWS = 10_000;
const JOB_TTL_MS = 30 * 60_000;                           // evict completed/failed jobs after 30 min
const JOB_SWEEP_INTERVAL_MS = 5 * 60_000;
const OUTER_SWEEP_MAX_PASSES = 50;

// Used by both the inner detector and the outer post-pass sweep.
const THROTTLE_TEXT = /throttled|rate[-_ ]?limit|too many requests/i;

// Per docs: product_type ∈ income | employment | deposit_switch | pll | insurance | transactions | assets | admin.
// Bank coverage is keyed off data_source=financial_accounts, so the relevant products are transactions + assets.
const PAYROLL_PRODUCTS = new Set(['income', 'employment', 'deposit_switch', 'pll', 'insurance', 'admin']);
const BANK_PRODUCTS = new Set(['transactions', 'assets']);

// Output column order for the result table + CSV export.
const PAYROLL_COLUMNS = ['input_name', 'input_state', 'input_domain', 'status', 'match_name', 'match_id', 'match_domain', 'match_logo_url', 'success_rate', 'confidence_level', 'error'];
const BANK_COLUMNS    = ['input_name', 'input_domain', 'status', 'match_name', 'match_id', 'match_domain', 'match_logo_url', 'success_rate', 'confidence_level', 'error'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default function coverageAnalysisRoutes({ truv, apiLogger }) {
  const router = Router();
  const jobs = new Map();

  // Evict finished jobs so the in-memory store doesn't grow without bound across uploads.
  // Runs in the background; running jobs are never evicted.
  const sweepInterval = setInterval(() => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) {
      if (job.status === 'completed' || job.status === 'failed') {
        const finishedAt = job.completed_at || job.created_at;
        if (finishedAt < cutoff) jobs.delete(id);
      }
    }
  }, JOB_SWEEP_INTERVAL_MS);
  sweepInterval.unref?.();

  // POST /api/coverage/:kind/jobs — accept rows + product type, kick off async processing.
  router.post('/api/coverage/:kind/jobs', (req, res) => {
    const { kind } = req.params;
    if (kind !== 'payroll' && kind !== 'bank') return res.status(404).json({ error: 'Unknown kind' });

    const { rows, product_type, session_id } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows array required' });
    if (rows.length > MAX_ROWS) return res.status(413).json({ error: `Max ${MAX_ROWS} rows` });

    const validProducts = kind === 'payroll' ? PAYROLL_PRODUCTS : BANK_PRODUCTS;
    if (product_type && !validProducts.has(product_type)) return res.status(400).json({ error: `Invalid product_type for ${kind}` });

    const jobId = uuidv4();
    const job = {
      id: jobId,
      kind,
      product_type: product_type || null,
      session_id: session_id || null,
      status: 'running',
      total: rows.length,
      processed: 0,
      results: rows.map((r, i) => ({ index: i, status: 'pending', input_name: r.name || '', input_state: r.state || '', input_domain: r.domain || '' })),
      created_at: Date.now(),
    };
    jobs.set(jobId, job);

    runJob({ job, truv, apiLogger }).catch(err => {
      console.error('Coverage job failed:', err);
      job.status = 'failed';
      job.error = err.message;
    });

    res.json({ job_id: jobId, total: job.total });
  });

  // GET /api/coverage/:kind/jobs/:id — poll status + partial results.
  router.get('/api/coverage/:kind/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.kind !== req.params.kind) return res.status(404).json({ error: 'Not found' });
    res.json({
      job_id: job.id,
      status: job.status,
      total: job.total,
      processed: job.processed,
      product_type: job.product_type,
      rows: job.results,
      error: job.error || null,
    });
  });

  // GET /api/coverage/:kind/jobs/:id/csv — download CSV of completed results.
  // Output: per-row data with its header, a blank row, then a "Coverage summary" block
  // (totals + success-rate breakdown). Two stacked tables in one sheet — readable in
  // Excel/Sheets without breaking on '#' comment lines.
  router.get('/api/coverage/:kind/jobs/:id/csv', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.kind !== req.params.kind) return res.status(404).json({ error: 'Not found' });
    if (job.status !== 'completed') return res.status(409).json({ error: 'Job not completed' });
    const cols = job.kind === 'payroll' ? PAYROLL_COLUMNS : BANK_COLUMNS;
    const summary = buildSummary(job.results, job.kind);
    const csv = serializeCsv(job.results, cols) + '\n' + serializeSummary(summary);
    const filename = `${job.kind}_coverage_${job.id.slice(0, 8)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  });

  return router;
}

// Runs a job to completion: spawns CONCURRENCY workers that pull from a shared cursor.
// Workers loop on each row until it returns a non-429 status, so throttling never
// surfaces as a row error. A 429 opens a shared cooldown gate that every worker — and
// the cursor itself — awaits, pausing the whole pool through the API's throttle window.
async function runJob({ job, truv, apiLogger }) {
  let cursor = 0;
  const throttle = { gate: null };

  async function processRow(row) {
    if (!row.input_name) {
      row.status = 'error';
      row.error = 'missing name';
      return;
    }
    try {
      const lookup = await lookupWithRetry({ job, row, truv, apiLogger, throttle });
      applyResult(job, row, lookup);
    } catch (err) {
      row.status = 'error';
      row.error = err.message || String(err);
    }
  }

  async function worker() {
    while (cursor < job.results.length) {
      // Don't pick up a new row while a cooldown is open.
      if (throttle.gate) await throttle.gate;
      const i = cursor++;
      await processRow(job.results[i]);
      job.processed++;
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, job.results.length) }, () => worker());
  await Promise.all(workers);

  // Outer safety net: throttling must never be a final outcome. If any row ended up
  // with a throttle-like error message (whether from a stale code path, a proxy quirk,
  // or a future regression), re-run those rows sequentially after the cooldown clears.
  // Loops until either no throttled rows remain or the safety counter trips.
  let pass = 0;
  for (; pass < OUTER_SWEEP_MAX_PASSES; pass++) {
    const stuck = job.results.filter(r => r.status === 'error' && THROTTLE_TEXT.test(r.error || ''));
    if (stuck.length === 0) break;
    if (throttle.gate) await throttle.gate;
    for (const row of stuck) {
      job.processed--;
      row.error = null;
      row.status = 'pending';
      await processRow(row);
      job.processed++;
    }
  }
  if (pass === OUTER_SWEEP_MAX_PASSES) {
    const remaining = job.results.filter(r => r.status === 'error' && THROTTLE_TEXT.test(r.error || '')).length;
    if (remaining > 0) console.warn(`Coverage job ${job.id}: ${remaining} rows still throttle-errored after ${OUTER_SWEEP_MAX_PASSES} sweep passes; giving up`);
  }

  job.status = 'completed';
  job.completed_at = Date.now();
}

// Calls the right Truv search method. Returns when the row gets a non-429 response;
// 429s loop forever (with the API's own Retry-After hint, or escalating backoff if absent),
// so throttling is never surfaced as a row error.
async function lookupWithRetry({ job, row, truv, apiLogger, throttle }) {
  let serverErrorAttempt = 0;
  let noHintAttempt = 0;

  while (true) {
    if (throttle.gate) await throttle.gate;

    const result = job.kind === 'payroll'
      ? await truv.lookupCompany({
          name: row.input_name,
          domain: row.input_domain || undefined,
          state: row.input_state || undefined,
          product_type: job.product_type || undefined,
        })
      : await truv.searchProviders(row.input_name, job.product_type || undefined, 'financial_accounts');

    const endpoint = job.kind === 'payroll'
      ? '/v1/companies/'
      : `/v1/providers/?query=${encodeURIComponent(row.input_name)}&data_source=financial_accounts${job.product_type ? `&product_type=${job.product_type}` : ''}`;

    apiLogger.logApiCall({
      sessionId: job.session_id,
      method: job.kind === 'payroll' ? 'POST' : 'GET',
      endpoint,
      requestBody: job.kind === 'payroll' ? result.requestBody : undefined,
      responseBody: result.data,
      statusCode: result.statusCode,
      durationMs: result.durationMs,
    });

    if (result.statusCode < 400) return result;

    // Treat any response that mentions throttling/rate-limiting as a 429, even if a
    // proxy or CDN rewrote the status code or the message lives in a non-standard field.
    if (isThrottled(result)) {
      const hintMs = parseRetryAfterMs(result);
      if (hintMs != null) {
        // Pad the server hint so we don't slam the API the instant the window opens.
        const waitMs = Math.min(hintMs + RETRY_AFTER_BUFFER_MS, MAX_RETRY_AFTER_MS);
        if (!throttle.gate) {
          throttle.gate = sleep(waitMs).then(() => { throttle.gate = null; });
        }
        await throttle.gate;
        noHintAttempt = 0;
      } else {
        const idx = Math.min(noHintAttempt, NO_HINT_BACKOFF_MS.length - 1);
        await sleep(NO_HINT_BACKOFF_MS[idx]);
        noHintAttempt++;
      }
      continue;
    }

    if (result.statusCode >= 500 && serverErrorAttempt < MAX_ATTEMPTS - 1) {
      await sleep(BACKOFF_MS[serverErrorAttempt]);
      serverErrorAttempt++;
      continue;
    }

    // 4xx (other than 429), or 5xx with retries exhausted — not retryable.
    const msg = result.data?.error?.message || result.data?.detail || `HTTP ${result.statusCode}`;
    throw new Error(msg);
  }
}

// True if the response is rate-limit-like: a 429 status, or a body whose detail/error/
// message field mentions throttling. Belt-and-suspenders against proxies that rewrite
// the status and against API quirks that put the throttle message in non-standard fields.
function isThrottled(result) {
  if (result.statusCode === 429) return true;
  const data = result.data;
  if (!data || typeof data !== 'object') return false;
  const candidates = [data.detail, data.message, data.error?.message, data.error?.detail];
  return candidates.some(s => typeof s === 'string' && THROTTLE_TEXT.test(s));
}

// Reads the API's retry hint from either the Retry-After header or any body field
// matching DRF's "Request was throttled. Expected available in N seconds." string.
// Returns milliseconds, capped, or null if no hint is present.
function parseRetryAfterMs(result) {
  const header = result.retryAfter;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }
  const candidates = [result.data?.detail, result.data?.message, result.data?.error?.message, result.data?.error?.detail];
  for (const text of candidates) {
    if (typeof text !== 'string') continue;
    const match = text.match(/(\d+)\s*seconds?/i);
    if (match) return Math.min(Number(match[1]) * 1000, MAX_RETRY_AFTER_MS);
  }
  return null;
}

// Exported for tests. Production code uses these via the route handler closure.
export { runJob, lookupWithRetry, isThrottled, parseRetryAfterMs, MAX_RETRY_AFTER_MS, NO_HINT_BACKOFF_MS, RETRY_AFTER_BUFFER_MS, buildSummary, serializeSummary };

// Aggregate a finished job's results into the same buckets the UI summary panel renders.
// Coverage buckets denominate over total uploaded rows; success-rate buckets denominate
// over covered rows only (the API only returns success_rate on covers).
function buildSummary(results, kind) {
  const total = results.length;
  const counts = { covered: 0, not_found: 0, error: 0 };
  const sr = { high: 0, low: 0, unsupported: 0, missing: 0 };
  for (const r of results) {
    if (r.status in counts) counts[r.status]++;
    if (r.status === 'covered') {
      const v = String(r.success_rate || '').toLowerCase();
      if (v === 'high' || v === 'low' || v === 'unsupported') sr[v]++;
      else sr.missing++;
    }
  }
  const entityLabel = kind === 'payroll' ? 'employers' : 'institutions';
  return { total, covered: counts.covered, notFound: counts.not_found, errors: counts.error, sr, entityLabel };
}

// Render the summary as CSV rows (3-column Metric/Count/Percent table).
// The returned string ends with a trailing newline. The caller is expected to
// prepend the data CSV and a blank separator row: dataCsv + '\n' + serializeSummary(s).
function serializeSummary(s) {
  const pctOfTotal = n => s.total > 0 ? `${Math.round((n / s.total) * 100)}%` : '0%';
  const pctOfCovered = n => s.covered > 0 ? `${Math.round((n / s.covered) * 100)}%` : '0%';
  const lines = [
    'Coverage summary,,',
    'Metric,Count,Percent',
    `Total uploaded,${s.total},`,
    `Covered,${s.covered},${pctOfTotal(s.covered)}`,
    `Not found,${s.notFound},${pctOfTotal(s.notFound)}`,
    `Errors,${s.errors},${pctOfTotal(s.errors)}`,
    ',,',
    `Success rate (% of covered ${s.entityLabel}),Count,Percent`,
    `High,${s.sr.high},${pctOfCovered(s.sr.high)}`,
    `Low,${s.sr.low},${pctOfCovered(s.sr.low)}`,
    `Unsupported,${s.sr.unsupported},${pctOfCovered(s.sr.unsupported)}`,
    `Missing,${s.sr.missing},${pctOfCovered(s.sr.missing)}`,
  ];
  return lines.join('\n') + '\n';
}

// Map a Truv response onto the row's status/match_* fields.
// Uses the API's own confidence_level + success_rate verbatim, no derivation.
function applyResult(job, row, result) {
  // Both endpoints return either a top-level array or a wrapped { results: [...] }.
  // POST /v1/companies/ may also return a single object.
  const data = result.data;
  let matches = [];
  if (Array.isArray(data)) matches = data;
  else if (Array.isArray(data?.results)) matches = data.results;
  else if (data && typeof data === 'object' && (data.company_mapping_id || data.id || data.name)) matches = [data];

  if (!matches.length) {
    row.status = 'not_found';
    row.match_name = '';
    row.match_id = '';
    row.match_domain = '';
    row.match_logo_url = '';
    row.success_rate = '';
    row.confidence_level = '';
    return;
  }

  const top = matches[0];
  row.status = 'covered';
  row.match_name = top.name || '';
  row.match_id = top.company_mapping_id || top.id || '';
  row.match_domain = top.domain || '';
  row.match_logo_url = top.logo_url || '';
  row.success_rate = top.success_rate ?? '';
  row.confidence_level = top.confidence_level ?? '';
}
