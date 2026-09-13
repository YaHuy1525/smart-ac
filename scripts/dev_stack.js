'use strict';

/**
 * Native (no-Docker) developer stack runner - same services, no containers.
 *
 *   node scripts/dev_stack.js                  # queue, broker, ingestion, ai-agent, actuator
 *   node scripts/dev_stack.js --only queue,broker
 *   node scripts/dev_stack.js --only queue --only ingestion
 *
 * Service names may also be separated by spaces. Selections are validated
 * against the service list below before any child process is spawned.
 *
 * Services use the file-backed store (MongoDB is only required in the
 * containerised Week 7 stack) and connect to each other on localhost.
 * The Node-RED edge gateway still runs best as a container (see README):
 *   docker compose up -d nodered
 * (set BROKER_HOST=127.0.0.1 in edge/build_flow.js + regenerate if running
 * Node-RED natively).
 *
 * Press Ctrl+C to stop everything.
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SERVICES = [
  { name: 'queue', dir: 'services/queue', port: 3100 },
  { name: 'broker', dir: 'services/broker', port: 31883, extra: { MQTT_PORT: '1883', METRICS_PORT: '31883' } },
  { name: 'ingestion', dir: 'services/ingestion', port: 3120 },
  { name: 'ai-agent', dir: 'services/ai-agent', port: 3130 },
  { name: 'actuator', dir: 'services/actuator', port: 3140 }
];

const SERVICE_NAMES = new Set(SERVICES.map((svc) => svc.name));
const SERVICE_LIST = SERVICES.map((svc) => svc.name).join(', ');

function appendOnlyNames(value, selected) {
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error('--only requires at least one service name');
  }

  for (const name of names) {
    if (!SERVICE_NAMES.has(name)) {
      throw new Error(`Unknown service "${name}" for --only. Expected one of: ${SERVICE_LIST}.`);
    }
    if (!selected.includes(name)) {
      selected.push(name);
    }
  }
}

function parseOnlySelection(argv = process.argv.slice(2)) {
  const selected = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--only') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error('--only requires at least one service name');
      }

      i += 1;
      while (i < argv.length && !argv[i].startsWith('--')) {
        appendOnlyNames(argv[i], selected);
        i += 1;
      }
      i -= 1;
      continue;
    }

    if (arg.startsWith('--only=')) {
      appendOnlyNames(arg.slice('--only='.length), selected);
    }
  }

  return selected;
}

function selectServices(only) {
  if (only.length === 0) {
    return SERVICES;
  }

  for (const name of only) {
    if (!SERVICE_NAMES.has(name)) {
      throw new Error(`Unknown service "${name}". Expected one of: ${SERVICE_LIST}.`);
    }
  }

  const requested = new Set(only);
  return SERVICES.filter((svc) => requested.has(svc.name));
}

function prefixLines(child, name, streamName) {
  child[streamName].on('data', (buf) => {
    const text = buf.toString().replace(/\n$/, '');
    for (const line of text.split('\n')) {
      console.log(`[${name}] ${line}`);
    }
  });
}

function startStack(argv = process.argv.slice(2), options = {}) {
  const spawnService = options.spawn || spawn;
  const registerSignalHandlers = options.registerSignalHandlers !== false;
  const only = parseOnlySelection(argv);
  const servicesToStart = selectServices(only);
  const children = [];
  let shuttingDown = false;

  for (const svc of servicesToStart) {
    const env = {
      ...process.env,
      PORT: String(svc.port),
      QUEUE_URL: 'http://127.0.0.1:3100',
      MQTT_URL: 'mqtt://127.0.0.1:1883',
      DATA_DIR: path.join(ROOT, '.data', svc.name),
      ...(svc.extra || {})
    };
    const child = spawnService(process.execPath, ['src/server.js'], {
      cwd: path.join(ROOT, svc.dir),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    prefixLines(child, svc.name, 'stdout');
    prefixLines(child, svc.name, 'stderr');
    child.on('exit', (code) => {
      if (!shuttingDown) {
        console.log(`[${svc.name}] exited with code ${code}`);
      }
    });
    children.push(child);
    console.log(`[dev-stack] starting ${svc.name} (pid ${child.pid})...`);
  }

  console.log(
    '\n[dev-stack] native stack starting (file-backed store in ./.data).\n' +
      '  queue      :3100  broker mqtt :1883 / metrics :31883\n' +
      '  ingestion  :3120  ai-agent :3130  actuator :3140\n' +
      '  NOTE: run the Node-RED edge gateway via `docker compose up -d nodered`.\n' +
      '  Ctrl+C stops all services.\n'
  );

  if (only.length > 0) {
    console.log(`[dev-stack] --only selection: ${only.join(', ')}\n`);
  }

  for (const child of children) {
    child.on('error', (err) => {
      console.error('[dev-stack] failed to start a service:', err.message);
      process.exit(1);
    });
  }

  function shutdown() {
    shuttingDown = true;
    console.log('\n[dev-stack] stopping all services...');
    for (const child of children) {
      child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 1500);
  }

  if (registerSignalHandlers) {
    process.on('SIGINT', shutdown);
  }

  return { services: servicesToStart, only, children, shutdown };
}

function main() {
  try {
    startStack();
  } catch (err) {
    console.error(
      `[dev-stack] ${err.message}\n` +
        'Usage: node scripts/dev_stack.js [--only <service>[,<service>...] ...]\n' +
        `Services: ${SERVICE_LIST}`
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SERVICES,
  parseOnlySelection,
  selectServices,
  startStack,
  main
};
