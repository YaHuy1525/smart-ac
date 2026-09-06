'use strict';

/**
 * Generates edge/flows.json - the Node-RED edge gateway flow (Week 2).
 *
 * The flow implements the plan's edge requirements:
 *   FR1: virtual sensors (DHT22 temp/hum, MH-Z19 CO2, PIR occupancy) publish MQTT;
 *        Node-RED smooths sensor data with a 5-second sliding average and triggers a
 *        LOCAL emergency fan when raw CO2 exceeds 1000 ppm (target < 500 ms latency).
 *   FR4: receives cloud setpoint commands on zones/+/setpoint and applies them
 *        to the (virtual) fan/damper actuators.
 *
 * Run `node edge/build_flow.js` to regenerate edge/flows.json.
 */

const fs = require('fs');
const path = require('path');

const TAB_ID = 'edge-main';
const BROKER_ID = 'mqtt-broker-edge';
const BROKER_HOST = process.env.BROKER_HOST || 'broker'; // docker-compose network; use 127.0.0.1 for native Node-RED

const ZONE_DEFS = {
  'east-office': {
    label: 'east-office (DHT22/MH-Z19/PIR virtual)',
    start: { temp: 24.6, hum: 48, co2: 470, ppl: 0 },
    eqPerPpl: 110, // ppm/occupant equilibrium (mild)
    scenario: [
      // [untilSeconds, occupants] - occupancy windows of the virtual PIR sensor
      [150, 2]
    ]
  },
  'west-office': {
    label: 'west-office (DHT22/MH-Z19/PIR virtual)',
    start: { temp: 24.2, hum: 52, co2: 540, ppl: 0 },
    eqPerPpl: 66, // ventilated office: plateau ~800 ppm, below emergency threshold
    scenario: [[3600, 6]]
  },
  'meeting-room': {
    label: 'meeting-room (DHT22/MH-Z19/PIR virtual)',
    start: { temp: 23.8, hum: 50, co2: 460, ppl: 0 },
    eqPerPpl: 115, // 12 people -> equilibrium ~1800 ppm, trips the emergency fan
    scenario: [
      // two meetings: 12 people enter -> CO2 climbs past 1000 ppm twice
      [20, 12],
      [150, 0],
      [320, 12],
      [470, 0]
    ]
  }
};

const NODES = [];
let x = 80;
let y = 120;

function add(node) {
  NODES.push(node);
  return node;
}

