'use strict';

/**
 * AI agent decision engine (Week 5) - neural-network policy with guardrails.
 *
 * FR3: "Node.js AI agent reads sensor data and MongoDB history to set optimal
 * temperature and fan speed."
 *
 * The setpoint/fan POLICY itself is a trained neural network (src/model/model.json,
 * see src/nn.js and train/train_model.js): given the zone state it outputs the
 * action that minimises an expected comfort + IAQ + energy cost learned from a
 * simulated building. Two hard guardrails always wrap the model output:
 *
 *   - NFR3 safety envelope: target temperature clamped to [18, 26] degC.
 *   - CO2 emergency (>= 1000 ppm): fan 100 % and 22.0 degC (plan FR1 cloud side).
 *
 * Inputs are ordered newest-first lists. The caller supplies:
 *   telemetry[]: validated telemetry records (latest first)
 *   minutes[]:   per-minute aggregates (latest first)
 *   actuator:    current applied state or null
 *   job:         the ai-jobs queue message {type, zone, ...}
 */

const { randomId } = require('../../lib/store');
const { clamp, HARD_TEMP_MIN, HARD_TEMP_MAX, EMERGENCY_CO2_PPM } = require('../../lib/telemetry');
const nn = require('./nn');

const ENGINE_VERSION = 'ai-agent-nn-v1';
// Model metadata for boot logs /stats. Resilient: until train_model.js has run,
// the deterministic fallback policy below keeps the agent functional.
let MODEL_META = { engine: ENGINE_VERSION, trainedAt: null, error: null };
try {
  MODEL_META = nn.modelInfo();
} catch (err) {
  MODEL_META = { engine: ENGINE_VERSION, trainedAt: null, error: err.message };
}

/* ------------------------------------------------------------------ */
/* Feature extraction                                                  */
/* ------------------------------------------------------------------ */

function mean(list, field) {
  if (!list || list.length === 0) {
    return null;
  }
  return list.reduce((s, x) => s + (x[field] ?? 0), 0) / list.length;
}

function latest(list, field, fallback) {
  if (!list || list.length === 0) {
    return fallback;
  }
  return list[0][field] ?? fallback;
}

/**
 * CO2 trend in ppm/minute from per-minute aggregates.
 * Returns null when there are fewer than two points.
 */
function co2TrendPpmPerMin(minutes) {
  if (!minutes || minutes.length < 2) {
    return null;
  }
  const a = minutes[0]; // newest
  const b = minutes[1];
  return a.avg_co2_ppm - b.avg_co2_ppm;
}

/**
 * Builds the 7-feature model input from the stored context. Order must match
 * src/model/model.json meta.features and src/nn.js predict().
 */
function buildFeatures({ telemetry, minutes, actuator, occupied, avgTemp, avgCo2 }) {
  const curSetpoint = actuator && typeof actuator.target_temp === 'number' ? actuator.target_temp : 24;
  const curFan = actuator && typeof actuator.fan_speed === 'number' ? actuator.fan_speed : 20;
  return [
    occupied ? 1 : 0,
    avgTemp ?? 24,
    avgCo2 ?? 450,
    co2TrendPpmPerMin(minutes) ?? 0,
    curSetpoint,
    curFan,
    (avgTemp ?? 24) - curSetpoint
  ];
}

/* ------------------------------------------------------------------ */
/* Fallback policy (only used if model.json is missing or corrupt)     */
/* ------------------------------------------------------------------ */

function fallbackDecision(occupied, avgTemp, avgCo2, emergency) {
  let targetTemp;
  if (emergency) {
    targetTemp = 22.0;
  } else if (!occupied) {
    targetTemp = 26.0;
  } else if (avgTemp >= 27) {
    targetTemp = 21.5;
  } else if (avgTemp >= 25.5) {
    targetTemp = 22.5;
  } else if (avgTemp >= 23) {
    targetTemp = 23.5;
  } else if (avgTemp >= 21) {
    targetTemp = 24.5;
  } else {
    targetTemp = 25.5;
  }
  return { targetTemp, fan: fallbackFan(occupied, avgCo2, avgTemp, emergency) };
}

function fallbackFan(occupied, avgCo2, avgTemp, emergency) {
  if (emergency) {
    return 100;
  }
  if (!occupied) {
    return 20;
  }
  let fan = 30;
  if (avgCo2 >= 600) {
    fan += 15;
  }
  if (avgCo2 >= 800) {
    fan += 30;
  }
  if (avgCo2 >= 1000) {
    fan += 50;
  }
  if (avgTemp >= 26) {
    fan += 15;
  }
  return Math.round(clamp(fan, 0, 100));
}

/* ------------------------------------------------------------------ */
/* Reasoning text (every decision stores an explainable why)           */
/* ------------------------------------------------------------------ */

