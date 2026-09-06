'use strict';

/**
 * Native (no-Docker) developer stack runner - same services, no containers.
 *
 *   node scripts/dev_stack.js            # queue, broker, ingestion, ai-agent, actuator
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

const children = [];
let shuttingDown = false;

function prefixLines(child, name, streamName) {
  child[streamName].on('data', (buf) => {
    const text = buf.toString().replace(/\n$/, '');
    for (const line of text.split('\n')) {
      console.log(`[${name}] ${line}`);
    }
  });
}

for (const svc of SERVICES) {
  const env = {
    ...process.env,
    PORT: String(svc.port),
    QUEUE_URL: 'http://127.0.0.1:3100',
    MQTT_URL: 'mqtt://127.0.0.1:1883',
    DATA_DIR: path.join(ROOT, '.data', svc.name),
    ...(svc.extra || {})
  };
  const child = spawn(process.execPath, ['src/server.js'], {
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

for (const child of children) {
  child.on('error', (err) => {
    console.error('[dev-stack] failed to start a service:', err.message);
    process.exit(1);
  });
}

process.on('SIGINT', () => {
  shuttingDown = true;
  console.log('\n[dev-stack] stopping all services...');
  for (const child of children) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 1500);
});