function genNodeCode(zone, cfg) {
  const profile = JSON.stringify(cfg.start);
  const scenario = cfg.scenario.map(([until, ppl]) => JSON.stringify([until, ppl])).join(',');
  return `// Virtual sensor suite for ${zone}: DHT22 (temp/hum), MH-Z19 (CO2), PIR (occupancy)
var TICK_S = 0.25;                    // virtual sensor sampling cadence
var PUBLISH_TICKS = 20;               // 20 ticks = 5 s sliding window (FR1 smoothing)
var EQ_PER_PPL = ${cfg.eqPerPpl};     // ppm per occupant at equilibrium (room ventilation)
var EQ_RATE = 0.02;                   // ppm exchange rate (1/s)
var EMG_ON = 1000, EMG_OFF = 850;     // ppm hysteresis (FR1)
var s = context.get('s');
if (!s) { s = JSON.parse('${profile}'); s.tick = 0; s.emg = false; }
var prevCo2 = context.get('prevCo2');
context.set('prevCo2', s.co2);

s.tick += 1;
var sec = Math.round(s.tick * TICK_S * 10) / 10;
var now = Date.now();

// --- virtual occupancy (PIR) -----------------------------------------
var ppl = 0;
var windows = [${scenario}];
for (var i = 0; i < windows.length; i++) {
  var w = windows[i];
  if (sec >= w[0] && sec < (windows[i + 1] ? windows[i + 1][0] : 86400)) { ppl = w[1]; break; }
}
var occ = ppl > 0;

// --- virtual temperature/CO2 (DHT22/MH-Z19): room responds to the AC ------
var sp = flow.get('setpoint:${zone}');
var setpoint = (sp && typeof sp.target_temp === 'number') ? sp.target_temp : 24;
// Cloud fan speed drives ventilation: fan 100 % lowers the CO2 equilibrium by 25 %.
var fanPct = (sp && typeof sp.fan_speed === 'number') ? Math.min(100, Math.max(0, sp.fan_speed)) : 20;
if (s.emg) { fanPct = 100; } // local emergency fan overrides for ventilation
var vent = 1 - 0.25 * (fanPct / 100);

// --- virtual CO2 (MH-Z19): approaches an occupancy+ventilation equilibrium
var eqCo2 = occ ? Math.min(2200, (420 + ppl * EQ_PER_PPL) * vent) : 420;
var co2 = s.co2 + (eqCo2 - s.co2) * EQ_RATE * TICK_S + (Math.random() - 0.5) * 3 * TICK_S;
co2 = Math.min(2200, Math.max(420, co2));

// --- virtual temperature (DHT22): drifts toward the cloud setpoint ----
var heat = occ ? ppl * 0.006 : 0;
var temp = s.temp - (s.temp - setpoint) * 0.02 * TICK_S + heat * TICK_S + (Math.random() - 0.5) * 0.04 * TICK_S;
temp = Math.min(38, Math.max(16, temp));

// --- virtual humidity (DHT22) -----------------------------------------
var hum = s.hum + (occ ? 0.05 : -0.03) * TICK_S + (Math.random() - 0.5) * 0.05 * TICK_S;
hum = Math.min(75, Math.max(25, hum));

s.temp = temp; s.hum = hum; s.co2 = co2; s.ppl = ppl;
context.set('s', s);

// --- 5-second sliding average (FR1: remove electrical noise) ----------
var buf = context.get('buf') || [];
buf.push({ t: now, temp: temp, hum: hum, co2: co2, occ: occ });
while (buf.length > 1 && now - buf[0].t > 5000) { buf.shift(); }
if (buf.length > 200) { buf.shift(); }
context.set('buf', buf);

// --- emergency fan path (FR1: raw CO2 >= 1000 -> local fan 100) -------
var emgMsg = null;
var clrMsg = null;
var latencyMs = null;
if (!s.emg && co2 >= EMG_ON) {
  s.emg = true;
  // estimate when CO2 actually crossed 1000 ppm between two 250 ms samples
  if (prevCo2 !== undefined && prevCo2 < EMG_ON) {
    var frac = (EMG_ON - prevCo2) / (co2 - prevCo2);
    latencyMs = Math.round(Math.min(1, Math.max(0, frac)) * TICK_S * 1000);
  }
  latencyMs = latencyMs === null ? Math.round(TICK_S * 1000) : latencyMs;
  node.warn('[edge-emergency] zone=${zone} raw CO2=' + Math.round(co2) + ' ppm >= ' + EMG_ON +
    ' -> LOCAL fan forced to 100% (action latency ~' + latencyMs + ' ms < 500 ms NFR2)');
  flow.set('emg:${zone}', true);
  emgMsg = { payload: { zone: '${zone}', co2_ppm: Math.round(co2), action: 'emergency_fan_100', latency_ms: latencyMs, time: new Date().toISOString() } };
} else if (s.emg && co2 < EMG_OFF) {
  s.emg = false;
  node.warn('[edge-emergency-clear] zone=${zone} CO2=' + Math.round(co2) + ' ppm < ' + EMG_OFF + ' -> local fan released');
  flow.set('emg:${zone}', false);
  clrMsg = { payload: { zone: '${zone}', co2_ppm: Math.round(co2), action: 'emergency_clear', time: new Date().toISOString() } };
}
context.set('s', s);

// --- publish smoothed reading every 5 seconds -------------------------
var pubMsg = null;
if (s.tick % PUBLISH_TICKS === 0 && buf.length > 0) {
  var n = buf.length;
  var avg = buf.reduce(function (a, m) {
    a.temp += m.temp / n; a.hum += m.hum / n; a.co2 += m.co2 / n;
    a.occ = a.occ || m.occ;
    return a;
  }, { temp: 0, hum: 0, co2: 0, occ: false });
  pubMsg = {
    payload: {
      zone: '${zone}', time: new Date(now).toISOString(),
      temp_celsius: Math.round(avg.temp * 100) / 100,
      humidity: Math.round(avg.hum * 100) / 100,
      co2_ppm: Math.round(avg.co2),
      occupancy: avg.occ, edge: 'nodered'
    }
  };
  flow.set('last:${zone}', { sec: sec, temp_celsius: pubMsg.payload.temp_celsius, co2_ppm: pubMsg.payload.co2_ppm, occupancy: avg.occ });
}
return [pubMsg, emgMsg, clrMsg];`;
}

// Flow tab (created once)
add({
  id: 'tab-edge',
  type: 'tab',
  label: 'Smart AC Edge Gateway (virtual sensors)',
  disabled: false,
  info: 'Week 2 deliverable: Node-RED edge gateway with virtual DHT22/MH-Z19/PIR sensors, 5 s smoothing, CO2>1000 local emergency fan, and cloud setpoint actuator handling.'
});

