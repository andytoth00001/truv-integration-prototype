/**
 * FILE SUMMARY: BSS Outbound/Inbound Signing
 * DATA FLOW: bss-admin.js --> generateBssSign() --> X-BSS-Webhook-Sign header
 *            funded.js    --> verifyBssSign()    --> accept or reject
 * INTEGRATION PATTERN: Mirrors webhooks.js; differs only in function names and
 *   signature format — plain lowercase hex with no "v1=" prefix.
 */

import crypto from 'crypto';

// Generates a BSS webhook signature by HMAC-SHA256 hashing the raw body with
// the signing secret. Returns plain hex — no prefix.
export function generateBssSign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// Verifies an inbound BSS signature. Compares the header value against the
// expected hex using timing-safe comparison. Returns true if valid, false otherwise.
export function verifyBssSign(rawBody, secret, headerSig) {
  const expected = generateBssSign(rawBody, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerSig || ''));
  } catch {
    return false;
  }
}
