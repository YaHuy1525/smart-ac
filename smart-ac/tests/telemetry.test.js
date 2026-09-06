'use strict';

/**
 * Unit tests for the shared telemetry validator used by the ingestion service.
 */

const { validateTelemetry, minuteKey } = require('../services/lib/telemetry');

function validPayload(overrides) {
  return {
    zone: 'east-office',
    time: '2026-07-26T02:45:00Z',
    temp_celsius: 24.5,
    humidity: 52.0,
    co2_ppm: 850,
    occupancy: true,
    ...overrides
  };
}

describe('telemetry validator', () => {
  test('accepts a well-formed record and normalises fields', () => {
    const v = validateTelemetry(validPayload());
    expect(v.ok).toBe(true);
    expect(v.record.zone).toBe('east-office');
    expect(typeof v.record.temp_celsius).toBe('number');
  });

  test('rejects missing zone', () => {
    const v = validateTelemetry(validPayload({ zone: undefined }));
    expect(v.ok).toBe(false);
  });

  test('rejects invalid time', () => {
    const v = validateTelemetry(validPayload({ time: 'not-a-date' }));
    expect(v.ok).toBe(false);
  });

  test('rejects CO2 out of physical range', () => {
    const v = validateTelemetry(validPayload({ co2_ppm: 99999 }));
    expect(v.ok).toBe(false);
  });

  test('rejects non-boolean occupancy', () => {
    const v = validateTelemetry(validPayload({ occupancy: 'yes' }));
    expect(v.ok).toBe(false);
  });

  test('rejects non-object payload', () => {
    expect(validateTelemetry(null).ok).toBe(false);
    expect(validateTelemetry('nope').ok).toBe(false);
  });

  test('minuteKey truncates an ISO timestamp to the minute', () => {
    expect(minuteKey('2026-07-26T02:45:59.123Z')).toBe('2026-07-26T02:45');
  });
});