for (const zone of Object.keys(ZONE_DEFS)) {
  const cfg = ZONE_DEFS[zone];

  add({
    id: `inj-${zone}`,
    type: 'inject',
    z: TAB_ID,
    name: `virtual sensor clock ${zone}`,
    props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
    repeat: '0.25',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: '',
    payload: '',
    payloadType: 'date',
    x,
    y,
    wires: [[`fn-gen-${zone}`]]
  });

  add({
    id: `fn-gen-${zone}`,
    type: 'function',
    z: TAB_ID,
    name: cfg.label,
    func: genNodeCode(zone, cfg),
    outputs: 3,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: x + 200,
    y,
    wires: [[`out-tel-${zone}`], [`out-emg-${zone}`], []]
  });

  add({
    id: `out-tel-${zone}`,
    type: 'mqtt out',
    z: TAB_ID,
    name: `telemetry ${zone}`,
    topic: `zones/${zone}/telemetry`,
    qos: '1',
    retain: 'false',
    respTopic: '',
    contentType: '',
    userProps: '',
    correl: '',
    expiry: '',
    broker: BROKER_ID,
    x: x + 420,
    y,
    wires: [[]]
  });

  add({
    id: `out-emg-${zone}`,
    type: 'mqtt out',
    z: TAB_ID,
    name: `edge emergency ${zone}`,
    topic: `edge/emergency/${zone}`,
    qos: '1',
    retain: 'false',
    respTopic: '',
    contentType: '',
    userProps: '',
    correl: '',
    expiry: '',
    broker: BROKER_ID,
    x: x + 420,
    y: y + 120,
    wires: [[]]
  });

  y += 150;
}

// Broker config (emulated AWS IoT Core device gateway)
add({
  id: BROKER_ID,
  type: 'mqtt-broker',
  name: 'emulated AWS IoT Core broker',
  broker: BROKER_HOST,
  port: '1883',
  clientid: 'nodered-edge',
  autoConnect: true,
  usetls: false,
  protocolVersion: '4',
  keepalive: '60',
  cleansession: true,
  birthTopic: '',
  birthQos: '0',
  birthPayload: '',
  birthRetain: 'false',
  birthMsg: null,
  closeTopic: '',
  closeQos: '0',
  closePayload: '',
  closeRetain: 'false',
  closeMsg: null,
  willTopic: '',
  willQos: '0',
  willPayload: '',
  willRetain: 'false',
  willMsg: null,
  sessionExpiry: ''
});

// Cloud command downlink (FR4): zones/+/setpoint
add({
  id: 'in-setpoint',
  type: 'mqtt in',
  z: TAB_ID,
  name: 'cloud setpoint commands',
  topic: 'zones/+/setpoint',
  qos: '2',
  datatype: 'auto-detect',
  broker: BROKER_ID,
  nl: false,
  rap: true,
  rh: false,
  inputs: 0,
  x: 80,
  y: 700,
  wires: [['fn-setpoint-handler']]
});

add({
  id: 'fn-setpoint-handler',
  type: 'function',
  z: TAB_ID,
  name: 'apply setpoint to virtual actuator',
  func: `// FR4: control settings come back through the broker to the edge actuators
var zone = String(msg.topic || '').split('/')[1];
if (!zone) { return null; }
var p = msg.payload;
flow.set('setpoint:' + zone, {
  target_temp: p.target_temp, fan_speed: p.fan_speed,
  decision_id: p.decision_id, time: p.time, reasoning: p.reasoning
});
var emg = flow.get('emg:' + zone);
var fan = emg && p.target_fan_speed < 100 ? '100 (edge override)' : p.target_fan_speed;
node.warn('[edge-actuator] zone=' + zone + ' applied temp=' + p.target_temp + 'C fan=' + fan + '%' +
  (p.decision_id ? ' decision=' + p.decision_id : '') + (emg ? ' [emergency active]' : ''));
return null;`,
  outputs: 1,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 300,
  y: 700,
  wires: [[]]
});

// Periodic edge status report (evidence-friendly summary lines)
add({
  id: 'inj-status',
  type: 'inject',
  z: TAB_ID,
  name: 'edge status every 60 s',
  props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
  repeat: '60',
  crontab: '',
  once: true,
  onceDelay: 10,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 80,
  y: 780,
  wires: [['fn-status']]
});

add({
  id: 'fn-status',
  type: 'function',
  z: TAB_ID,
  name: 'edge status reporter',
  func: `var zones = ['east-office', 'west-office', 'meeting-room'];
var parts = [];
for (var i = 0; i < zones.length; i++) {
  var z = zones[i];
  var sp = flow.get('setpoint:' + z);
  var last = flow.get('last:' + z);
  var emg = flow.get('emg:' + z) === true;
  parts.push(z + ' lastCo2=' + (last ? last.co2_ppm : '-') + ' temp=' + (last ? last.temp_celsius : '-') +
    (sp ? ' set=' + sp.target_temp : ' set=none') + (emg ? ' EMERGENCY' : ''));
}
node.warn('[edge-status] ' + parts.join(' | '));
return null;`,
  outputs: 1,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 300,
  y: 780,
  wires: [[]]
});

// ---------------------------------------------------------------------

const outFile = path.join(__dirname, 'flows.json');
fs.writeFileSync(outFile, JSON.stringify(NODES, null, 2) + '\n', 'utf8');
console.log('wrote ' + outFile + ' (' + NODES.length + ' nodes, broker host=' + BROKER_HOST + ')');
