'use strict';

/**
 * Storage layer used by the cloud microservices.
 *
 * Two interchangeable backends implement the same small API:
 *   - 'file' : JSON-file store under DATA_DIR. Used for native (no-Docker) runs.
 *   - 'mongo': MongoDB collections via the official driver. Used in the Week 7
 *              containerised stack (mirrors MongoDB Atlas from the plan).
 *
 * Collections (Mongo) / files (file store):
 *   telemetry          raw clean telemetry records (plan schema #1)
 *   telemetry_minutes  per-zone per-minute aggregates
 *   ai_decisions       AI agent decision records (plan schema #2)
 *   actuator_state     latest applied setpoint per zone
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const { createLogger } = require('./logger');
const log = createLogger('store');

/* ------------------------------------------------------------------ */
/* File backend                                                        */
/* ------------------------------------------------------------------ */

class FileStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.tables = {
      telemetry: [],
      telemetry_minutes: [],
      ai_decisions: [],
      actuator_state: []
    };
    this.load();
    // Background flush so a crash loses at most a few seconds of writes.
    this.flushTimer = setInterval(() => this.flush(), 5000);
    this.flushTimer.unref();
  }

  load() {
    for (const name of Object.keys(this.tables)) {
      const file = path.join(this.dir, name + '.json');
      try {
        if (fs.existsSync(file)) {
          this.tables[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
      } catch (err) {
        log.error('failed to load table ' + name, { error: err.message });
      }
    }
  }

  async flush() {
    for (const name of Object.keys(this.tables)) {
      const file = path.join(this.dir, name + '.json.tmp');
      const finalFile = path.join(this.dir, name + '.json');
      try {
        fs.writeFileSync(file, JSON.stringify(this.tables[name]));
        fs.renameSync(file, finalFile);
      } catch (err) {
        log.error('failed to flush table ' + name, { error: err.message });
      }
    }
  }

  async insertTelemetry(rec) {
    this.tables.telemetry.push(rec);
    return rec;
  }

  async findLatestTelemetry(zone, limit) {
    return this.tables.telemetry
      .filter((r) => r.zone === zone)
      .sort((a, b) => (a.time < b.time ? 1 : -1))
      .slice(0, limit || 20);
  }

  async upsertMinute(zone, key, agg) {
    const list = this.tables.telemetry_minutes;
    const idx = list.findIndex((m) => m.zone === zone && m.minute === key);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...agg };
    } else {
      list.push({ zone, minute: key, ...agg });
    }
    return this.tables.telemetry_minutes;
  }

  async findMinutes(zone, limit) {
    return this.tables.telemetry_minutes
      .filter((m) => m.zone === zone)
      .sort((a, b) => (a.minute < b.minute ? 1 : -1))
      .slice(0, limit || 30);
  }

  async insertDecision(doc) {
    this.tables.ai_decisions.push(doc);
    return doc;
  }

  async findDecisions(zone, limit) {
    return this.tables.ai_decisions
      .filter((d) => d.zone === zone)
      .sort((a, b) => (a.time < b.time ? 1 : -1))
      .slice(0, limit || 10);
  }

  async upsertActuator(zone, state) {
    const list = this.tables.actuator_state;
    const idx = list.findIndex((s) => s.zone === zone);
    if (idx >= 0) {
      list[idx] = { zone, ...state };
    } else {
      list.push({ zone, ...state });
    }
    return this.tables.actuator_state;
  }

  async getActuator(zone) {
    return this.tables.actuator_state.find((s) => s.zone === zone) || null;
  }

  async counts() {
    const out = {};
    for (const name of Object.keys(this.tables)) {
      out[name] = this.tables[name].length;
    }
    return out;
  }

  async close() {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}

/* ------------------------------------------------------------------ */
/* MongoDB backend                                                     */
/* ------------------------------------------------------------------ */

class MongoStore {
  constructor(uri) {
    this.uri = uri;
    this.dbName = process.env.MONGO_DB || 'smart_ac';
    // Resolve 'mongodb' from the RUNNING SERVICE directory (which declares the
    // dependency in its own package.json) - not from this shared lib folder.
    this.serviceRequire = createRequire(path.join(process.cwd(), 'package.json'));
  }

  async connect(retries = 40, delayMs = 2000) {
    const { MongoClient } = this.serviceRequire('mongodb');
    let lastErr;
    for (let i = 1; i <= retries; i++) {
      try {
        this.client = new MongoClient(this.uri, {
          serverSelectionTimeoutMS: 2000,
          connectTimeoutMS: 2000
        });
        await this.client.connect();
        this.db = this.client.db(this.dbName);
        await this.ensureIndexes();
        log.info('connected to MongoDB at ' + this.uri);
        return;
      } catch (err) {
        lastErr = err;
        log.warn('MongoDB not ready (attempt ' + i + '/' + retries + ')', { error: err.message });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  async ensureIndexes() {
    await Promise.all([
      this.db.collection('telemetry').createIndex({ zone: 1, time: -1 }), // plan: index zone+time
      this.db.collection('telemetry_minutes').createIndex({ zone: 1, minute: -1 }),
      this.db.collection('ai_decisions').createIndex({ zone: 1, time: -1 }),
      this.db.collection('actuator_state').createIndex({ zone: 1 }, { unique: true })
    ]);
  }

  async insertTelemetry(rec) {
    await this.db.collection('telemetry').insertOne(rec);
    return rec;
  }

  async findLatestTelemetry(zone, limit) {
    return this.db
      .collection('telemetry')
      .find({ zone })
      .sort({ time: -1 })
      .limit(limit || 20)
      .toArray();
  }

  async upsertMinute(zone, key, agg) {
    const doc = { zone, minute: key, ...agg };
    await this.db.collection('telemetry_minutes').updateOne(
      { zone, minute: key },
      { $set: agg },
      { upsert: true }
    );
    return doc;
  }

  async findMinutes(zone, limit) {
    return this.db
      .collection('telemetry_minutes')
      .find({ zone })
      .sort({ minute: -1 })
      .limit(limit || 30)
      .toArray();
  }

  async insertDecision(doc) {
    await this.db.collection('ai_decisions').insertOne(doc);
    return doc;
  }

  async findDecisions(zone, limit) {
    return this.db
      .collection('ai_decisions')
      .find({ zone })
      .sort({ time: -1 })
      .limit(limit || 10)
      .toArray();
  }

  async upsertActuator(zone, state) {
    await this.db.collection('actuator_state').updateOne({ zone }, { $set: state }, { upsert: true });
    return state;
  }

  async getActuator(zone) {
    return this.db.collection('actuator_state').findOne({ zone });
  }

  async counts() {
    const out = {};
    for (const name of ['telemetry', 'telemetry_minutes', 'ai_decisions', 'actuator_state']) {
      out[name] = await this.db.collection(name).estimatedDocumentCount();
    }
    return out;
  }

  async close() {
    if (this.client) {
      await this.client.close();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

async function connectStore() {
  const mongoUri = process.env.MONGO_URI;
  if (mongoUri) {
    const store = new MongoStore(mongoUri);
    await store.connect();
    return store;
  }
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const store = new FileStore(dir);
  log.info('file store enabled at ' + dir + ' (set MONGO_URI to use MongoDB)');
  return store;
}

function randomId(prefix) {
  return prefix + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = { connectStore, randomId };
