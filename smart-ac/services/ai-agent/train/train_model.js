'use strict';

/**
 * Offline training pipeline for the AC-control neural network (Week 5).
 *
 *   node services/ai-agent/train/train_model.js [--epochs 80] [--episodes 150] [--seed 42]
 *
 * The network learns to control the AC by behavioural cloning of an
 * "expert" controller:
 *
 *   1. SIMULATE rooms with the same physics the Node-RED edge gateway runs
 *      (temperature relaxes toward the setpoint with a ~50 s time constant +
 *      occupant heat; CO2 approaches an occupancy-driven equilibrium and the
 *      fan speed lowers that equilibrium - ventilation). Three room profiles
 *      mirror the deployed zones: the 12-person meeting room (CO2 storms past
 *      1000 ppm), the 2-person east office (comfort only) and the 6-person
 *      ventilated west office (IAQ control without emergencies).
 *   2. Each simulated minute the EXPERT replans: holding the current occupancy
 *      fixed it rolls the room forward 6 minutes for every candidate
 *      (setpoint, fan) and keeps the action that minimises a cost of thermal
 *      comfort + IAQ (CO2) + cooling/fan energy (receding-horizon control over
 *      the building model). Using current (not future) occupancy makes the
 *      expert's label a deterministic function of the observed state, which is
 *      what makes the imitation learnable. States where CO2 >= 1000 ppm are
 *      labelled with the plan's emergency action (22 C / fan 100) so the
 *      learned policy matches the deployed guardrail.
 *   3. The neural network (7 -> 24 -> 16 -> 2 MLP, src/nn.js) is trained with
 *      Adam on normalised inputs to imitate the expert's crisp (argmin)
 *      action: state -> (setpoint, fan).
 *   4. Evaluation on held-out episodes reports regression error vs the expert
 *      and the relative cost gap (how much worse the learned policy is than
 *      the expert on the same states).
 *
 * Output: services/ai-agent/src/model/model.json (committed; loaded by the
 * ai-agent service at boot - training itself never runs in the container).
 *
 * Fully deterministic when given the same seed (mulberry32 PRNG).
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* Seeded randomness (deterministic training)                          */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Building physics (mirrors the Node-RED edge flow)                   */
/* ------------------------------------------------------------------ */

const TICK_DT = 10; // simulation step, seconds
const EQ_RATE = 0.02; // 1/s temperature & CO2 exchange rate (flows.json EQ_RATE)
const VENT_MAX = 0.25; // fan 100 % lowers the CO2 equilibrium by 25 %
const HEAT_PER_PPL = 0.006; // C/s occupant heat gain (flows.json)
const EQ_FLOOR = 420; // ppm outdoor/ambient CO2 (flows.json)

function co2Equilibrium(ppl, eqPerPpl, fanPct) {
  const vent = 1 - VENT_MAX * Math.min(100, Math.max(0, fanPct)) / 100;
  return ppl > 0 ? Math.min(2200, (EQ_FLOOR + ppl * eqPerPpl) * vent) : EQ_FLOOR;
}

/** One 10 s physics step given current state and applied (setpoint, fan). */
function stepPhysics(s, dt, ppl) {
  const eqCo2 = co2Equilibrium(ppl, s.eqPerPpl, s.fan);
  s.co2 += (eqCo2 - s.co2) * EQ_RATE * dt;
  s.co2 = Math.min(2200, Math.max(EQ_FLOOR, s.co2));
  const heat = ppl > 0 ? ppl * HEAT_PER_PPL : 0;
  s.temp += (s.setpoint - s.temp) * EQ_RATE * dt + heat * dt;
  s.temp = Math.min(38, Math.max(16, s.temp));
}

/* ------------------------------------------------------------------ */
/* Cost model (what "good control" means)                              */
/* ------------------------------------------------------------------ */

const COST = {
  comfortPerDegPerMin: 1.0, // discomfort outside the neutral band
  comfortBandOccupied: 0.75, // C
  comfortBandEmpty: 1.5, // C
  coolingPerDegPerMin: 0.6, // AC work proxy: max(0, roomT - setpoint)
  fanPerMinAtFull: 0.05, // (fan/100)^2 * this
  iaqTier1: 0.8, // 700 -> 1000 ppm ramp height
  iaqPerPpm: 2.4 / 600, // post-1000 ppm slope
  bias: 0.012 // tiny pull toward 23 C occupied / 26 C empty (tie-break)
};

