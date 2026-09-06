'use strict';

/**
 * HTTP client for the local SQS-emulation queue service.
 *
 * The queue API intentionally mirrors the subset of AWS SQS semantics we use:
 *   - send(MessageBody, MessageAttributes)
 *   - receive(maxNumberOfMessages, visibilityTimeoutSeconds) -> messages with receipt handles
 *   - delete(receiptHandles) after successful processing
 *   - stats() -> queue depth (the metric that drives auto-scaling in the plan)
 *
 * Point QUEUE_URL at a real AWS SQS queue URL to swap in AWS (same contract).
 */

const { createLogger } = require('./logger');
const log = createLogger('queue-client');

const DEFAULT_QUEUE_URL = process.env.QUEUE_URL || 'http://127.0.0.1:3100';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;

async function request(method, path, body) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(DEFAULT_QUEUE_URL + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_) {
        json = { raw: text };
      }
      if (!res.ok) {
        throw new Error(method + ' ' + path + ' -> HTTP ' + res.status + ' ' + text.slice(0, 200));
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastErr;
}

/** Sends one or more messages to a queue. Accepts raw strings or { body, attributes }. */
async function send(queue, messages) {
  const items = messages.map((m) => {
    if (typeof m === 'string') {
      return { body: m };
    }
    return {
      body: JSON.stringify(m.body !== undefined ? m.body : m),
      attributes: m.attributes || {}
    };
  });
  return request('POST', '/api/queues/' + encodeURIComponent(queue) + '/messages', { messages: items });
}

/** Receives up to `max` visible messages, hiding them for visibilityTimeoutSec. */
async function receive(queue, opts = {}) {
  const max = opts.max || 10;
  const visibilityTimeoutSec = opts.visibilityTimeoutSec || 30;
  return request('POST', '/api/queues/' + encodeURIComponent(queue) + '/messages/receive', {
    max,
    visibilityTimeoutSec
  });
}

/** Deletes received messages by receipt handle (acknowledges processing). */
async function remove(queue, receiptHandles) {
  return request('POST', '/api/queues/' + encodeURIComponent(queue) + '/messages/delete', {
    receiptHandles
  });
}

/** Queue depth + throughput counters, used by the scaler/verifier. */
async function stats(queue) {
  return request('GET', '/api/queues/' + encodeURIComponent(queue) + '/stats');
}

module.exports = { send, receive, remove, stats, DEFAULT_QUEUE_URL };
