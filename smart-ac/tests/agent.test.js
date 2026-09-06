'use strict';

/**
 * Unit tests for the AI agent decision engine (plan testing section:
 * "Jest test scripts test Node.js microservice logic and AI agent decision limits").
 *
 * The engine is a trained neural-network policy (ai-agent-nn-v1) wrapped by
 * deterministic safety guardrails. These tests pin the guardrails exactly and
 * assert the learned policy's behavioural invariants (energy saving when empty,
 * more cooling+ventilation when the room is hot/stuffy), so they stay valid
 * even if the model is retrained.
 */

const { decide } = require('../services/ai-agent/src/agent');
const { HARD_TEMP_MIN, HARD_TEMP_MAX, EMERGENCY_CO2_PPM } = require('../services/lib/telemetry');

function telemetry(zone, temp, co2, occupancy, secondsAgo = 0) {
  return {
    zone,
    time: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    temp_celsius: temp,
    humidity: 50,
    co2_ppm: co2,
    occupancy
  };
}

describe('AI agent - hard safety limits (NFR3)', () => {
  test('never suggests a target below 18C even for extreme heat', () => {
    const d = decide({
      zone: 'meeting-room',
      telemetry: [telemetry('meeting-room', 45, 1900, true)],
      job: { type: 'minute', zone: 'meeting-room' },
      nowIso: new Date().toISOString()
    });
    expect(d.target_temp).toBeGreaterThanOrEqual(HARD_TEMP_MIN);
    expect(d.target_temp).toBeLessThanOrEqual(HARD_TEMP_MAX);
  });

  test('never suggests a target above 26C even for extreme cold', () => {
    const d = decide({
      zone: 'east-office',
      telemetry: [telemetry('east-office', 5, 400, true)],
      job: { type: 'minute', zone: 'east-office' },
      nowIso: new Date().toISOString()
    });
    expect(d.target_temp).toBeGreaterThanOrEqual(HARD_TEMP_MIN);
    expect(d.target_temp).toBeLessThanOrEqual(HARD_TEMP_MAX);
  });

  test('fan speed is always inside 0..100', () => {
    for (const co2 of [300, 500, 800, 1200, 3000, 5000]) {
      const d = decide({
        zone: 'west-office',
        telemetry: [telemetry('west-office', 30, co2, true)],
        job: { type: 'minute', zone: 'west-office' },
        nowIso: new Date().toISOString()
      });
      expect(d.target_fan_speed).toBeGreaterThanOrEqual(0);
      expect(d.target_fan_speed).toBeLessThanOrEqual(100);
    }
  });

  test('decisions record the model engine version', () => {
    const d = decide({
      zone: 'east-office',
      telemetry: [telemetry('east-office', 24, 450, false)],
      job: { type: 'minute', zone: 'east-office' },
      nowIso: new Date().toISOString()
    });
    expect(d.model).toMatch(/^ai-agent-nn/);
    expect(d.source).toMatch(/^ai-agent-nn/);
  });
});

