'use strict';

/**
 * Shared domain model + validation for telemetry records.
 * Mirrors the data schemas defined in the project plan (Section "Data Design and Schemas").
 *
 * Telemetry record:
 *   { "zone": "east-office", "time": "...Z",
 *     "temp_celsius": 24.5, "humidity": 52.0, "co2_ppm": 850, "occupancy": true }
 */

const ZONES = ['east-office', 'west-office', 'meeting-room'];

// NFR3 safety envelope from the project plan (18-26 degC hard limits).
const HARD_TEMP_MIN = 18;
const HARD_TEMP_MAX = 26;

// FR1: emergency edge fan threshold + hysteresis for clearing the alert.
const EMERGENCY_CO2_PPM = 1000;
const EMERGENCY_CLEAR_CO2_PPM = 850;

// Telemetry cadence (seconds) used at the edge between cloud publishes.
const EDGE_PUBLISH_SECONDS = 5;

const PHYSICAL_RANGE = {
  temp_celsius: [-40, 60], // tolerate sensor noise, reject nonsense
  humidity: [0, 100],
  co2_ppm: [300, 5000]
};

function isValidZone(zone) {
  return typeof zone === 'string' && /^[a-z0-9-]+$/.test(zone);
}

/**
 * Validates and normalises a raw telemetry payload coming off the queue.
 * Returns { ok: true, record } or { ok: false, error }.
 */
function validateTelemetry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'payload is not an object' };
  }
  const zone = raw.zone;
  if (!isValidZone(zone)) {
    return { ok: false, error: 'missing/invalid zone: ' + String(zone) };
  }
  const time = new Date(raw.time);
  if (Number.isNaN(time.getTime())) {
    return { ok: false, error: 'invalid time: ' + String(raw.time) };
  }
  for (const field of ['temp_celsius', 'humidity', 'co2_ppm']) {
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field])) {
      return { ok: false, error: 'invalid numeric field ' + field };
    }
    const [lo, hi] = PHYSICAL_RANGE[field];
    if (raw[field] < lo || raw[field] > hi) {
      return { ok: false, error: field + ' out of physical range' };
    }
  }
  if (typeof raw.occupancy !== 'boolean') {
    return { ok: false, error: 'occupancy must be boolean' };
  }
  const record = {
    zone,
    time: time.toISOString(),
    temp_celsius: Math.round(raw.temp_celsius * 100) / 100,
    humidity: Math.round(raw.humidity * 100) / 100,
    co2_ppm: Math.round(raw.co2_ppm),
    occupancy: raw.occupancy,
    edge: raw.edge || 'nodered'
  };
  return { ok: true, record };
}

/** Clamps a value between lo and hi (shared safety helper). */
function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** "2026-07-26T02:45:00Z" -> "2026-07-26T02:45" minute key used for aggregation. */
function minuteKey(isoTime) {
  return isoTime.slice(0, 16);
}

module.exports = {
  ZONES,
  HARD_TEMP_MIN,
  HARD_TEMP_MAX,
  EMERGENCY_CO2_PPM,
  EMERGENCY_CLEAR_CO2_PPM,
  EDGE_PUBLISH_SECONDS,
  validateTelemetry,
  clamp,
  minuteKey,
  isValidZone
};
