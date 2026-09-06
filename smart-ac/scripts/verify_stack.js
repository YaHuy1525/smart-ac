'use strict';

/**
 * End-to-end stack verification (run after `docker compose up -d`).
 *
 *   node scripts/verify_stack.js
 *
 * Checks, in order:
 *   1. Health of every service (queue, broker, ingestion, ai-agent, actuator, mongo).
 *   2. A send -> receive -> delete round-trip on the SQS emulator (queue semantics).
 *   3. Business metrics pulled from each service /stats endpoint:
 *        - telemetry queue depth / ingestion throughput
 *        - AI decisions stored (with last per-zone decisions + cloud latency)
 *        - actuator applied setpoints (MQTT downlink evidence)
 *   4. Prints a PASS/FAIL report used as evidence (tee to evidence/).
 *
 * Exit code 0 = every check passed, 1 = something failed.
 */

const SERVICE_PORTS = {
  queue: parseInt(process.env.QUEUE_PORT || '3100', 10),
  broker: parseInt(process.env.BROKER_METRICS_PORT || '31883', 10),
  ingestion: parseInt(process.env.INGESTION_PORT || '3120', 10),
  'ai-agent': parseInt(process.env.AI_PORT || '3130', 10),
  actuator: parseInt(process.env.ACTUATOR_PORT || '3140', 10)
};

const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) {
    failures++;
  }
}

async function getJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitHealthy(name, url, tries = 40, delayMs = 1500) {
  for (let i = 1; i <= tries; i++) {
    try {
      const j = await getJson(url, 2000);
      if (j.status === 'ok') {
        return j;
      }
    } catch (_) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

async function checkHealth() {
  for (const name of Object.keys(SERVICE_PORTS)) {
    const j = await waitHealthy(name, `http://127.0.0.1:${SERVICE_PORTS[name]}/health`, 50, 1000);
    record('health:' + name, !!j, j ? 'uptimeSec=' + j.uptimeSec : 'not reachable');
  }
}

async function checkQueueRoundTrip() {
  try {
    const q = 'verify-roundtrip';
    const sent = await fetch('http://127.0.0.1:3100/api/queues/' + q + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ body: JSON.stringify({ ping: true, at: new Date().toISOString() }) }] })
    }).then((r) => r.json());
    const got = await fetch('http://127.0.0.1:3100/api/queues/' + q + '/messages/receive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max: 1, visibilityTimeoutSec: 30 })
    }).then((r) => r.json());
    if (!got.messages || got.messages.length !== 1) {
      throw new Error('receive returned nothing');
    }
    const del = await fetch('http://127.0.0.1:3100/api/queues/' + q + '/messages/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptHandles: [got.messages[0].receiptHandle] })
    }).then((r) => r.json());
    record(
      'queue:roundtrip',
      sent.sent.length === 1 && del.deleted === 1,
      'send=' + sent.sent.length + ' receive=1 delete=' + del.deleted
    );
  } catch (err) {
    record('queue:roundtrip', false, err.message);
  }
}

async function collectBusinessStats() {
  const out = {};
  out.queue = await getJson('http://127.0.0.1:3100/health').catch(() => null);
  const queueStats = {};
  for (const q of ['telemetry', 'ai-jobs', 'actuator-jobs']) {
    queueStats[q] = await getJson('http://127.0.0.1:3100/api/queues/' + q + '/stats').catch(() => null);
  }
  out.queueStats = queueStats;
  out.broker = await getJson('http://127.0.0.1:31883/stats').catch(() => null);
  out.ingestion = await getJson('http://127.0.0.1:3120/stats').catch(() => null);
  out.ai = await getJson('http://127.0.0.1:3130/stats').catch(() => null);
  out.actuator = await getJson('http://127.0.0.1:3140/stats').catch(() => null);
  return out;
}

