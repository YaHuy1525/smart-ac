'use strict';

/**
 * Tiny JSON-line logger shared by every microservice.
 * Every line is timestamped so docker-compose logs can be used as evidence.
 */
function ts() {
  return new Date().toISOString();
}

function write(level, service, msg, meta) {
  const line = {
    ts: ts(),
    level,
    service,
    msg,
    ...(meta ? { meta } : {})
  };
  let out = line.ts + ' ' + level.toUpperCase().padEnd(5) + ' [' + service + '] ' + msg;
  if (meta) {
    try {
      out += ' ' + JSON.stringify(meta);
    } catch (_) {
      out += ' ' + String(meta);
    }
  }
  if (level === 'error') {
    console.error(out);
  } else {
    console.log(out);
  }
}

function createLogger(service) {
  return {
    debug: (msg, meta) => write('debug', service, msg, meta),
    info: (msg, meta) => write('info', service, msg, meta),
    warn: (msg, meta) => write('warn', service, msg, meta),
    error: (msg, meta) => write('error', service, msg, meta)
  };
}

module.exports = { createLogger };
