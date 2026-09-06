'use strict';

/**
 * Ingestion microservice (Week 4).
 *
 * Plan: "Build Node.js service to pull SQS data and save to MongoDB. Group readings by
 * minute and store clean records." (FR2 cloud ingestion / Week 4 milestone)
 *
 * Responsibilities:
 *   1. Long-polls the `telemetry` queue (SQS emulator) in batches (competing consumer:
 *      multiple replicas may poll the same queue - the basis of Week 7 scaling).
 *   2. Validates every record (schema guard); drops malformed messages.
 *   3. Stores each clean record in `telemetry`.
 *   4. Maintains a per-zone per-minute aggregate (`telemetry_minutes`).
 *   5. Enqueues an `ai-jobs` message for every closed minute, and immediately for a CO2
 *      >= 1000 ppm emergency (fast cloud response path).
 *   6. Deletes queue receipts only after durable success (at-least-once processing).
 */

const http = require('http');

const { createLogger } = require('../../lib/logger');
const { connectStore, randomId } = require('../../lib/store');
const queue = require('../../lib/queueClient');
const { validateTelemetry, minuteKey, EMERGENCY_CO2_PPM, EMERGENCY_CLEAR_CO2_PPM, ZONES } = require('../../lib/telemetry');

const log = createLogger('ingestion');
const PORT = parseInt(process.env.PORT || '3120', 10);
const POLL_INTERVAL_MS = 1000;

const counters = {
  startedAt: Date.now(),
  received: 0,
  invalid: 0,
  stored: 0,
  minutesFlushed: 0,
  emergencyJobs: 0,
  minuteJobs: 0
};

/* ------------------------------------------------------------------ */
/* Minute aggregation (in-memory accumulator per zone/minute)          */
/* ------------------------------------------------------------------ */

const accs = new Map(); // zone -> { minute, count, tSum, hSum, cSum, maxCo2, occupied, firstTime, lastTime }

function accFor(zone, timeIso) {
  const key = minuteKey(timeIso);
  let a = accs.get(zone);
  if (!a || a.minute !== key) {
    a = { zone, minute: key, count: 0, tSum: 0, hSum: 0, cSum: 0, maxCo2: 0, occupied: false, firstTime: timeIso, lastTime: timeIso };
    accs.set(zone, a);
  }
  return a;
}

function buildAggDoc(a) {
  return {
    count: a.count,
    avg_temp_celsius: Math.round((a.tSum / a.count) * 100) / 100,
    avg_humidity: Math.round((a.hSum / a.count) * 100) / 100,
    avg_co2_ppm: Math.round(a.cSum / a.count),
    max_co2_ppm: a.maxCo2,
    occupied: a.occupied,
    first_time: a.firstTime,
    last_time: a.lastTime
  };
}

/* ------------------------------------------------------------------ */
/* Emergency tracking (dedupe: one cloud emergency job per event)      */
/* ------------------------------------------------------------------ */

const emergencyOn = {}; // zone -> true/false, cleared by hysteresis

/* ------------------------------------------------------------------ */
/* Core processing loop                                                */
/* ------------------------------------------------------------------ */

async function handleRecord(record, rawTime) {
  const a = accFor(record.zone, record.time);
  a.count += 1;
  a.tSum += record.temp_celsius;
  a.hSum += record.humidity;
  a.cSum += record.co2_ppm;
  a.maxCo2 = Math.max(a.maxCo2, record.co2_ppm);
  a.occupied = a.occupied || record.occupancy;
  a.lastTime = record.time;

  // Cloud-side emergency trigger on the (smoothed) CO2 reading.
  if (record.co2_ppm >= EMERGENCY_CO2_PPM && !emergencyOn[record.zone]) {
    emergencyOn[record.zone] = true;
    counters.emergencyJobs++;
    await queue.send('ai-jobs', [
      {
        jobId: randomId('JOB'),
        type: 'emergency',
        zone: record.zone,
        time: new Date().toISOString(),
        trigger_record_time: record.time,
        co2_ppm: record.co2_ppm
      }
    ]);
    log.warn('CO2 emergency job enqueued', { zone: record.zone, co2_ppm: record.co2_ppm, trigger_record_time: record.time });
  }
  if (record.co2_ppm < EMERGENCY_CLEAR_CO2_PPM && emergencyOn[record.zone]) {
    emergencyOn[record.zone] = false;
    log.info('CO2 emergency cleared', { zone: record.zone, co2_ppm: record.co2_ppm });
  }
}