function assertBusinessEvidence(s) {
  const ing = s.ingestion || {};
  const ai = s.ai || {};
  const act = s.actuator || {};
  const broker = s.broker || {};
  const queueStats = s.queueStats || {};

  record('evidence:telemetry-flow', (ing.counters || {}).stored > 0 && (ing.dbCounts || {}).telemetry > 0,
    'telemetry docs stored=' + ((ing.dbCounts || {}).telemetry ?? 0) + ' (ingestion counters.stored=' + ((ing.counters || {}).stored ?? 0) + ')');
  record('evidence:minute-aggregation', (ing.counters || {}).minutesFlushed > 0,
    'minute aggregates flushed=' + ((ing.counters || {}).minutesFlushed ?? 0));
  record('evidence:ai-decisions', (ai.counters || {}).decisionsStored > 0,
    'decisions stored=' + ((ai.counters || {}).decisionsStored ?? 0) + ' noChange=' + ((ai.counters || {}).noChange ?? 0));
  record('evidence:actuation', (act.counters || {}).jobsApplied > 0 && act.mqttReady === true,
    'setpoints applied=' + ((act.counters || {}).jobsApplied ?? 0) + ' mqttReady=' + act.mqttReady + ' lastLoopLatencyMs=' + ((act.counters || {}).lastLoopLatencyMs ?? '-'));
  record('evidence:broker-rules', (broker.rulesForwarded ?? 0) > 0,
    'mqtt publishes=' + (broker.mqttPublishes ?? 0) + ' rulesForwarded=' + (broker.rulesForwarded ?? 0) + ' dlqPending=' + (broker.dlqPending ?? 0));
  record('evidence:queue-drained', ((queueStats.telemetry || {}).available ?? -1) <= 10,
    'telemetry queue depth=' + ((queueStats.telemetry || {}).available ?? '-') + ' (backlog should be near zero when consumers keep up)');

  // Last decisions per zone (AI schema evidence)
  const last = ai.latestDecisions || {};
  for (const zone of Object.keys(last)) {
    const d = last[zone];
    results.push({
      name: 'decision:' + zone,
      ok: true,
      detail:
        d.target_temp + 'C fan=' + d.target_fan_speed + '% ' + (d.emergency ? 'EMERGENCY' : 'normal') + ' | ' +
        (d.reasoning || '').slice(0, 110) + (ai.counters && ai.counters.lastCloudLatencyMs != null ? ' | lastCloudLatencyMs=' + ai.counters.lastCloudLatencyMs : '')
    });
  }

  // Applied actuator state per zone
  const applied = (act.counters || {}).applied || {};
  for (const zone of Object.keys(applied)) {
    const st = applied[zone];
    results.push({
      name: 'actuator:' + zone,
      ok: true,
      detail: 'target=' + st.target_temp + 'C fan=' + st.fan_speed + '% decision=' + st.decision_id + (st.emergency ? ' EMERGENCY' : '')
    });
  }
}

function printReport() {
  const bar = '='.repeat(72);
  console.log(bar);
  console.log('WEEK 7 STACK VERIFICATION REPORT - Smart AC IoT System');
  console.log('generated ' + new Date().toISOString());
  console.log(bar);
  for (const r of results) {
    console.log('  [' + (r.ok ? 'PASS' : 'FAIL') + '] ' + r.name + (r.detail ? ' - ' + r.detail : ''));
  }
  console.log(bar);
  console.log('RESULT: ' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  console.log(bar);
}

async function main() {
  const mode = process.argv[2] || 'all';
  console.log('verify_stack: checking services on localhost ports', JSON.stringify(SERVICE_PORTS));

  if (mode === 'health') {
    await checkHealth();
  } else {
    await checkHealth();
    await checkQueueRoundTrip();
  }

  if (failures === 0) {
    const s = await collectBusinessStats();
    printReport();
    if (mode !== 'health') {
      // second pass report with evidence once data flows
      console.log('\ncollecting live business metrics...\n');
      assertBusinessEvidence(s);
      printReport();
    }
  } else {
    printReport();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify_stack failed:', err.message);
  process.exit(1);
});