function costPerMinute(temp, ppl, setpoint, fan, co2) {
  const occupied = ppl > 0;
  const comfortC = occupied ? 23 : 26;
  const band = occupied ? COST.comfortBandOccupied : COST.comfortBandEmpty;
  let c = 0;
  const comfort = Math.abs(temp - comfortC) - band;
  if (comfort > 0) {
    c += comfort * COST.comfortPerDegPerMin;
  }
  const cooling = temp - setpoint;
  if (cooling > 0) {
    c += cooling * COST.coolingPerDegPerMin;
  }
  c += COST.fanPerMinAtFull * (fan / 100) * (fan / 100);
  if (co2 > 700) {
    if (co2 <= 1000) {
      c += COST.iaqTier1 * ((co2 - 700) / 300);
    } else {
      c += COST.iaqTier1 + (co2 - 1000) * COST.iaqPerPpm;
    }
  }
  c += COST.bias * (setpoint - comfortC) * (setpoint - comfortC);
  return c;
}

/**
 * Rolls the room forward `horizonMin` minutes under a FIXED action and the
 * known occupancy schedule, summing the cost. Deterministic (no noise) so the
 * expert's comparisons are exact.
 */
function actionCost(state, action, horizonMin, schedule, nowSec) {
  const { setpoint, fan } = action;
  const sim = { temp: state.temp, co2: state.co2, setpoint, fan, eqPerPpl: state.eqPerPpl };
  let cost = 0;
  let t = nowSec;
  const end = nowSec + horizonMin * 60;
  while (t < end) {
    const ppl = schedule.pplAt(t);
    stepPhysics(sim, TICK_DT, ppl);
    t += TICK_DT;
    cost += costPerMinute(sim.temp, ppl, setpoint, fan, sim.co2) * (TICK_DT / 60);
  }
  return cost;
}

/* ------------------------------------------------------------------ */
/* Occupancy schedules                                                 */
/* ------------------------------------------------------------------ */

function makeSchedule(rng, durSec, pplIn) {
  // Blocks of occupancy like a real room: idle -> busy -> idle -> busy ...
  const windows = []; // { from, to, ppl }
  const nBlocks = 2 + Math.floor(rng() * 2); // 2..3 meetings
  let cursor = 60 + Math.floor(rng() * 240); // first block starts 1-5 min in
  for (let i = 0; i < nBlocks && cursor < durSec - 600; i++) {
    const len = 360 + Math.floor(rng() * 600); // 6-16 minutes
    windows.push({ from: cursor, to: Math.min(durSec, cursor + len), ppl: pplIn });
    cursor += len + 120 + Math.floor(rng() * 540); // idle 2-11 minutes
  }
  return {
    pplAt(t) {
      for (const w of windows) {
        if (t >= w.from && t < w.to) {
          return w.ppl;
        }
      }
      return 0;
    },
    windows
  };
}

/* ------------------------------------------------------------------ */
/* Feature extraction (must match src/agent.js + src/nn.js)            */
/* ------------------------------------------------------------------ */

function mean(arr) {
  return arr.reduce((a, v) => a + v, 0) / arr.length;
}

/**
 * From the last ~40 s of "sensor" samples and the completed minute averages
 * compute the same 7 features agent.js builds from stored telemetry/minutes.
 */
function makeFeatures(occ, tempAvg, co2Avg, trend, curSetpoint, curFan) {
  return [occ ? 1 : 0, tempAvg, co2Avg, trend, curSetpoint, curFan, tempAvg - curSetpoint];
}

// Input normalisation constants - MUST match meta.featureScale written to
// model.json and applied by src/nn.js predict() at runtime. Training on raw
// co2/temp (up to ~2200 ppm) would saturate the tanh units at init and the
// deployed model would see a different distribution than it trained on.
const FEATURE_SCALE = {
  tempOffset: 23,
  tempScale: 5,
  co2Offset: 600,
  co2Scale: 600,
  trendScale: 80,
  spOffset: 23,
  spScale: 4,
  errOffset: 0,
  errScale: 5
};

/** Normalise raw features exactly like src/nn.js does before a forward pass. */
function scaleFeatures(f) {
  const s = FEATURE_SCALE;
  return [
    f[0], // occupancy already 0/1
    (f[1] - s.tempOffset) / s.tempScale,
    (f[2] - s.co2Offset) / s.co2Scale,
    f[3] / s.trendScale,
    (f[4] - s.spOffset) / s.spScale,
    f[5] / 100,
    (f[6] - s.errOffset) / s.errScale
  ];
}

