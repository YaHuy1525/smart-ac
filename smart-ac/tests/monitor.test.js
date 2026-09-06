'use strict';

/**
 * Unit tests for the AI agent's monitoring skill (src/monitor.js): the agent
 * watches every zone and its AC unit and flags stuck sensors, missing
 * telemetry, CO2 stress and unresponsive actuation.
 */

const { runDetectors, LIMITS } = require('../services/ai-agent/src/monitor');

function telemetry(zone, temp, co2, occupancy, secondsAgo = 0) {
  return {
    zone,
    time: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    temp_celsius: temp,
    co2_ppm: co2,
    occupancy
  };
}

function minutes(avgCo2Newest, avgCo2Prev) {
  return [
    { zone: 'x', minute: 'm1', avg_co2_ppm: avgCo2Newest },
    { zone: 'x', minute: 'm0', avg_co2_ppm: avgCo2Prev }
  ];
}

function codes(issues) {
  return issues.map((i) => i.code).sort();
}

describe('monitor - healthy zone reports no issues', () => {
  test('fresh varied telemetry + recent setpoint is clean', () => {
    const issues = runDetectors({
      zone: 'east-office',
      telemetry: [
        telemetry('east-office', 24.1, 601, true),
        telemetry('east-office', 24.05, 598, true, 5),
        telemetry('east-office', 24.2, 595, true, 10),
        telemetry('east-office', 24.0, 590, true, 15),
        telemetry('east-office', 23.9, 588, true, 20),
        telemetry('east-office', 24.1, 585, true, 25),
        telemetry('east-office', 24.15, 582, true, 30)
      ],
      minutes: minutes(600, 590),
      actuator: { time: new Date(Date.now() - 60 * 1000).toISOString(), target_temp: 24, fan_speed: 30 },
      nowIso: new Date().toISOString()
    });
    expect(issues).toEqual([]);
  });
});

describe('monitor - stuck / silent sensors', () => {
  test('NO_TELEMETRY when the zone stopped reporting', () => {
    const issues = runDetectors({
      zone: 'west-office',
      telemetry: [telemetry('west-office', 24, 600, true, LIMITS.noTelemetryAfterSec + 30)],
      minutes: [],
      actuator: null,
      nowIso: new Date().toISOString()
    });
    expect(codes(issues)).toContain('NO_TELEMETRY');
  });

  test('FLAT_SENSOR when temperature and CO2 are frozen over many readings', () => {
    const flat = [];
    for (let i = 0; i < LIMITS.flatMinRecords; i++) {
      flat.push(telemetry('east-office', 24.0, 612, true, i * 5));
    }
    const issues = runDetectors({
      zone: 'east-office',
      telemetry: flat,
      minutes: minutes(610, 610),
      actuator: { time: new Date(Date.now() - 60 * 1000).toISOString(), target_temp: 24, fan_speed: 30 },
      nowIso: new Date().toISOString()
    });
    expect(codes(issues)).toContain('FLAT_SENSOR');
  });
});

describe('monitor - CO2 stress', () => {
  test('CO2_RISING when CO2 is high and climbing fast', () => {
    const issues = runDetectors({
      zone: 'meeting-room',
      telemetry: [telemetry('meeting-room', 24, 940, true)],
      minutes: minutes(940, 850), // +90 ppm/min
      actuator: { time: new Date(Date.now() - 30 * 1000).toISOString(), target_temp: 23, fan_speed: 40 },
      nowIso: new Date().toISOString()
    });
    expect(codes(issues)).toContain('CO2_RISING');
  });

  test('CO2_HIGH alert when unhandled CO2 reaches the cloud', () => {
    const issues = runDetectors({
      zone: 'meeting-room',
      telemetry: [telemetry('meeting-room', 25, 1400, true)],
      minutes: minutes(1400, 900),
      actuator: { time: new Date(Date.now() - 30 * 1000).toISOString(), target_temp: 23, fan_speed: 60 },
      nowIso: new Date().toISOString()
    });
    const flagged = issues.find((i) => i.code === 'CO2_HIGH');
    expect(flagged).toBeTruthy();
    expect(flagged.severity).toBe('alert');
  });
});

describe('monitor - AC unit health', () => {
  test('SETPOINT_UNREACHED when the room never approaches the long-applied target', () => {
    const issues = runDetectors({
      zone: 'west-office',
      telemetry: [telemetry('west-office', 29.5, 700, true)],
      minutes: minutes(700, 690),
      actuator: {
        time: new Date(Date.now() - LIMITS.setpointAgeSec * 1000 - 60 * 1000).toISOString(),
        target_temp: 23,
        fan_speed: 100
      },
      nowIso: new Date().toISOString()
    });
    expect(codes(issues)).toContain('SETPOINT_UNREACHED');
  });

  test('ACTUATOR_STALE when no cloud command arrived for a long time', () => {
    const issues = runDetectors({
      zone: 'east-office',
      telemetry: [telemetry('east-office', 24, 600, true, 10)],
      minutes: minutes(600, 600),
      actuator: { time: new Date(Date.now() - (LIMITS.staleActuatorSec + 60) * 1000).toISOString(), target_temp: 24, fan_speed: 30 },
      nowIso: new Date().toISOString()
    });
    expect(codes(issues)).toContain('ACTUATOR_STALE');
  });
});
