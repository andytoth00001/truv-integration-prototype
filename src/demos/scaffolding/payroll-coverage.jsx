// Presentation scaffolding for the Payroll Coverage Analysis demo.

export const PRODUCT_OPTIONS = [
  { value: 'income', label: 'Income & employment (income)' },
  { value: 'employment', label: 'Employment only (employment)' },
  { value: 'deposit_switch', label: 'Direct deposit switch (deposit_switch)' },
  { value: 'pll', label: 'Paycheck-linked loans (pll)' },
];

export const STEPS = [
  { title: 'Pick product & download sample', guide: '<p>Choose the Truv product you want to check coverage for. Each row in your CSV is sent to:</p><pre>POST /v1/companies/\n{ "name": "...", "domain": "...", "state": "...", "product_type": "..." }</pre><p>Use the bundled sample CSV to see the expected format. Columns:</p><ul><li><code>name</code> — required</li><li><code>state</code> — optional, used in the report only</li><li><code>domain</code> — optional, used to score match confidence</li></ul>' },
  { title: 'Upload CSV', guide: '<p>Up to 10,000 rows. The file is parsed in the browser, then forwarded to:</p><pre>POST /api/coverage/payroll/jobs</pre><p>The server queues the rows and returns a <code>job_id</code> immediately.</p>' },
  { title: 'Batched lookups with retries', guide: '<p>The server processes 5 rows in parallel. On 429 responses every worker honors the API\'s <code>Retry-After</code> hint via a shared cooldown gate (plus a 10s buffer), so the whole pool waits through the throttle window together. 5xx responses fall back to exponential backoff (1s → 2s → 4s → 8s).</p>' },
  { title: 'Review & export', guide: '<p>Once the job completes, filter rows by search status and download the results CSV:</p><pre>GET /api/coverage/payroll/jobs/{id}/csv</pre><p>Each found row carries match metadata, a success rate (high / low / unsupported), and the API\'s <code>mapping_status</code> (verified / mapped / unmapped) so you can tell how confident Truv is in the company mapping.</p>' },
];

export const INTRO_SLIDE_CONFIG = {
  label: 'Coverage Analysis . Payroll',
  title: 'Bulk-check employer coverage',
  subtitle: 'Upload up to 10,000 employers and see which ones Truv can verify income, employment, deposit-switch, or paycheck-linked-loans for. Hit /v1/companies/ at scale with built-in rate limiting and retries.',
};
