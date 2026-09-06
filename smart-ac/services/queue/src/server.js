'use strict';

/**
 * Local AWS SQS emulator.
 *
 * Emulates the SQS subset used by this project:
 *   POST /api/queues/:name/messages            send (batch)        -> SQS SendMessageBatch
 *   POST /api/queues/:name/messages/receive    receive (batch)     -> SQS ReceiveMessage
 *   POST /api/queues/:name/messages/delete     delete by receipt   -> SQS DeleteMessageBatch
 *   GET  /api/queues/:name/stats               depth counters      -> CloudWatch ApproximateNumberOfMessages
 *   GET  /health
 *
 * Semantics: messages become invisible for `visibilityTimeoutSec` after a receive.
 * If the consumer crashes before deleting, the message becomes visible again
 * once the timeout expires (at-least-once, exactly like SQS). A message is only
 * removed from the queue when it is deleted by its receipt handle - sweeps must
 * never purge in-flight messages, otherwise a consumer that received a message
 * moments earlier can no longer delete it (and may reprocess it).
 *
 * Queue names used by the pipeline:
 *   telemetry         raw telemetry published by the edge (via the broker "rules engine")
 *   ai-jobs           minute aggregates / emergency events -> AI agent
 *   actuator-jobs     AI decisions -> actuator service
 */

const http = require('http');
const crypto = require('crypto');

const { createLogger } = require('../../lib/logger');
const log = createLogger('queue');

const PORT = parseInt(process.env.PORT || '3100', 10);

/* ------------------------------------------------------------------ */
/* Queue internals                                                     */
/* ------------------------------------------------------------------ */

const queues = new Map(); // name -> QueueState

function getQueue(name) {
  if (!queues.has(name)) {
    queues.set(name, {
      name,
      messages: [], // { id, body, enqueuedAt, visibleAt, receipt }
      totalEnqueued: 0,
      totalDeleted: 0
    });
  }
  return queues.get(name);
}

function visibleMessages(queue) {
  // Redelivery semantics: messages stay in the queue until deleted (or DLQ'd).
  // A message received but not yet deleted is invisible until its visibility
  // timeout expires, after which it shows up here again (at-least-once).
  return queue.messages.filter((m) => m.visibleAt <= Date.now());
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // [ 'api', 'queues', name, ... ]

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    const total = [...queues.values()].reduce((a, q) => a + visibleMessages(q).length, 0);
    return sendJson(res, 200, {
      status: 'ok',
      service: 'queue',
      uptimeSec: Math.round(process.uptime()),
      totalVisible: total,
      queues: [...queues.keys()]
    });
  }

  if (parts[0] === 'api' && parts[1] === 'queues' && parts[2]) {
    const name = decodeURIComponent(parts[2]);
    const rest = parts.slice(3); // [] | ['messages'] | ['messages','receive'] | ['messages','delete'] | ['stats']
    const queue = getQueue(name);

    if (req.method === 'POST' && (rest.length === 0 || (rest[0] === 'messages' && rest.length === 1))) {
      // send (SQS SendMessageBatch)
      const body = await readBody(req);
      const sent = [];
      for (const item of body.messages || []) {
        const msgBody = typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
        queue.messages.push({
          id: crypto.randomUUID(),
          body: msgBody,
          attributes: item.attributes || {},
          enqueuedAt: new Date().toISOString(),
          visibleAt: Date.now()
        });
        queue.totalEnqueued++;
        sent.push(queue.messages[queue.messages.length - 1].id);
      }
      log.debug('send ' + sent.length + ' -> ' + name);
      return sendJson(res, 201, { queue: name, sent });
    }

    if (req.method === 'POST' && rest[0] === 'messages' && rest[1] === 'receive') {
      const body = await readBody(req);
      const max = Math.min(parseInt(body.max || '1', 10), 10);
      const vt = parseInt(body.visibilityTimeoutSec || '30', 10);
      const now = Date.now();
      const picked = visibleMessages(queue).slice(0, max);
      const messages = picked.map((m) => {
        m.visibleAt = now + vt * 1000;
        m.receipt = crypto.randomUUID();
        return {
          id: m.id,
          receiptHandle: m.receipt,
          body: m.body,
          enqueuedAt: m.enqueuedAt
        };
      });
      return sendJson(res, 200, {
        queue: name,
        messages,
        visibilityTimeoutSec: vt,
        remainingVisible: visibleMessages(queue).length
      });
    }

    if (req.method === 'POST' && rest[0] === 'messages' && rest[1] === 'delete') {
      const body = await readBody(req);
      const handles = new Set(body.receiptHandles || []);
      const before = queue.messages.length;
      queue.messages = queue.messages.filter((m) => !handles.has(m.receipt));
      queue.totalDeleted += before - queue.messages.length;
      return sendJson(res, 200, { queue: name, deleted: before - queue.messages.length });
    }

    if (req.method === 'GET' && rest[0] === 'stats') {
      const available = visibleMessages(queue).length;
      return sendJson(res, 200, {
        queue: name,
        available,
        inflight: queue.messages.length - available,
        totalEnqueued: queue.totalEnqueued,
        totalDeleted: queue.totalDeleted
      });
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    log.error('request failed', { error: err.message });
    if (!res.headersSent) {
      sendJson(res, 400, { error: err.message });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  log.info('queue service listening on :' + PORT + ' (AWS SQS emulator)');
});

