import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runJob,
  isThrottled,
  parseRetryAfterMs,
  MAX_RETRY_AFTER_MS,
  RETRY_AFTER_BUFFER_MS,
  NO_HINT_BACKOFF_MS,
} from '../../../server/routes/coverage-analysis.js';

function makeJob(rows, kind = 'payroll') {
  return {
    id: 'test-job',
    kind,
    product_type: null,
    session_id: null,
    status: 'running',
    total: rows.length,
    processed: 0,
    results: rows.map((r, i) => ({ index: i, status: 'pending', input_name: r.name, input_state: r.state || '', input_domain: r.domain || '' })),
    created_at: Date.now(),
  };
}

const noopLogger = { logApiCall: vi.fn() };

describe('isThrottled', () => {
  it('returns true for status 429', () => {
    expect(isThrottled({ statusCode: 429, data: {} })).toBe(true);
  });

  it('detects DRF detail string', () => {
    expect(isThrottled({
      statusCode: 429,
      data: { detail: 'Request was throttled. Expected available in 17 seconds.' },
    })).toBe(true);
  });

  it('detects throttle text in data.error.message even with non-429 status', () => {
    expect(isThrottled({
      statusCode: 503,
      data: { error: { code: 'throttled', message: 'Request was throttled. Expected available in 17 seconds.' } },
    })).toBe(true);
  });

  it('returns false for ordinary 5xx errors', () => {
    expect(isThrottled({ statusCode: 500, data: { error: { message: 'internal server error' } } })).toBe(false);
  });

  it('returns false when data is null', () => {
    expect(isThrottled({ statusCode: 400, data: null })).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads numeric Retry-After header in seconds', () => {
    expect(parseRetryAfterMs({ retryAfter: '15', data: null })).toBe(15_000);
  });

  it('reads seconds from data.detail body', () => {
    expect(parseRetryAfterMs({
      data: { detail: 'Request was throttled. Expected available in 17 seconds.' },
    })).toBe(17_000);
  });

  it('reads seconds from data.error.message body', () => {
    expect(parseRetryAfterMs({
      data: { error: { message: 'Request was throttled. Expected available in 33 seconds.' } },
    })).toBe(33_000);
  });

  it('returns null when no hint is present', () => {
    expect(parseRetryAfterMs({ data: { error: { message: 'oops' } } })).toBeNull();
    expect(parseRetryAfterMs({ data: null })).toBeNull();
  });

  it('caps an obscenely large hint at MAX_RETRY_AFTER_MS', () => {
    expect(parseRetryAfterMs({ retryAfter: '999999', data: null })).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe('runJob — throttle handling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a 429 with Retry-After hint and lands on success', async () => {
    const lookupCompany = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 429,
        data: { detail: 'Request was throttled. Expected available in 1 seconds.' },
        durationMs: 1,
        requestBody: null,
        retryAfter: '1',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { name: 'ACME', company_mapping_id: 'abc', confidence_level: 'HIGH', success_rate: 0.9 },
        durationMs: 1,
        requestBody: null,
      });

    const job = makeJob([{ name: 'ACME' }]);
    const promise = runJob({ job, truv: { lookupCompany }, apiLogger: noopLogger });
    // Hint is 1s + RETRY_AFTER_BUFFER_MS=10s; advance well past the gate.
    await vi.advanceTimersByTimeAsync(1_000 + RETRY_AFTER_BUFFER_MS + 1_000);
    await promise;

    expect(lookupCompany).toHaveBeenCalledTimes(2);
    expect(job.status).toBe('completed');
    expect(job.results[0].status).toBe('found');
    expect(job.results[0].match_id).toBe('abc');
  });

  it('treats a 503 whose body says "throttled" as a 429 and retries', async () => {
    const lookupCompany = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 503,
        data: { error: { code: 'throttled', message: 'Request was throttled. Expected available in 1 seconds.' } },
        durationMs: 1,
        requestBody: null,
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { name: 'ACME', id: 'xyz' },
        durationMs: 1,
        requestBody: null,
      });

    const job = makeJob([{ name: 'ACME' }]);
    const promise = runJob({ job, truv: { lookupCompany }, apiLogger: noopLogger });
    await vi.advanceTimersByTimeAsync(1_000 + RETRY_AFTER_BUFFER_MS + 1_000);
    await promise;

    expect(lookupCompany).toHaveBeenCalledTimes(2);
    expect(job.results[0].status).toBe('found');
  });

  it('falls back to escalating backoff when 429 has no hint', async () => {
    const lookupCompany = vi.fn()
      .mockResolvedValueOnce({ statusCode: 429, data: {}, durationMs: 1, requestBody: null })
      .mockResolvedValueOnce({ statusCode: 200, data: { name: 'OK', id: '1' }, durationMs: 1, requestBody: null });

    const job = makeJob([{ name: 'OK' }]);
    const promise = runJob({ job, truv: { lookupCompany }, apiLogger: noopLogger });
    await vi.advanceTimersByTimeAsync(NO_HINT_BACKOFF_MS[0] + 1_000);
    await promise;

    expect(lookupCompany).toHaveBeenCalledTimes(2);
    expect(job.results[0].status).toBe('found');
  });

  it('does not surface a throttle-text message as a row error (outer sweep recovers)', async () => {
    // Simulate a regression where lookup returns a 4xx that matches the throttle regex.
    // The inner detector should catch it via isThrottled, but if it didn't, the outer
    // sweep would see the row.error and re-process. Verify the row never ends up
    // reporting the throttle text.
    const lookupCompany = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 429,
        data: { detail: 'Request was throttled. Expected available in 1 seconds.' },
        durationMs: 1,
        requestBody: null,
        retryAfter: '1',
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        data: { name: 'OK', id: '1' },
        durationMs: 1,
        requestBody: null,
      });

    const job = makeJob([{ name: 'OK' }]);
    const promise = runJob({ job, truv: { lookupCompany }, apiLogger: noopLogger });
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(job.status).toBe('completed');
    expect(job.results[0].status).toBe('found');
    expect(job.results[0].error).toBeUndefined();
  });

  it('marks rows with no input_name as error without calling the API', async () => {
    const lookupCompany = vi.fn();
    const job = makeJob([{ name: '' }, { name: 'OK' }]);
    job.results[1] = { ...job.results[1] };
    lookupCompany.mockResolvedValue({ statusCode: 200, data: { name: 'OK', id: '1' }, durationMs: 1, requestBody: null });

    const promise = runJob({ job, truv: { lookupCompany }, apiLogger: noopLogger });
    await vi.runAllTimersAsync();
    await promise;

    expect(lookupCompany).toHaveBeenCalledTimes(1);
    expect(job.results[0].status).toBe('error');
    expect(job.results[0].error).toBe('missing name');
    expect(job.results[1].status).toBe('found');
  });

  it('throws non-throttle 4xx errors out to the row (e.g. 400 bad request)', async () => {
    const lookupCompany = vi.fn().mockResolvedValue({
      statusCode: 400,
      data: { error: { message: 'Invalid product_type' } },
      durationMs: 1,
      requestBody: null,
    });

    const job = makeJob([{ name: 'X' }]);
    const promise = runJob({ job, truv: { lookupCompany }, apiLogger: noopLogger });
    await vi.runAllTimersAsync();
    await promise;

    expect(job.results[0].status).toBe('error');
    expect(job.results[0].error).toBe('Invalid product_type');
  });
});