describe('AI agent - learned policy invariants', () => {
  test('empty cool room targets energy-saving warmth, not aggressive cooling', () => {
    const d = decide({
      zone: 'east-office',
      telemetry: [telemetry('east-office', 23, 450, false)],
      job: { type: 'minute', zone: 'east-office' },
      nowIso: new Date().toISOString()
    });
    expect(d.target_temp).toBeGreaterThanOrEqual(24.5); // near/above neutral 26 C
    expect(d.target_fan_speed).toBeLessThanOrEqual(40); // minimal ventilation
    expect(d.reasoning).toContain('energy-saving');
  });

  test('occupied hot + stuffy room gets far more cooling than an empty mild one', () => {
    const hot = decide({
      zone: 'meeting-room',
      telemetry: [telemetry('meeting-room', 31, 950, true)],
      job: { type: 'minute', zone: 'meeting-room' },
      nowIso: new Date().toISOString()
    });
    const mild = decide({
      zone: 'east-office',
      telemetry: [telemetry('east-office', 23, 450, false)],
      job: { type: 'minute', zone: 'east-office' },
      nowIso: new Date().toISOString()
    });
    expect(hot.target_temp).toBeLessThanOrEqual(mild.target_temp - 2); // colder target
    expect(hot.target_fan_speed).toBeGreaterThanOrEqual(mild.target_fan_speed + 30); // much more airflow
    expect(hot.reasoning).toContain('comfort target');
  });

  test('fan ramps up as CO2 rises in an occupied room', () => {
    const low = decide({
      zone: 'west-office',
      telemetry: [telemetry('west-office', 24, 500, true)],
      job: { type: 'minute', zone: 'west-office' },
      nowIso: new Date().toISOString()
    });
    const high = decide({
      zone: 'west-office',
      telemetry: [telemetry('west-office', 24, 950, true)],
      job: { type: 'minute', zone: 'west-office' },
      nowIso: new Date().toISOString()
    });
    expect(high.target_fan_speed).toBeGreaterThanOrEqual(low.target_fan_speed + 20);
  });
});

describe('AI agent - CO2 emergency guardrail', () => {
  test('emergency job forces fan to 100 and 22C', () => {
    const d = decide({
      zone: 'meeting-room',
      telemetry: [telemetry('meeting-room', 25, 1450, true)],
      job: { type: 'emergency', zone: 'meeting-room' },
      nowIso: new Date().toISOString()
    });
    expect(d.emergency).toBe(true);
    expect(d.target_fan_speed).toBe(100);
    expect(d.target_temp).toBe(22);
    expect(d.reasoning).toContain('emergency');
  });

  test('emergency is detected from telemetry alone even on a minute job', () => {
    const d = decide({
      zone: 'meeting-room',
      telemetry: [telemetry('meeting-room', 25, 1100, true)],
      job: { type: 'minute', zone: 'meeting-room' },
      nowIso: new Date().toISOString()
    });
    expect(d.emergency).toBe(true);
    expect(d.target_fan_speed).toBe(100);
    expect(d.target_temp).toBe(22);
  });

  test('emergency reasoning reports the real worst reading', () => {
    const d = decide({
      zone: 'meeting-room',
      telemetry: [
        telemetry('meeting-room', 25, 1180, true),
        telemetry('meeting-room', 25, 950, true, 5),
        telemetry('meeting-room', 25, 800, true, 10)
      ],
      job: { type: 'minute', zone: 'meeting-room' },
      nowIso: new Date().toISOString()
    });
    expect(d.emergency).toBe(true);
    expect(d.co2_ppm).toBeGreaterThanOrEqual(EMERGENCY_CO2_PPM);
    expect(d.reasoning).toContain(String(d.co2_ppm));
  });
});

describe('AI agent - no-change suppression', () => {
  test('returns null when the actuator already matches and there is no emergency', () => {
    const first = decide({
      zone: 'east-office',
      telemetry: [telemetry('east-office', 23, 450, false)],
      job: { type: 'minute', zone: 'east-office' },
      nowIso: new Date().toISOString()
    });
    const actuator = { zone: 'east-office', target_temp: first.target_temp, fan_speed: first.target_fan_speed };
    const d = decide({
      zone: 'east-office',
      telemetry: [telemetry('east-office', 23, 450, false)],
      actuator,
      job: { type: 'minute', zone: 'east-office' },
      nowIso: new Date().toISOString()
    });
    expect(d).toBeNull();
  });

  test('an emergency job still re-applies fan 100 even if the actuator matches', () => {
    const actuator = { zone: 'meeting-room', target_temp: 22, fan_speed: 100 };
    const d = decide({
      zone: 'meeting-room',
      telemetry: [telemetry('meeting-room', 25, 1600, true)],
      actuator,
      job: { type: 'emergency', zone: 'meeting-room' },
      nowIso: new Date().toISOString()
    });
    expect(d).not.toBeNull();
    expect(d.target_fan_speed).toBe(100);
  });
});
