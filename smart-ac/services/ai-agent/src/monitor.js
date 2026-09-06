'use strict';

/**
 * AI agent monitoring skill (Week 5 extension) - "the agent can watch the AC".
 *
 * Every MONITOR_INTERVAL_MS the ai-agent service runs these detectors per zone
 * over the stored telemetry / minute aggregates / actuator state. Each detector
 * is a pure function over a snapshot so it can be unit-tested:
 *
 *   NO_TELEMETRY       - zone stopped reporting (edge gateway/sensor link down)
 *   FLAT_SENSOR        - temperature+CO2 perfectly constant for ~1.5 min (stuck sensor)
 *   CO2_RISING         - CO2 >= 900 ppm and climbing >= 80 ppm/min (room filling)
 *   CO2_HIGH           - CO2 >= 1300 ppm reached the cloud unhandled (should not
 *                        happen while ingestion/agent work - real alert)
 *   SETPOINT_UNREACHED - AC commanded hours ago still far from target (broken
 *                        actuator / stuck damper)
 *   ACTUATOR_STALE     - no cloud setpoint applied for this zone in a long time
 *                        while the zone is still reporting
 *
 * Each issue: { code, severity: 'warn'|'alert', zone, message }.
 * The server layer deduplicates, counts and logs them ([ai-monitor] lines).
 */

const { EMERGENCY_CO2_PPM } = require('../../lib/telemetry');

const ZONES = ['east-office', 'west-office', 'meeting-room'];

const LIMITS = {
  noTelemetryAfterSec: 75, // edge publishes every 5 s -> 75 s of silence is real
  flatWindowSec: 90,
  flatMinRecords: 6,
  flatTempRange: 0.03,
  flatCo2Range: 3,
  co2RisingFloor: 900,
  co2RisingRate: 80, // ppm/min
  co2HighPpm: EMERGENCY_CO2_PPM + 300, // 1300
  setpointAgeSec: 180, // give the room its ~50 s time constant + margin
  setpointGapC: 4.0, // 12 occupants shift equilibrium ~3.6 C below 22 C target
  staleActuatorSec: 720
};

function ageSec(isoTime, nowIso) {
  if (!isoTime) {
    return Infinity;
  }
  return (new Date(nowIso).getTime() - new Date(isoTime).getTime()) / 1000;
}

/** Range of a numeric field across a newest-first record list (null if empty). */
function fieldRange(list, field) {
  if (!list || list.length < 2) {
    return null;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of list) {
    if (typeof r[field] !== 'number') {
      continue;
    }
    if (r[field] < lo) lo = r[field];
    if (r[field] > hi) hi = r[field];
  }
  return hi - lo;
}

/**
 * Runs every detector for one zone.
 * @param {object} snap { zone, telemetry (newest first), minutes, actuator, nowIso }
 * @returns {Array<{code,severity,message}>}
 */
function runDetectors(snap) {
  const { zone, telemetry = [], minutes = [], actuator, nowIso } = snap;
  const now = new Date(nowIso || Date.now());
  const issues = [];

  const newest = telemetry[0];
  const telAge = newest ? ageSec(newest.time, now.toISOString()) : Infinity;

  // 1. Zone stopped reporting telemetry.
  if (telAge > LIMITS.noTelemetryAfterSec) {
    issues.push({
      code: 'NO_TELEMETRY',
      severity: 'warn',
      zone,
      message: 'no telemetry for ' + Math.round(telAge) + ' s (edge gateway or sensor link suspect)'
    });
  }

  // 2. Stuck sensor: plausible number of readings, but zero spread.
  if (telAge < LIMITS.flatWindowSec && telemetry.length >= LIMITS.flatMinRecords) {
    const tRange = fieldRange(telemetry.slice(0, LIMITS.flatMinRecords), 'temp_celsius');
    const cRange = fieldRange(telemetry.slice(0, LIMITS.flatMinRecords), 'co2_ppm');
    if (tRange !== null && cRange !== null && tRange <= LIMITS.flatTempRange && cRange <= LIMITS.flatCo2Range) {
      issues.push({
        code: 'FLAT_SENSOR',
        severity: 'warn',
        zone,
        message: 'sensor looks stuck: temp spread ' + tRange.toFixed(3) + ' C, CO2 spread ' + cRange.toFixed(1) + ' ppm over ' + LIMITS.flatMinRecords + ' readings'
      });
    }
  }

  const co2 = newest ? newest.co2_ppm : null;
  const co2Trend =
    minutes && minutes.length >= 2 && typeof minutes[0].avg_co2_ppm === 'number' && typeof minutes[1].avg_co2_ppm === 'number'
      ? minutes[0].avg_co2_ppm - minutes[1].avg_co2_ppm
      : null;

  // 3. CO2 rising into the danger zone (pre-emergency ventilation failure).
  if (co2 !== null && co2 >= LIMITS.co2RisingFloor && co2Trend !== null && co2Trend >= LIMITS.co2RisingRate) {
    issues.push({
      code: 'CO2_RISING',
      severity: 'warn',
      zone,
      message: 'CO2 ' + co2 + ' ppm and rising ' + co2Trend + ' ppm/min - ventilation demand'
    });
  }

  // 4. CO2 reached the cloud unhandled (emergency pipeline missed it).
  if (co2 !== null && co2 >= LIMITS.co2HighPpm) {
    issues.push({
      code: 'CO2_HIGH',
      severity: 'alert',
      zone,
      message: 'CO2 ' + co2 + ' ppm reached the cloud without an emergency decision'
    });
  }

  const temp = newest ? newest.temp_celsius : null;

  // 5. AC commanded but never reaching its target.
  if (actuator && typeof actuator.target_temp === 'number' && temp !== null && temp !== undefined) {
    const actAge = ageSec(actuator.time, now.toISOString());
    const gap = Math.abs(temp - actuator.target_temp);
    if (actAge >= LIMITS.setpointAgeSec && gap > LIMITS.setpointGapC) {
      issues.push({
        code: 'SETPOINT_UNREACHED',
        severity: 'warn',
        zone,
        message:
          'room at ' + Math.round(temp * 10) / 10 + ' C still ' + Math.round(gap * 10) / 10 + ' C from target ' +
          actuator.target_temp + ' C (fan ' + (actuator.fan_speed ?? '?') + '%) - AC may not be responding'
      });
    }
  }

  // 6. No cloud setpoint applied for a long time while the zone is alive.
  const actAge2 = actuator ? ageSec(actuator.time, now.toISOString()) : Infinity;
  if (actAge2 > LIMITS.staleActuatorSec && telAge < LIMITS.noTelemetryAfterSec) {
    issues.push({
      code: 'ACTUATOR_STALE',
      severity: 'warn',
      zone,
      message: 'no cloud AC command applied for ' + Math.round(actAge2 / 60) + ' min while the zone is reporting'
    });
  }

  return issues;
}

module.exports = { runDetectors, LIMITS, ZONES };
