'use strict';

/**
 * Actuator microservice (Week 6) - closes the control loop (FR4).
 *
 * Plan: "Build actuation service to send commands back to Node-RED actuators."
 * FR4: "Control settings travel back through AWS IoT Core to edge actuators."
 *
 * Loop:
 *   1. Receive `actuator-jobs` messages (AI decisions) from the queue.
 *   2. Persist the applied state to `actuator_state`.
 *   3. Publish the setpoint back through the MQTT broker (AWS IoT Core emulator)
 *      to topic `zones/<zone>/setpoint`, which the Node-RED edge gateway consumes.
 *   4. Log the end-to-end command latency (decision -> applied) as NFR2 evidence.
 *
 * The MQTT client mirrors a physical IoT thing (damper/fan controller) with an
 * X.509 identity in real AWS; here it is a plain MQTT client on the local broker.
 */

const http = require('http');
const mqtt = require('mqtt');

const { createLogger } = require('../../lib/logger');
const { connectStore } = require('../../lib/store');
const queue = require('../../lib/queueClient');

const log = createLogger('actuator');
const PORT = parseInt(process.env.PORT || '3140', 10);
const POLL_INTERVAL_MS = 800;
const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';

const counters = {
  startedAt: Date.now(),
  jobsApplied: 0,
  mqttPublishFailures: 0,
  lastLoopLatencyMs: null,
  applied: {} // zone -> last applied setpoint
};

let store;
let mqttClient = null;
let mqttReady = false;

/* ------------------------------------------------------------------ */
/* MQTT (downlink to the edge gateway / actuators)                     */
/* ------------------------------------------------------------------ */

function connectMqtt() {
  mqttClient = mqtt.connect(MQTT_URL, {
    clientId: 'actuator-cloud-' + Math.random().toString(16).slice(2, 8),
    clean: true,
    connectTimeout: 5000,
    reconnectPeriod: 2000
  });
  mqttClient.on('connect', () => {
    mqttReady = true;
    log.info('connected to MQTT broker (downlink channel ready)', { url: MQTT_URL });
  });
  mqttClient.on('close', () => {
    mqttReady = false;
    log.warn('MQTT connection closed, will reconnect');
  });
  mqttClient.on('error', (err) => {
    mqttReady = false;
    log.error('MQTT error', { error: err.message });
  });
}

function publishSetpoint(zone, payload) {
  return new Promise((resolve, reject) => {
    if (!mqttReady) {
      return reject(new Error('MQTT downlink not connected'));
    }
    const topic = 'zones/' + zone + '/setpoint';
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(topic);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Job processing                                                      */
/* ------------------------------------------------------------------ */

async function handleJob(msg) {
  let job;
  try {
    job = JSON.parse(msg.body);
  } catch (err) {
    log.warn('unparseable actuator job, dropping', { error: err.message });
    return true;
  }
  if (!job.zone || job.type !== 'setpoint') {
    log.warn('actuator job without setpoint payload, dropping');
    return true;
  }
  const zone = job.zone;

  const nowIso = new Date().toISOString();
  const applied = {
    time: nowIso,
    decision_id: job.decision_id,
    target_temp: job.target_temp,
    fan_speed: job.target_fan_speed,
    reasoning: job.reasoning,
    emergency: job.emergency === true
  };

  await store.upsertActuator(zone, applied);
  counters.applied[zone] = applied;

  // FR4: command travels back through the broker to the edge actuators.
  // Schema matches the plan's AI decision record (target_fan_speed / target_temp).
  const topic = await publishSetpoint(zone, {
    ...applied,
    target_fan_speed: job.target_fan_speed,
    source: 'actuator-cloud'
  });

  const latencyMs = job.decision_time ? Date.now() - new Date(job.decision_time).getTime() : null;
  if (latencyMs !== null) {
    counters.lastLoopLatencyMs = latencyMs;
  }
  counters.jobsApplied++;

  log.info('setpoint applied and published to edge', {
    topic,
    decision_id: job.decision_id,
    zone,
    target_temp: job.target_temp,
    fan: job.target_fan_speed,
    emergency: job.emergency === true,
    latencyFromDecisionMs: latencyMs
  });
  return true;
}

async function pollOnce() {
  const res = await queue.receive('actuator-jobs', { max: 5, visibilityTimeoutSec: 45 });
  if (!res.messages || res.messages.length === 0) {
    return;
  }
  const receipts = [];
  for (const msg of res.messages) {
    try {
      await handleJob(msg);
      receipts.push(msg.receiptHandle);
    } catch (err) {
      counters.mqttPublishFailures++;
      log.error('actuator job failed (downlink busy?), will retry', { error: err.message });
      // receipt left undeleted -> message redelivered after the visibility timeout
    }
  }
  if (receipts.length > 0) {
    await queue.remove('actuator-jobs', receipts);
  }
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
    return sendJson(200, {
      status: 'ok',
      service: 'actuator',
      uptimeSec: Math.round(process.uptime()),
      mqttReady
    });
  }
  if (req.method === 'GET' && url.pathname === '/stats') {
    const dbCounts = await store.counts();
    return sendJson(200, {
      service: 'actuator',
      uptimeSec: Math.round(process.uptime()),
      mqttReady,
      counters,
      dbCounts
    });
  }
  sendJson(404, { error: 'not found' });
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  store = await connectStore();
  connectMqtt();
  server.listen(PORT, () => log.info('actuator service listening on :' + PORT));
}

main().catch((err) => {
  log.error('fatal: ' + err.message);
  process.exit(1);
});

setInterval(async () => {
  try {
    await pollOnce();
  } catch (err) {
    log.warn('poll cycle failed', { error: err.message });
  }
}, POLL_INTERVAL_MS);
