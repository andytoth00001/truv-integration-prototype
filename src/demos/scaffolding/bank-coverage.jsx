// Presentation scaffolding for the Financial Accounts Coverage Analysis demo.

export const PRODUCT_OPTIONS = [
  { value: 'transactions', label: 'Bank transactions (transactions)' },
  { value: 'assets', label: 'Asset verification (assets)' },
];

export const STEPS = [
  { title: 'Pick product & download sample', guide: '<p>Choose the bank-side Truv product you want to check coverage for. Bank products run against <code>data_source=financial_accounts</code>:</p><ul><li><code>transactions</code> — bank transaction data</li><li><code>assets</code> — asset verification</li></ul><p>Each row is sent to:</p><pre>GET /v1/providers/?query={name}&product_type={product}&data_source=financial_accounts</pre><p>Use the bundled sample CSV to see the format. Columns:</p><ul><li><code>name</code> — required</li><li><code>domain</code> — optional</li></ul>' },
  { title: 'Upload CSV', guide: '<p>Up to 10,000 rows. Parsed in the browser, then forwarded to:</p><pre>POST /api/coverage/bank/jobs</pre><p>The server queues the rows and returns a <code>job_id</code> immediately.</p>' },
  { title: 'Batched lookups with retries', guide: '<p>The server processes 5 rows in parallel. Each call respects rate limits with exponential backoff (1s → 2s → 4s → 8s) on 429 / 5xx responses.</p>' },
  { title: 'Review & export', guide: '<p>Once the job completes, filter rows by search status (found / not found) and download the results CSV:</p><pre>GET /api/coverage/bank/jobs/{id}/csv</pre><p>Each found row includes the matched provider and its <code>success_rate</code> (high / low / unsupported) for the selected product.</p>' },
];

export const INTRO_SLIDE_CONFIG = {
  label: 'Coverage Analysis . Bank',
  title: 'Bulk-check bank coverage',
  subtitle: 'Upload up to 10,000 financial institutions and see which ones Truv can connect to via Bridge. Hits the providers endpoint with data_source=financial_accounts at scale, with built-in rate limiting and retries.',
};