describe('runJob — result shape', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('payroll surfaces mapping_status from /v1/companies/ and not confidence_level', async () => {
    const lookupCompany = vi.fn().mockResolvedValue({
      statusCode: 200,
      data: { name: 'ACME', company_mapping_id: 'abc', success_rate: 'high', mapping_status: 'verified', confidence_level: '0.9' },
      durationMs: 1,
      requestBody: null,
    });

    const job = makeJob([{ name: 'ACME' }], 'payroll');
    const promise = runJob({ job, truv: { lookupCompany }, apiLogger: noopLogger });
    await vi.runAllTimersAsync();
    await promise;

    expect(job.results[0].status).toBe('found');
    expect(job.results[0].mapping_status).toBe('verified');
    expect(job.results[0]).not.toHaveProperty('confidence_level');
  });

  it('bank uses status="found" and drops confidence_level + mapping_status from row output', async () => {
    const searchProviders = vi.fn().mockResolvedValue({
      statusCode: 200,
      data: { results: [{ id: 'chase', name: 'Chase', success_rate: 'high', confidence_level: '0.95' }] },
      durationMs: 1,
      requestBody: null,
    });

    const job = makeJob([{ name: 'Chase' }], 'bank');
    const promise = runJob({ job, truv: { searchProviders }, apiLogger: noopLogger });
    await vi.runAllTimersAsync();
    await promise;

    expect(job.results[0].status).toBe('found');
    expect(job.results[0]).not.toHaveProperty('confidence_level');
    expect(job.results[0]).not.toHaveProperty('mapping_status');
  });
});
