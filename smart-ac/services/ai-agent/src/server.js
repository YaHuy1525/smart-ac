'use strict';

/**
 * AI agent microservice (Week 5).
 *
 * Plan: "Build Node.js AI agent service to calculate best temperature settings."
 * FR3: "Node.js AI agent reads sensor data and MongoDB history to set optimal
 * temperature and fan speed."
 *
 * Loop:
 *   1. Receive `ai-jobs` messages from the queue (minute aggregates / emergencies).
 *   2. Read recent telemetry + history aggregates + current actuator state from the store.
 *   3. Run the decision engine (src/agent.js) - a trained neural-network policy
 *      (src/model/model.json, see train/train_model.js) with NFR3 safety clamps -
 *      -> decision or "no change".
 *   4. Store the decision (plan schema #2) and enqueue an `actuator-jobs` message.
 *   5. Log the cloud-loop latency (sensor sample -> AI decision) as NFR2 evidence.
 *
 * Monitoring skill: a separate loop watches every zone every MONITOR_INTERVAL_MS
 * (see src/monitor.js) and flags stuck sensors, CO2 stress, unreachable setpoints
 * and stale actuators as [ai-monitor] events.
 *
 * NFR2 target: cloud processing completes under 2 seconds (a NN forward pass is
 * microseconds, so the budget is dominated by queue polling + storage).
 */

const http = require('http');

const { createLogger } = require('../../lib/logger');
const { connectStore, randomId } = require('../../lib/store');
const queue = require('../../lib/queueClient');
const { decide, ENGINE_VERSION, MODEL_META } = require('./agent');
const { runDetectors, ZONES } = require('./monitor');

const log = createLogger('ai-agent');
const PORT = parseInt(process.env.PORT || '3130', 10);
const POLL_INTERVAL_MS = 800;
const COOLDOWN_MS = 20000;
const MONITOR_INTERVAL_MS = 20000;

const counters = {
  startedAt: Date.now(),
  jobsReceived: 0,
  decisionsStored: 0,
  noChange: 0,
  skippedCooldown: 0,
  queueErrors: 0,
  lastCloudLatencyMs: null,
  lastInferenceMs: null,
  inferences: 0,
  anomalyTotal: 0,
  anomaliesOpen: 0,
  monitorRuns: 0,
  lastMonitorRun: null
};

const lastDecisionAt = {}; // zone -> epoch ms

/* ------------------------------------------------------------------ */

async function handleJob(msg) {
  let job;
  try {
    job = JSON.parse(msg.body);
  } catch (err) {
    log.warn('unparseable ai job, dropping', { error: err.message });
    return true; // acknowledge & drop
  }
  const zone = job.zone;
  if (!zone) {
    log.warn('ai job without zone, dropping');
    return true;
  }

  const isEmergency = String(job.type || '').startsWith('emergency');
  const now = Date.now();

  // Cooldown for routine minute jobs only; emergencies bypass it.
  if (!isEmergency && lastDecisionAt[zone] && now - lastDecisionAt[zone] < COOLDOWN_MS) {
    counters.skippedCooldown++;
    log.debug('ai job within cooldown, skipping', { zone, type: job.type });
    return true;
  }

  const [telemetry, minutes, actuator] = await Promise.all([
    store.findLatestTelemetry(zone, 8),
    store.findMinutes(zone, 12),
    store.getActuator(zone)
  ]);

  const nowIso = new Date().toISOString();
  const inferenceStart = Date.now();
  const decision = decide({ zone, telemetry, minutes, actuator, job, nowIso });
  counters.lastInferenceMs = Date.now() - inferenceStart;
  if (decision) {
    counters.inferences++;
  }

  if (!decision) {
    counters.noChange++;
    log.info('no setpoint change required', { zone, type: job.type });
    return true;
  }

  await store.insertDecision(decision);
  lastDecisionAt[zone] = now;
  counters.decisionsStored++;

  const latencyMs = job.trigger_record_time ? now - new Date(job.trigger_record_time).getTime() : null;
  if (latencyMs !== null) {
    counters.lastCloudLatencyMs = latencyMs;
  }

  await queue.send('actuator-jobs', [
    {
      jobId: randomId('JOB'),
      type: 'setpoint',
      zone,
      time: nowIso,
      decision_id: decision.decision_id,
      target_temp: decision.target_temp,
      target_fan_speed: decision.target_fan_speed,
      reasoning: decision.reasoning,
      emergency: decision.emergency,
      decision_time: nowIso
    }
  ]);

  log.info('decision stored + actuator job enqueued', {
    decision_id: decision.decision_id,
    zone,
    target_temp: decision.target_temp,
    fan: decision.target_fan_speed,
    emergency: decision.emergency,
    latencyFromSensorMs: latencyMs,
    type: job.type,
    model: decision.model
  });

  if (decision.emergency) {
    log.warn('EMERGENCY decision issued', {
      decision_id: decision.decision_id,
      zone,
      co2_ppm: decision.co2_ppm,
      target_temp: decision.target_temp,
      fan: 100
    });
  }
  return true;
}