function buildReasoning(ctx) {
  const parts = [];
  if (ctx.emergency) {
    parts.push('CO2 emergency detected (' + Math.round(ctx.co2Ppm) + ' ppm >= ' + EMERGENCY_CO2_PPM + ' ppm), safety override forces fan 100% and 22.0C');
  } else if (!ctx.occupied) {
    parts.push('unoccupied room, energy-saving target ' + ctx.setpoint + 'C');
    if (ctx.fan > 25) {
      parts.push('fan ' + ctx.fan + '% to keep the room fresh');
    }
  } else {
    parts.push('occupied room ' + Math.round(ctx.avgTemp * 10) / 10 + 'C, comfort target ' + ctx.setpoint + 'C');
    if (ctx.co2Ppm >= 700) {
      parts.push('CO2 at ' + Math.round(ctx.co2Ppm) + ' ppm, fan ' + ctx.fan + '% for ventilation');
    }
    if (ctx.co2Trend !== null && ctx.co2Trend >= 60) {
      parts.push('CO2 rising ' + Math.round(ctx.co2Trend) + ' ppm/min, ventilating proactively');
    }
  }
  parts.push('model ' + ENGINE_VERSION);
  return parts.join('. ') + '.';
}

/**
 * Computes one AI decision for a zone using the trained NN policy.
 * Returns null when nothing meaningful would change: the model output that
 * falls within a small hysteresis dead-band of the applied actuator state is
 * suppressed, so flat cost regions (e.g. an empty room) cannot make the agent
 * flip-flop between near-identical commands every minute.
 */
function decide(opts) {
  const { zone, telemetry = [], minutes = [], actuator = null, job = {}, nowIso } = opts;
  const jobType = job.type || 'minute';
  const emergency =
    jobType.startsWith('emergency') ||
    latest(telemetry, 'co2_ppm', 400) >= EMERGENCY_CO2_PPM ||
    latest(minutes, 'max_co2_ppm', 400) >= EMERGENCY_CO2_PPM;

  const occupied = emergency ? true : latest(telemetry, 'occupancy', false);
  const avgTemp = mean(telemetry, 'temp_celsius') ?? latest(minutes, 'avg_temp_celsius', 24);
  const avgCo2 = mean(telemetry, 'co2_ppm') ?? latest(minutes, 'avg_co2_ppm', 450);
  const co2Trend = co2TrendPpmPerMin(minutes);
  // For emergency messages show the worst recent reading (not the window average).
  const displayCo2 = emergency
    ? Math.max(avgCo2, latest(telemetry, 'co2_ppm', 400), latest(minutes, 'max_co2_ppm', 400))
    : avgCo2;

  let targetTemp;
  let fan;

  if (emergency) {
    // Safety guardrail (FR1 cloud side): fan 100 % + 22 C, never delegated to the model.
    targetTemp = 22.0;
    fan = 100;
  } else {
    // Normal control: the neural-network policy picks the action.
    const features = buildFeatures({ telemetry, minutes, actuator, occupied, avgTemp, avgCo2 });
    let predicted = null;
    try {
      predicted = nn.predict(features);
    } catch (err) {
      predicted = null; // fall back to the deterministic policy below
    }
    if (predicted && Number.isFinite(predicted.setpoint) && Number.isFinite(predicted.fan)) {
      // NFR3 safety clamp AFTER the model output, before rounding.
      targetTemp = clamp(predicted.setpoint, HARD_TEMP_MIN, HARD_TEMP_MAX);
      targetTemp = Math.round(targetTemp * 2) / 2;
      fan = Math.round(clamp(predicted.fan, 0, 100));
    } else {
      const fb = fallbackDecision(occupied, avgTemp, avgCo2, false);
      targetTemp = fb.targetTemp;
      fan = fb.fan;
    }
  }

  // Dead-band suppression: only re-issue a command when the policy wants a
  // meaningful change (>= 1.0 C or >= 25 % fan). Emergencies always re-apply.
  const sameAsActuator =
    actuator &&
    !emergency &&
    Math.abs(actuator.target_temp - targetTemp) < 1.0 &&
    Math.abs(actuator.fan_speed - fan) < 25;

  if (sameAsActuator && jobType !== 'emergency') {
    return null;
  }

  const reasoning = buildReasoning({
    occupied,
    emergency,
    setpoint: targetTemp,
    avgTemp,
    co2Ppm: displayCo2,
    co2Trend,
    fan
  });

  return {
    decision_id: randomId('DEC'),
    zone,
    time: nowIso || new Date().toISOString(),
    reasoning,
    target_fan_speed: fan,
    target_temp: targetTemp,
    occupied,
    emergency,
    co2_ppm: Math.round(displayCo2),
    temp_celsius: Math.round(avgTemp * 10) / 10,
    model: ENGINE_VERSION,
    source: ENGINE_VERSION,
    job_type: jobType
  };
}

module.exports = { decide, ENGINE_VERSION, MODEL_META };