/* ------------------------------------------------------------------ */
/* Expert                                                              */
/* ------------------------------------------------------------------ */

const CANDIDATE_SETPOINTS = [19, 20, 21, 22, 23, 24, 25, 26];
const CANDIDATE_FANS = [20, 40, 60, 80, 100];
const HORIZON_MIN = 6;

/**
 * Expert: rolls the room forward HORIZON_MIN minutes with the CURRENT
 * occupancy held constant and scores every candidate (setpoint, fan), keeping
 * the argmin (cost ties fall to the lowest fan/setpoint, so empty-room states
 * cleanly settle on 26 C / fan 20 - the energy-saving behaviour). The label is
 * a deterministic function of the observed state, so behavioural cloning
 * learns a smooth approximation of the policy.
 */
function expertBestAction(state, pplNow) {
  const frozen = { pplAt: () => pplNow };
  let best = null;
  let bestCost = Infinity;
  for (const setpoint of CANDIDATE_SETPOINTS) {
    for (const fan of CANDIDATE_FANS) {
      const c = actionCost(state, { setpoint, fan }, HORIZON_MIN, frozen, 0);
      if (c < bestCost - 1e-9) {
        bestCost = c;
        best = { setpoint, fan };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Dataset generation: closed-loop MPC episodes                        */
/* ------------------------------------------------------------------ */

function generateEpisode(rng, opts) {
  const durSec = opts.episodeMin * 60;
  const schedule = makeSchedule(rng, durSec, opts.ppl);
  const samples = [];
  const sim = {
    temp: 21 + rng() * 7, // 21-28 C
    co2: EQ_FLOOR + Math.floor(rng() * 480), // 420-900 ppm
    setpoint: 24,
    fan: 20,
    eqPerPpl: opts.eqPerPpl
  };
  let applied = { setpoint: 24, fan: 20 };

  // Sensor buffers (10 s cadence) and completed-minute CO2 averages.
  const tempBuf = [sim.temp];
  const co2Buf = [sim.co2];
  let minCo2Sum = 0;
  let minCo2Count = 0;
  let minCo2Avgs = [];
  let lastDecisionMinute = null;

  let t = 0;
  while (t < durSec) {
    const ppl = schedule.pplAt(t);
    stepPhysics(sim, TICK_DT, ppl);
    tempBuf.push(sim.temp);
    co2Buf.push(sim.co2);
    if (tempBuf.length > 8) tempBuf.shift();
    if (co2Buf.length > 8) co2Buf.shift();
    minCo2Sum += sim.co2;
    minCo2Count++;
    t += TICK_DT;

    // Minute boundary bookkeeping.
    const simMinute = Math.floor(t / 60);
    if (lastDecisionMinute === null) {
      lastDecisionMinute = simMinute;
    }

    // A control decision happens at the top of every simulated minute.
    const isDecisionPoint = Math.round(t) % 60 === 0 && simMinute > lastDecisionMinute;
    if (isDecisionPoint) {
      lastDecisionMinute = simMinute;
      if (minCo2Count > 0) {
        minCo2Avgs.push(minCo2Sum / minCo2Count);
        if (minCo2Avgs.length > 3) minCo2Avgs.shift();
        minCo2Sum = 0;
        minCo2Count = 0;
      }
      const occupied = ppl > 0;
      const tempAvg = mean(tempBuf.slice(-4)); // last 40 s
      const co2Avg = mean(co2Buf.slice(-4));
      const trend = minCo2Avgs.length >= 2 ? minCo2Avgs[minCo2Avgs.length - 1] - minCo2Avgs[minCo2Avgs.length - 2] : 0;
      const features = scaleFeatures(makeFeatures(occupied, tempAvg, co2Avg, trend, applied.setpoint, applied.fan));

      let label;
      if (sim.co2 >= 1000 || co2Avg >= 1000) {
        // Guardrail zone: crisp emergency action (matches the deployed agent).
        label = { setpoint: 22, fan: 100 };
      } else {
        label = expertBestAction(sim, ppl);
      }
      samples.push({
        features,
        label,
        state: { temp: sim.temp, co2: sim.co2, eqPerPpl: sim.eqPerPpl, ppl }
      });

      // Commit the crisp chosen action for the coming minute.
      sim.setpoint = label.setpoint;
      sim.fan = label.fan;
      applied = { setpoint: label.setpoint, fan: label.fan };
    }
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* Extra near-threshold sweeps (richer boundary coverage)              */
/* ------------------------------------------------------------------ */

function generateSweepSamples(rng, count) {
  // Extra samples across all three deployed room profiles for dense coverage of
  // the CO2 range each room actually visits (12 people blow past 1000 ppm in
  // seconds, so their states start higher; the offices stay below 1000).
  const profiles = [
    { eqPerPpl: 115, ppl: 12, co2Lo: 760, co2Hi: 1120 }, // meeting room
    { eqPerPpl: 66, ppl: 6, co2Lo: 470, co2Hi: 930 }, // ventilated west office
    { eqPerPpl: 110, ppl: 2, co2Lo: 450, co2Hi: 700 } // mild east office
  ];
  const samples = [];
  for (let i = 0; i < count; i++) {
    const prof = profiles[Math.floor(rng() * profiles.length)];
    const ppl = rng() < 0.75 ? prof.ppl : 0; // mostly occupied; 25 % idle
    const sim = {
      temp: 21 + rng() * 8,
      co2: ppl > 0 ? prof.co2Lo + rng() * (prof.co2Hi - prof.co2Lo) : 450 + rng() * 350,
      setpoint: 20 + rng() * 6,
      fan: 20 + Math.round(rng()) * 20 + (rng() < 0.5 ? 0 : 40),
      eqPerPpl: prof.eqPerPpl
    };
    let label;
    if (sim.co2 >= 1000) {
      // Guardrail zone: crisp emergency action (matches the deployed agent).
      label = { setpoint: 22, fan: 100 };
    } else {
      label = expertBestAction(sim, ppl);
    }
    const occupied = ppl > 0;
    const trend = label.fan >= 80 && sim.co2 > 800 ? 40 + rng() * 60 : rng() * 30 - 10;
    const features = scaleFeatures(makeFeatures(occupied, sim.temp, sim.co2, trend, sim.setpoint, sim.fan));
    samples.push({
      features,
      label,
      state: { temp: sim.temp, co2: sim.co2, eqPerPpl: prof.eqPerPpl, ppl }
    });
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* MLP training (Adam)                                                 */
/* ------------------------------------------------------------------ */

const LAYERS = [7, 24, 16, 2]; // keep in sync with src/nn.js expectations

function initWeights(rng, layers) {
  const weights = [];
  for (let i = 1; i < layers.length; i++) {
    const rows = layers[i - 1];
    const cols = layers[i];
    const scale = Math.sqrt(2 / (rows + cols));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        weights.push((rng() * 2 - 1) * scale);
      }
    }
    for (let c = 0; c < cols; c++) {
      weights.push(0);
    }
  }
  return weights;
}

/** Forward pass returning per-layer activations (for backprop). */
function forwardPass(x, weights, layers) {
  const acts = [x];
  let cursor = 0;
  let v = x;
  for (let i = 1; i < layers.length; i++) {
    const rows = layers[i - 1];
    const cols = layers[i];
    const next = new Array(cols);
    for (let c = 0; c < cols; c++) {
      let acc = weights[cursor + rows * cols + c]; // bias at end of block
      for (let r = 0; r < rows; r++) {
        acc += v[r] * weights[cursor + r * cols + c];
      }
      next[c] = i < layers.length - 1 ? Math.tanh(acc) : 1 / (1 + Math.exp(-acc));
    }
    cursor += rows * cols + cols;
    acts.push(next);
    v = next;
  }
  return acts;
}

function backwardPass(x, target, acts, weights, layers, grad) {
  const nOut = layers[layers.length - 1];
  // Output delta (MSE on sigmoid outputs).
  const deltaOut = new Array(nOut);
  for (let c = 0; c < nOut; c++) {
    const o = acts[acts.length - 1][c];
    deltaOut[c] = (o - target[c]) * o * (1 - o);
  }
  let cursor = weights.length;
  let deltas = deltaOut;
  for (let i = layers.length - 1; i >= 1; i--) {
    const rows = layers[i - 1];
    const cols = layers[i];
    cursor -= rows * cols + cols;
    // Weight + bias gradients.
    for (let c = 0; c < cols; c++) {
      grad[cursor + rows * cols + c] += deltas[c];
      for (let r = 0; r < rows; r++) {
        grad[cursor + r * cols + c] += acts[i - 1][r] * deltas[c];
      }
    }
    if (i > 1) {
      // Backprop into the previous layer (tanh: g' = 1 - g^2).
      const prevDelta = new Array(rows);
      for (let r = 0; r < rows; r++) {
        let acc = 0;
        for (let c = 0; c < cols; c++) {
          acc += weights[cursor + r * cols + c] * deltas[c];
        }
        const a = acts[i - 1][r];
        prevDelta[r] = acc * (1 - a * a);
      }
      deltas = prevDelta;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { epochs: 80, episodes: 150, seed: 42, sweeps: 2500 };
  for (let i = 2; i < argv.length; i++) {
    const m = /^--(epochs|episodes|seed|sweeps)=(\d+)$/.exec(argv[i]);
    if (m) {
      args[m[1]] = parseInt(m[2], 10);
    }
  }
  return args;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();
  const rng = mulberry32(args.seed);
  const outFile = path.join(__dirname, '..', 'src', 'model', 'model.json');

  console.log('=== AI agent model training (behavioural cloning of an MPC expert) ===');
  console.log('seed=' + args.seed + ' episodes=' + args.episodes + ' sweeps=' + args.sweeps + ' epochs=' + args.epochs);
  console.log('architecture ' + LAYERS.join('-') + '  expert horizon ' + HORIZON_MIN + ' min');

  // 1. Generate episodes across the deployed room profiles (people counts and
  //    CO2 equilibria copied from edge/build_flow.js ZONE_DEFS).
  const profiles = [
    { eqPerPpl: 115, ppl: 12, episodes: Math.round(args.episodes * 0.4) }, // meeting room
    { eqPerPpl: 110, ppl: 2, episodes: Math.round(args.episodes * 0.3) }, // east office
    { eqPerPpl: 66, ppl: 6, episodes: args.episodes - Math.round(args.episodes * 0.7) } // west office
  ];
  let samples = [];
  for (const prof of profiles) {
    for (let e = 0; e < prof.episodes; e++) {
      samples = samples.concat(generateEpisode(rng, { episodeMin: 50, eqPerPpl: prof.eqPerPpl, ppl: prof.ppl }));
    }
  }
  samples = samples.concat(generateSweepSamples(rng, args.sweeps));
  console.log('samples generated: ' + samples.length);

  // 2. Shuffle, then hold out the last 20 % for validation (both episodes and
  //    sweep states appear in train and val).
  shuffle(samples, rng);
  const splitAt = Math.floor(samples.length * 0.8);
  const train = samples.slice(0, splitAt);
  const val = samples.slice(splitAt);
  console.log('train=' + train.length + ' val=' + val.length);

  // Normalised targets: crisp expert setpoint (18..26) and fan (0..100) -> [0,1].
  const norm = (s) => [(s.label.setpoint - 18) / 8, s.label.fan / 100];
  const denorm = (o) => ({ setpoint: 18 + o[0] * 8, fan: o[1] * 100 });

  // 3. Train with Adam.
  const w = initWeights(rng, LAYERS);
  const m = new Array(w.length).fill(0);
  const v = new Array(w.length).fill(0);
  const grad = new Array(w.length).fill(0);
  const lr = 0.005;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  const batchSize = 128;
  let step = 0;
  const batches = Math.ceil(train.length / batchSize);

  console.log('training ' + args.epochs + ' epochs...');
  for (let epoch = 1; epoch <= args.epochs; epoch++) {
    let epochLoss = 0;
    for (let b = 0; b < batches; b++) {
      const start = b * batchSize;
      const end = Math.min(train.length, start + batchSize);
      grad.fill(0);
      for (let i = start; i < end; i++) {
        const sample = train[i];
        const target = norm(sample);
        const acts = forwardPass(sample.features, w, LAYERS);
        const out = acts[acts.length - 1];
        epochLoss += (out[0] - target[0]) * (out[0] - target[0]) + (out[1] - target[1]) * (out[1] - target[1]);
        backwardPass(sample.features, target, acts, w, LAYERS, grad);
      }
      const scale = 1 / (end - start);
      step++;
      for (let i = 0; i < w.length; i++) {
        m[i] = beta1 * m[i] + (1 - beta1) * grad[i] * scale;
        v[i] = beta2 * v[i] + (1 - beta2) * grad[i] * grad[i] * scale * scale;
        const mHat = m[i] / (1 - Math.pow(beta1, step));
        const vHat = v[i] / (1 - Math.pow(beta2, step));
        w[i] -= (lr * mHat) / (Math.sqrt(vHat) + eps);
      }
    }
    if (epoch === 1 || epoch % 10 === 0 || epoch === args.epochs) {
      let valLoss = 0;
      for (const s of val) {
        const t = norm(s);
        const out = forwardPass(s.features, w, LAYERS)[LAYERS.length - 1];
        valLoss += (out[0] - t[0]) * (out[0] - t[0]) + (out[1] - t[1]) * (out[1] - t[1]);
      }
      valLoss /= val.length;
      console.log('epoch ' + epoch + '/' + args.epochs + ' trainMse=' + (epochLoss / train.length).toFixed(5) + ' valMse=' + valLoss.toFixed(5));
    }
  }

  // 4. Regression metrics + cost gap vs the expert on the validation states.
  //    MAE/exact-match measure how close the model gets to the expert's exact
  //    action; the cost gap replays both actions over the same 6-minute
  //    horizon from each held-out state and compares total cost.
  let maeTemp = 0;
  let maeFan = 0;
  let exactAction = 0;
  let costModelSum = 0;
  let costExpertSum = 0;
  const crispPred = (o) => ({
    setpoint: Math.max(18, Math.min(26, Math.round(o.setpoint))),
    fan: Math.max(20, Math.min(100, Math.round(o.fan / 20) * 20))
  });
  for (const s of val) {
    const out = denorm(forwardPass(s.features, w, LAYERS)[LAYERS.length - 1]);
    const label = s.label;
    maeTemp += Math.abs(out.setpoint - label.setpoint);
    maeFan += Math.abs(out.fan - label.fan);
    const pred = crispPred(out);
    if (pred.setpoint === label.setpoint && pred.fan === label.fan) exactAction++;
    // Same start state, same (frozen) occupancy, two actions -> cost gap.
    // Aggregate ratio (total model cost / total expert cost) is used instead
    // of a mean of ratios: near-zero-cost states (empty rooms) would otherwise
    // blow the mean up even when both actions are effectively free.
    const frozen = { pplAt: () => s.state.ppl };
    const costExpert = actionCost(s.state, label, HORIZON_MIN, frozen, 0);
    const costModel = actionCost(s.state, pred, HORIZON_MIN, frozen, 0);
    costExpertSum += costExpert;
    costModelSum += costModel;
  }
  maeTemp /= val.length;
  maeFan /= val.length;
  const costGap = costExpertSum > 0 ? (costModelSum - costExpertSum) / costExpertSum : null;
  const metrics = {
    maeTempC: Math.round(maeTemp * 100) / 100,
    maeFanPct: Math.round(maeFan * 10) / 10,
    exactActionMatchPct: Math.round((exactAction / val.length) * 1000) / 10,
    totalCostGapVsExpertPct: costGap !== null ? Math.round(costGap * 1000) / 10 : null
  };
  console.log('validation: ' + JSON.stringify(metrics));

  // 5. Export the model (rounded to keep model.json small).
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const model = {
    format: 'mlp-v1',
    meta: {
      engine: 'ai-agent-nn-v1',
      trainedAt: new Date().toISOString(),
      seed: args.seed,
      epochs: args.epochs,
      layers: LAYERS,
      samples: { train: train.length, val: val.length, total: samples.length },
      features: [
        'occupancy',
        'temp_celsius',
        'co2_ppm',
        'co2_trend_ppm_per_min',
        'current_setpoint_c',
        'current_fan_pct',
        'temp_minus_setpoint_c'
      ],
      featureScale: FEATURE_SCALE,
      outScale: { tempMin: 18, tempMax: 26, fanMax: 100 },
      valMetrics: metrics,
      costModel: {
        comfortC: { occupied: 23, empty: 26 },
        iaqTier1Ppm: 700,
        emergencyPpm: 1000,
        horizonMin: HORIZON_MIN
      }
    },
    weights: w.map((x) => Math.round(x * 1e6) / 1e6)
  };
  fs.writeFileSync(outFile, JSON.stringify(model));
  console.log('model written to ' + outFile + ' (' + (model.weights.length + ' params, ' + Math.round(fs.statSync(outFile).size / 1024) + ' KB)'));
  console.log('total time ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' s');
}

main();