async function pollOnce() {
  const res = await queue.receive('ai-jobs', { max: 5, visibilityTimeoutSec: 45 });
  if (!res.messages || res.messages.length === 0) {
    return;
  }
  counters.jobsReceived += res.messages.length;
  const receipts = [];
  for (const msg of res.messages) {
    try {
      await handleJob(msg);
      receipts.push(msg.receiptHandle);
    } catch (err) {
      counters.queueErrors++;
      log.error('ai job processing failed, will retry after visibility timeout', { error: err.message });
    }
  }
  if (receipts.length > 0) {
    await queue.remove('ai-jobs', receipts);
  }
}

/* ------------------------------------------------------------------ */
/* Monitoring skill: watch every zone + its AC unit                    */
/* ------------------------------------------------------------------ */

const activeAnomalies = {}; // zone -> { code: firstSeenIso }

async function runMonitorCycle() {
  const nowIso = new Date().toISOString();
  counters.monitorRuns++;
  counters.lastMonitorRun = nowIso;
  for (const zone of ZONES) {
    const [telemetry, minutes, actuator] = await Promise.all([
      store.findLatestTelemetry(zone, 20),
      store.findMinutes(zone, 4),
      store.getActuator(zone)
    ]);
    const issues = runDetectors({ zone, telemetry, minutes, actuator, nowIso });
    const wasActive = activeAnomalies[zone] || {};
    const isActive = {};
    for (const issue of issues) {
      isActive[issue.code] = nowIso;
      if (!wasActive[issue.code]) {
        counters.anomalyTotal++;
        log.warn('[ai-monitor] ' + zone + ': ' + issue.severity.toUpperCase() + ' ' + issue.code + ' - ' + issue.message);
      }
    }
    for (const code of Object.keys(wasActive)) {
      if (!isActive[code]) {
        log.info('[ai-monitor] ' + zone + ': ' + code + ' resolved (active for ' + ageSecLabel(wasActive[code], nowIso) + ')');
      }
    }
    activeAnomalies[zone] = isActive;
  }
  counters.anomaliesOpen = Object.values(activeAnomalies).reduce((n, codes) => n + Object.keys(codes).length, 0);
}

function ageSecLabel(fromIso, nowIso) {
  return Math.round((new Date(nowIso).getTime() - new Date(fromIso).getTime()) / 1000) + ' s';
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
    return sendJson(200, { status: 'ok', service: 'ai-agent', uptimeSec: Math.round(process.uptime()) });
  }
  if (req.method === 'GET' && url.pathname === '/stats') {
    const dbCounts = await store.counts();
    const latestDecisions = {};
    for (const zone of ['east-office', 'west-office', 'meeting-room']) {
      const list = await store.findDecisions(zone, 1);
      if (list.length > 0) {
        latestDecisions[zone] = list[0];
      }
    }
    return sendJson(200, {
      service: 'ai-agent',
      uptimeSec: Math.round(process.uptime()),
      model: MODEL_META,
      counters,
      activeAnomalies,
      dbCounts,
      latestDecisions
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
  server.listen(PORT, () => log.info('ai-agent service listening on :' + PORT));
  log.info('ai-agent ready (engine: ' + ENGINE_VERSION + ', model trained ' + (MODEL_META.trainedAt || '?') + ', layers ' + JSON.stringify(MODEL_META.layers || '?') + ')');
  // Monitoring skill starts immediately: first cycle flags zones that have not
  // reported yet, then resolves them when telemetry flows (visible in logs).
  runMonitorCycle().catch((err) => log.warn('initial monitor cycle failed', { error: err.message }));
}

main().catch((err) => {
  log.error('fatal: ' + err.message);
  process.exit(1);
});

setInterval(async () => {
  try {
    await pollOnce();
  } catch (err) {
    counters.queueErrors++;
    log.warn('poll cycle failed', { error: err.message });
  }
}, POLL_INTERVAL_MS);

setInterval(async () => {
  try {
    await runMonitorCycle();
  } catch (err) {
    log.warn('monitor cycle failed', { error: err.message });
  }
}, MONITOR_INTERVAL_MS);
