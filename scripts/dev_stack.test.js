'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const {
  SERVICES,
  parseOnlySelection,
  selectServices,
  startStack
} = require('./dev_stack');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kill = jest.fn();
  }
}

function startWithFakeSpawn(argv) {
  const spawned = [];
  const spawnMock = jest.fn((command, args, options) => {
    const child = new FakeChild(spawned.length + 1);
    spawned.push({ command, args, options, child });
    return child;
  });
  const stack = startStack(argv, {
    spawn: spawnMock,
    registerSignalHandlers: false
  });
  return { spawned, spawnMock, stack };
}

describe('native dev runner --only selection', () => {
  test('parses repeated, comma-separated, and space-separated selections', () => {
    expect(parseOnlySelection([])).toEqual([]);
    expect(parseOnlySelection(['--only', 'queue,broker', '--only', ' ai-agent,queue'])).toEqual([
      'queue',
      'broker',
      'ai-agent'
    ]);
    expect(parseOnlySelection(['--only', 'ingestion', 'actuator', '--only=broker'])).toEqual([
      'ingestion',
      'actuator',
      'broker'
    ]);
  });

  test('retains the canonical service order for selected services', () => {
    expect(selectServices(['actuator', 'queue', 'broker']).map((svc) => svc.name)).toEqual([
      'queue',
      'broker',
      'actuator'
    ]);
  });

  test('rejects missing, empty, and unknown selections', () => {
    expect(() => parseOnlySelection(['--only'])).toThrow(/requires at least one service name/);
    expect(() => parseOnlySelection(['--only', '--help'])).toThrow(/requires at least one service name/);
    expect(() => parseOnlySelection(['--only='])).toThrow(/requires at least one service name/);
    expect(() => parseOnlySelection(['--only', 'worker'])).toThrow(/Unknown service "worker"/);
  });

  test('starts the full native stack when --only is absent', () => {
    const allNames = SERVICES.map((svc) => svc.name);
    const { spawned, spawnMock, stack } = startWithFakeSpawn([]);

    expect(stack.only).toEqual([]);
    expect(stack.services.map((svc) => svc.name)).toEqual(allNames);
    expect(spawnMock).toHaveBeenCalledTimes(allNames.length);
    expect(spawned.map(({ options }) => path.basename(options.cwd))).toEqual(allNames);
    for (const { command, args, options } of spawned) {
      expect(command).toBe(process.execPath);
      expect(args).toEqual(['src/server.js']);
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    }
  });

  test('spawns only the requested services with the existing environment', () => {
    const { spawned, stack } = startWithFakeSpawn(['--only', 'actuator, broker']);

    expect(stack.only).toEqual(['actuator', 'broker']);
    expect(stack.services.map((svc) => svc.name)).toEqual(['broker', 'actuator']);
    expect(spawned.map(({ options }) => path.basename(options.cwd))).toEqual(['broker', 'actuator']);
    expect(spawned[0].options.env).toMatchObject({
      PORT: '31883',
      QUEUE_URL: 'http://127.0.0.1:3100',
      MQTT_URL: 'mqtt://127.0.0.1:1883',
      DATA_DIR: path.join(__dirname, '..', '.data', 'broker'),
      MQTT_PORT: '1883',
      METRICS_PORT: '31883'
    });
    expect(spawned[1].options.env).toMatchObject({
      PORT: '3140',
      QUEUE_URL: 'http://127.0.0.1:3100',
      MQTT_URL: 'mqtt://127.0.0.1:1883',
      DATA_DIR: path.join(__dirname, '..', '.data', 'actuator')
    });
  });

  test('validates the complete selection before spawning any service', () => {
    const spawned = [];
    const spawnMock = jest.fn((command, args, options) => {
      const child = new FakeChild(spawned.length + 1);
      spawned.push({ command, args, options, child });
      return child;
    });

    expect(() => {
      startStack(['--only', 'queue,worker'], {
        spawn: spawnMock,
        registerSignalHandlers: false
      });
    }).toThrow(/Unknown service "worker"/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(0);
  });
});
