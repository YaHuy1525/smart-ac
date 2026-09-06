'use strict';

/**
 * Tiny neural-network policy model (Week 5 - AI agent).
 *
 * The model is a fully-connected MLP: 7 zone-state features -> [setpoint, fan].
 * It is trained OFFLINE by scripts in services/ai-agent/train/train_model.js
 * using behavioural cloning from an MPC-style expert that minimises a
 * comfort + IAQ + energy cost over simulated room dynamics (the same physics
 * the Node-RED edge gateway runs). The weights live in
 * src/model/model.json (committed so the container never needs to train).
 *
 * Architecture: 7 -> 28 (tanh) -> 20 (tanh) -> 2 (sigmoid)
 *   output 0: setpoint in [18, 26] C   (NFR3 envelope)
 *   output 1: fan speed in [0, 100] %
 *
 * predict() is a pure forward pass - microseconds per decision, which keeps
 * the NFR2 cloud-loop latency budget (< 2 s) trivially satisfied.
 */

const fs = require('fs');
const path = require('path');

const MODEL_PATH = process.env.AI_MODEL_PATH || path.join(__dirname, 'model', 'model.json');

let model = null;

function loadModel() {
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error('model file not found at ' + MODEL_PATH + ' - run: node services/ai-agent/train/train_model.js');
  }
  const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  const expected = [m.meta.layers[0]];
  let total = 0;
  for (let i = 1; i < m.meta.layers.length; i++) {
    expected.push(m.meta.layers[i]);
    total += m.meta.layers[i - 1] * m.meta.layers[i] + m.meta.layers[i];
  }
  const flat = m.weights;
  if (!Array.isArray(flat) || flat.length !== total) {
    throw new Error('model weight count mismatch: expected ' + total + ' got ' + (flat || []).length);
  }
  let cursor = 0;
  const layers = [];
  for (let i = 1; i < m.meta.layers.length; i++) {
    const rows = m.meta.layers[i - 1];
    const cols = m.meta.layers[i];
    const w = new Float64Array(rows * cols);
    const b = new Float64Array(cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        w[r * cols + c] = flat[cursor++];
      }
    }
    for (let c = 0; c < cols; c++) {
      b[c] = flat[cursor++];
    }
    layers.push({ w, b });
  }
  m._layers = layers;
  model = m;
  return m;
}

/** Raw forward pass on pre-normalised inputs; returns normalised outputs in [0,1]. */
function forward(x) {
  const m = model || loadModel();
  let v = new Float64Array(x);
  for (let i = 0; i < m._layers.length; i++) {
    const { w, b } = m._layers[i];
    const cols = b.length;
    const next = new Float64Array(cols);
    for (let c = 0; c < cols; c++) {
      let acc = b[c];
      for (let r = 0; r < v.length; r++) {
        acc += v[r] * w[r * cols + c];
      }
      if (i < m._layers.length - 1) {
        // tanh activation on hidden layers
        const e = Math.exp(-2 * acc);
        next[c] = (1 - e) / (1 + e);
      } else {
        // sigmoid on the output layer (bounded actions)
        next[c] = 1 / (1 + Math.exp(-acc));
      }
    }
    v = next;
  }
  return v;
}

/**
 * Predict the optimal (setpoint, fan) for a zone state.
 * @param {number[]} features raw features, ORDER MUST MATCH model.json meta.features:
 *   [occupancy(0/1), temp_c, co2_ppm, co2_trend_ppm_per_min, current_setpoint_c,
 *    current_fan_pct, temp_minus_setpoint_c]
 * @returns {{setpoint:number, fan:number}}
 */
function predict(features) {
  const m = model || loadModel();
  const s = m.meta.featureScale;
  const raw = [
    features[0], // occupancy already 0/1
    (features[1] - s.tempOffset) / s.tempScale,
    (features[2] - s.co2Offset) / s.co2Scale,
    features[3] / s.trendScale,
    (features[4] - s.spOffset) / s.spScale,
    features[5] / 100,
    (features[6] - s.errOffset) / s.errScale
  ];
  const out = forward(raw);
  const tempMin = m.meta.outScale.tempMin;
  const tempMax = m.meta.outScale.tempMax;
  const fanMax = m.meta.outScale.fanMax;
  return {
    setpoint: tempMin + out[0] * (tempMax - tempMin),
    fan: out[1] * fanMax
  };
}

/** Metadata about the loaded model (for /stats and boot logs). */
function modelInfo() {
  const m = model || loadModel();
  return {
    engine: m.meta.engine,
    trainedAt: m.meta.trainedAt,
    seed: m.meta.seed,
    epochs: m.meta.epochs,
    layers: m.meta.layers,
    valMetrics: m.meta.valMetrics || {},
    samples: m.meta.samples
  };
}

module.exports = { loadModel, predict, modelInfo, MODEL_PATH };
