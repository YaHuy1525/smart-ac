'use strict';

/**
 * Evidence digest builder (Week 7).
 *
 * Reads the full timestamped compose log (evidence/03_week7_full_logs.txt) plus
 * the live /stats endpoints of every service and writes a compact key-events
 * digest (evidence/04_week7_key_events.txt) for the report:
 *
 *   node scripts/key_events.js [logfile] [outfile]
 *
 * Defaults: evidence/03_week7_full_logs.txt -> evidence/04_week7_key_events.txt
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = process.argv[2] || path.join(__dirname, '..', 'evidence', '03_week7_full_logs.txt');
const OUT_FILE = process.argv[3] || path.join(__dirname, '..', 'evidence', '04_week7_key_events.txt');

const PORTS = {
  ingestion: 3120,
  'ai-agent': 3130,
  actuator: 3140,
  broker: 31883,
  queue: 3100
};

async function getJson(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      return { error: 'HTTP ' + res.status };
    }
    return await res.json();
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(t);
  }
}

const log = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : []);

function firstLast(lines) {
  const ts = (l) => {
    const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(l);
    return m ? m[1] : null;
  };
  const times = lines.map(ts).filter((v) => v !== null);
  return { first: times[0] || '-', last: times[times.length - 1] || '-' };
}

const matches = (lines, re) => lines.filter((l) => re.test(l));
const count = (lines, re) => lines.filter((l) => re.test(l)).length;
const uniq = (arr) => Array.from(new Set(arr));
const trimTime = (l) => l.trim().slice(0, 33);

async function main() {
  const out = [];
  const push = (s) => out.push(s);
  const lines = log(LOG_FILE);

  push('=== Key events digest - Smart AC evidence run ===');
  push('generated: ' + new Date().toISOString());
  const win = firstLast(lines);
  push('log window: ' + trimTime(win.first) + '  ->  ' + trimTime(win.last));
  push('log lines: ' + lines.length);
  push('');

  // 1. Boot markers -----------------------------------------------------
  push('--- 1. Service boot markers ---');
  const boot = uniq(matches(lines, /ai-agent ready \(engine:|listening on|edge flow deployed|flows|MQTT broker (up|ready)|queue emulator|actuator ready|ingestion (service )?listening|nodered version/).map((l) => l.trim().slice(0, 220)));
  for (const b of boot.slice(0, 14)) {
    push(b);
  }
  push('');

  // 2. Live counters (service /stats) -----------------------------------
  push('--- 2. Live counters at capture time ---');
  const agent = await getJson('http://127.0.0.1:' + PORTS['ai-agent'] + '/stats');
  const ingest = await getJson('http://127.0.0.1:' + PORTS.ingestion + '/stats');
  const act = await getJson('http://127.0.0.1:' + PORTS.actuator + '/stats');
  const broker = await getJson('http://127.0.0.1:' + PORTS.broker + '/stats');
  const qTel = await getJson('http://127.0.0.1:' + PORTS.queue + '/api/queues/telemetry/stats');
  const qJobs = await getJson('http://127.0.0.1:' + PORTS.queue + '/api/queues/ai-jobs/stats');
  const qAct = await getJson('http://127.0.0.1:' + PORTS.queue + '/api/queues/actuator-jobs/stats');

  if (agent.model) {
    push('ai-agent model : engine=' + agent.model.engine + ' trainedAt=' + agent.model.trainedAt + ' samples=' + JSON.stringify(agent.model.samples) + ' valMetrics=' + JSON.stringify(agent.model.valMetrics));
  }
  if (agent.counters) {
    const c = agent.counters;
    push('ai-agent        : decisionsStored=' + c.decisionsStored + ' noChange=' + c.noChange + ' inferences=' + c.inferences + ' jobsReceived=' + c.jobsReceived + ' monitorRuns=' + c.monitorRuns + ' anomalyTotal=' + c.anomalyTotal + ' anomaliesOpen=' + c.anomaliesOpen + ' lastInferenceMs=' + c.lastInferenceMs + ' queueErrors=' + c.queueErrors);
  }
  if (ingest.counters) {
    const c = ingest.counters;
    push('ingestion       : received=' + c.received + ' invalid=' + c.invalid + ' stored=' + c.stored + ' minutesFlushed=' + c.minutesFlushed + ' emergencyJobs=' + c.emergencyJobs + ' minuteJobs=' + c.minuteJobs);
  }
  if (act.counters) {
    const c = act.counters;
    const applied = c.applied || {};
    const perZone = Object.keys(applied)
      .map((z) => z + '=' + applied[z].target_temp + 'C/' + applied[z].fan_speed + '%' + (applied[z].emergency ? ' EMERGENCY' : ''))
      .join('  ');
    push('actuator        : jobsApplied=' + c.jobsApplied + ' mqttPublishFailures=' + c.mqttPublishFailures + ' lastLoopLatencyMs=' + c.lastLoopLatencyMs);
    push('actuator state  : ' + perZone);
  }
  if (broker.mqttPublishes !== undefined) {
    push('broker          : mqttPublishes=' + broker.mqttPublishes + ' rulesForwarded=' + broker.rulesForwarded + ' rulesFailed=' + broker.rulesFailed + ' dlqPending=' + broker.dlqPending);
  } else if (broker.stats || broker.counters) {
    push('broker          : ' + JSON.stringify(broker.stats || broker.counters));
  }
  push('queue depths    : telemetry=' + (qTel.depth !== undefined ? qTel.depth : JSON.stringify(qTel)) + ' ai-jobs=' + (qJobs.depth !== undefined ? qJobs.depth : JSON.stringify(qJobs)) + ' actuator-jobs=' + (qAct.depth !== undefined ? qAct.depth : JSON.stringify(qAct)));
  push('');

  // 3. Closed-loop event trace ------------------------------------------
  push('--- 3. Closed-loop event trace (edge -> cloud -> actuator) ---');
  const evt = [];
  const emg = matches(lines, /\[edge-emergency\]/);
  const clr = matches(lines, /\[edge-emergency-clear\]/);
  const actr = matches(lines, /\[edge-actuator\]/);
  const deci = matches(lines, /decision stored \+ actuator job enqueued/);
  const noChg = matches(lines, /no setpoint change required/);
  const mnEvt = matches(lines, /\[ai-monitor\]/);
  for (const l of emg.concat(clr, actr, deci, noChg, mnEvt)) {
    evt.push(l.trim());
  }
  evt.sort();
  for (const e of evt.slice(0, 400)) {
    push(e.slice(0, 300));
  }
  push('');

  // 4. NFR2 latencies ----------------------------------------------------
  push('--- 4. NFR2 cloud-loop latency (sensor trigger -> decision) ---');
  const lat = deci
    .map((l) => {
      const m = /latencyFromSensorMs":\s*(\d+)/.exec(l);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter((v) => v !== null);
  if (lat.length > 0) {
    const min = Math.min(...lat);
    const max = Math.max(...lat);
    const mean = Math.round(lat.reduce((a, v) => a + v, 0) / lat.length);
    push('decisions with latency=' + lat.length + ' min=' + min + ' ms max=' + max + ' ms mean=' + mean + ' ms (NFR2 target < 2000 ms per decision)');
  } else {
    push('no latency values found');
  }
  const emgLat = emg
    .map((l) => {
      const m = /latency\s*~?\s*(\d+)\s*ms/.exec(l);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter((v) => v !== null);
  if (emgLat.length > 0) {
    push('edge local emergency fan: latencies ' + emgLat.join(' ms, ') + ' ms (NFR2 target < 500 ms)');
  }
  push('');

  // 5. Monitoring skill -------------------------------------------------
  push('--- 5. AI agent monitoring skill ([ai-monitor] events) ---');
  const openAn = matches(lines, /\[ai-monitor\].*WARN|\[ai-monitor\].*(alert|warning)/);
  const resAn = matches(lines, /\[ai-monitor\].*resolved/);
  for (const o of openAn) {
    push(o.trim().slice(0, 220));
  }
  for (const r of resAn.slice(0, 40)) {
    push(r.trim().slice(0, 220));
  }
  push('');

  // 6. Summary -----------------------------------------------------------
  push('--- 6. Rollup ---');
  push('edge emergencies fired: ' + emg.length + ', cleared: ' + clr.length);
  push('cloud decisions stored: ' + count(lines, /decision stored \+ actuator job enqueued/));
  push('"no change" dedupe skips: ' + noChg.length);
  push('[ai-monitor] events: open=' + openAn.length + ' resolved=' + resAn.length);
  push('total lines in window: ' + lines.length);

  fs.writeFileSync(OUT_FILE, out.join('\n') + '\n', 'utf8');
  console.log('wrote ' + OUT_FILE + ' (' + out.length + ' lines)');
}

main().catch((err) => {
  console.error('key_events failed: ' + err.message);
  process.exit(1);
});