/** Flush aggregates that belong to a completed minute (or all if flushAll). */
async function flushMinutes(nowMinute, flushAll) {
  for (const a of accs.values()) {
    const done = flushAll || a.minute < nowMinute;
    if (!done || a.count === 0) {
      continue;
    }
    await flushOne(a);
  }
}

async function flushOne(a) {
  const aggDoc = buildAggDoc(a);
  await store.upsertMinute(a.zone, a.minute, aggDoc);
  counters.minutesFlushed++;
  const isEmergencyMinute = aggDoc.max_co2_ppm >= EMERGENCY_CO2_PPM;
  await queue.send('ai-jobs', [
    {
      jobId: randomId('JOB'),
      type: isEmergencyMinute ? 'emergency-minute' : 'minute',
      zone: a.zone,
      minute: a.minute,
      time: new Date().toISOString(),
      agg: aggDoc,
      trigger_record_time: aggDoc.last_time
    }
  ]);
  counters.minuteJobs++;
  log.info('minute aggregate flushed + ai job enqueued', {
    zone: a.zone,
    minute: a.minute,
    count: a.count,
    avgCo2: aggDoc.avg_co2_ppm,
    occupied: aggDoc.occupied,
    type: isEmergencyMinute ? 'emergency-minute' : 'minute'
  });
  // Reset accumulator so the next minute starts fresh.
  accs.delete(a.zone);
}

async function pollOnce() {
  const res = await queue.receive('telemetry', { max: 10, visibilityTimeoutSec: 30 });
  if (!res.messages || res.messages.length === 0) {
    return 0;
  }
  counters.received += res.messages.length;
  const receipts = [];
  let okCount = 0;
  for (const msg of res.messages) {
    let raw;
    try {
      raw = JSON.parse(msg.body);
    } catch (_) {
      raw = null;
    }
    const v = validateTelemetry(raw);
    if (!v.ok) {
      counters.invalid++;
      log.warn('invalid telemetry dropped', { error: v.error });
      receipts.push(msg.receiptHandle);
      continue;
    }
    try {
      await store.insertTelemetry(v.record);
      okCount++;
      await handleRecord(v.record, msg.enqueuedAt);
      receipts.push(msg.receiptHandle);
    } catch (err) {
      // Leave the receipt undeleted -> visibility timeout -> retried (at-least-once).
      log.error('failed to persist telemetry, will retry after visibility timeout', { zone: v.record.zone, error: err.message });
    }
  }
  counters.stored += okCount;
  if (receipts.length > 0) {
    await queue.remove('telemetry', receipts);
  }
  log.debug('batch processed', { received: res.messages.length, stored: okCount });
  return okCount;
}

/* ------------------------------------------------------------------ */
/* HTTP health/stats                                                   */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const sendJson = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(200, { status: 'ok', service: 'ingestion', uptimeSec: Math.round(process.uptime()) });
  }
  if (req.method === 'GET' && url.pathname === '/stats') {
    const counts = await store.counts();
    let telemetryDepth = null;
    try {
      const s = await queue.stats('telemetry');
      telemetryDepth = s.available;
    } catch (_) {
      /* queue unreachable - report null */
    }
    return sendJson(200, {
      service: 'ingestion',
      uptimeSec: Math.round(process.uptime()),
      counters,
      dbCounts: counts,
      telemetryQueueDepth: telemetryDepth
    });
  }
  sendJson(404, { error: 'not found' });
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

let store;

async function main() {
  store = await connectStore();
  server.listen(PORT, () => log.info('ingestion service listening on :' + PORT));
  log.info('ingestion ready; zones=' + ZONES.join(','));
}

main().catch((err) => {
  log.error('fatal: ' + err.message);
  process.exit(1);
});

setInterval(async () => {
  try {
    await pollOnce();
    const nowMinute = minuteKey(new Date().toISOString());
    await flushMinutes(nowMinute, false);
  } catch (err) {
    log.warn('poll cycle failed', { error: err.message });
  }
}, POLL_INTERVAL_MS);

// Flush everything on shutdown.
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, flushing aggregates');
  try {
    await flushMinutes('', true);
  } finally {
    process.exit(0);
  }
});
