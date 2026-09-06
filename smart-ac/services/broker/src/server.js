'use strict';

/**
 * MQTT message broker - emulates the AWS IoT Core device gateway.
 *
 * AWS IoT Core role in the plan (FR2 / Week 3):
 *   "Telemetry streams securely via AWS IoT Core and SQS queue to Node.js microservices."
 *
 * Local emulation:
 *   - Aedes MQTT broker on :1883  (device gateway: X.509 TLS in real AWS, MQTT 3.1.1/5 here)
 *   - A "rules engine" subscribes server-side to `zones/+/telemetry` and forwards every
 *     payload into the SQS-emulator queue `telemetry` (IoT Core topic rule action).
 *   - A metrics HTTP endpoint (:31883) exposes broker health and traffic counters.
 *
 * Real-AWS parity: an IoT Core topic rule `SELECT * FROM 'zones/+/telemetry'` with an
 * SQS action performs exactly this forwarding.
 */

const http = require('http');
const net = require('net');
const aedesModule = require('aedes');

const { createLogger } = require('../../lib/logger');
const queue = require('../../lib/queueClient');

const log = createLogger('broker');

const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '31883', 10);

// IoT Core topic rule (emulated): SELECT * FROM 'zones/+/telemetry'
const RULE_TOPIC = /^zones\/([a-z0-9-]+)\/telemetry$/;
const RULE_SQL = "SELECT * FROM 'zones/+/telemetry' ACTION SQS telemetry";

// aedes exports a factory; the broker needs a net/tls server wrapping its handle
const aedes = aedesModule();

const counters = {
  startedAt: Date.now(),
  mqttPublishes: 0,
  rulesForwarded: 0,
  rulesFailed: 0,
  dlqPending: 0
};

/* ------------------------------------------------------------------ */
/* Rules engine: zones/+/telemetry -> SQS-emulator telemetry queue     */
/* ------------------------------------------------------------------ */

const dlq = []; // simple in-memory dead-letter/retry buffer (Risk 4 mitigation)

async function forwardToQueue(record) {
  try {
    await queue.send('telemetry', [{ body: record }]);
    counters.rulesForwarded++;
  } catch (err) {
    counters.rulesFailed++;
    log.error('rule action failed, buffering for retry', { topic: record.topic, error: err.message });
    dlq.push(record);
    if (dlq.length > 2000) {
      dlq.shift(); // never grow unbounded
    }
  }
}

function processPublish(packet, client) {
  counters.mqttPublishes++;
  const match = RULE_TOPIC.exec(packet.topic);
  if (!match) {
    return; // topic not covered by any rule
  }
  let payload;
  try {
    payload = JSON.parse(packet.payload.toString('utf8'));
  } catch (err) {
    log.warn('unparseable payload on rule topic, dropping', { topic: packet.topic, error: err.message });
    return;
  }
  // Enrich exactly like an IoT Core rule would add metadata.
  const record = {
    ...payload,
    zone: match[1],
    mqtt_client: client ? client.id : 'unknown',
    rule_sql: RULE_SQL,
    broker_received_at: new Date().toISOString()
  };
  forwardToQueue(record);
}

aedes.on('publish', (packet, client) => processPublish(packet, client));
aedes.on('client', (client) => {
  log.info('mqtt client connected', { clientId: client.id });
  counters.lastClient = client.id;
});
aedes.on('clientDisconnect', (client) => {
  log.info('mqtt client disconnected', { clientId: client.id });
});
aedes.on('clientError', (client, err) => {
  log.warn('mqtt client error', { clientId: client && client.id, error: err.message });
});

/* ------------------------------------------------------------------ */
/* Metrics HTTP endpoint                                               */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const sendJson = (obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (url.pathname === '/health') {
    return sendJson({ status: 'ok', service: 'broker', uptimeSec: Math.round(process.uptime()) });
  }
  if (url.pathname === '/stats') {
    return sendJson({
      service: 'broker',
      uptimeSec: Math.round(process.uptime()),
      clientsConnected: Object.keys(aedes.connectedClients || {}).length,
      mqttPublishes: counters.mqttPublishes,
      rulesForwarded: counters.rulesForwarded,
      rulesFailed: counters.rulesFailed,
      dlqPending: dlq.length,
      ruleSql: RULE_SQL
    });
  }
  res.writeHead(404);
  res.end();
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

server.listen(METRICS_PORT, () => {
  log.info('broker metrics endpoint on :' + METRICS_PORT);
});

const mqttServer = net.createServer(aedes.handle);

mqttServer.listen(MQTT_PORT, () => {
  log.info('MQTT broker listening on :' + MQTT_PORT + ' (AWS IoT Core emulator)');
  log.info('rules engine active', { ruleSql: RULE_SQL });
});

// Retry buffered rule actions every 5 s (Risk 4: network drop mitigation).
setInterval(async () => {
  while (dlq.length > 0) {
    const record = dlq.shift();
    try {
      await queue.send('telemetry', [{ body: record }]);
      counters.rulesForwarded++;
    } catch (err) {
      dlq.unshift(record);
      counters.dlqPending = dlq.length;
      break;
    }
  }
  counters.dlqPending = dlq.length;
}, 5000);
