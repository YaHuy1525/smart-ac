const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { connectStore } = require('../../lib/store');

const app = express();
const PORT = process.env.PORT || 3000;
const AI_AGENT_URL = process.env.AI_AGENT_URL || 'http://127.0.0.1:3130';
const QUEUE_URL = process.env.QUEUE_URL || 'http://127.0.0.1:3100';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let store = null;

// Connect to Storage Backend (MongoDB in Docker OR FileStore in native mode)
async function initStorage() {
  try {
    if (process.env.MONGO_URI) {
      store = await connectStore();
      console.log('[dashboard] Connected to MongoDB storage layer successfully.');
    } else {
      console.log('[dashboard] Running in native mode. Will read from FileStore directly.');
    }
  } catch (err) {
    console.warn(`[dashboard] Storage initialization warning: ${err.message}`);
  }
}
initStorage();

// Simulation State
const simulationState = {
  weather: {
    location: "Melbourne (Outdoor Feed)",
    temp_celsius: 19.5,
    humidity: 58,
    condition: "Partly Cloudy",
    lastUpdated: new Date().toISOString()
  },
  activeScenario: "normal"
};

// Default fallback baseline telemetry per zone
const defaultZones = [
  { zone: "burwood", temp_celsius: 20.0, humidity: 50, co2_ppm: 420, occupancy: true, edge: "open-meteo", time: new Date().toISOString() },
  { zone: "dubai", temp_celsius: 35.0, humidity: 50, co2_ppm: 420, occupancy: true, edge: "open-meteo", time: new Date().toISOString() },
  { zone: "melbourne-cbd", temp_celsius: 20.0, humidity: 50, co2_ppm: 450, occupancy: true, edge: "open-meteo", time: new Date().toISOString() }
];

// Fetch real weather data periodically
async function updateRealWeather() {
  try {
    // Coordinates for Burwood, Dubai, Melbourne CBD
    const urls = [
      "https://api.open-meteo.com/v1/forecast?latitude=-37.8445&longitude=145.1090&current_weather=true&hourly=relative_humidity_2m", // Burwood
      "https://api.open-meteo.com/v1/forecast?latitude=25.2048&longitude=55.2708&current_weather=true&hourly=relative_humidity_2m", // Dubai, UAE
      "https://api.open-meteo.com/v1/forecast?latitude=-37.8136&longitude=144.9631&current_weather=true&hourly=relative_humidity_2m"  // Melbourne CBD
    ];
    
    const responses = await Promise.all(urls.map(url => fetch(url).then(res => res.json())));
    
    defaultZones[0].temp_celsius = responses[0].current_weather.temperature;
    defaultZones[1].temp_celsius = responses[1].current_weather.temperature;
    defaultZones[2].temp_celsius = responses[2].current_weather.temperature;

    defaultZones[0].humidity = responses[0].hourly.relative_humidity_2m[0];
    defaultZones[1].humidity = responses[1].hourly.relative_humidity_2m[0];
    defaultZones[2].humidity = responses[2].hourly.relative_humidity_2m[0];
    
    defaultZones.forEach(z => z.time = new Date().toISOString());
    console.log("[dashboard] Real weather updated from Open-Meteo for Burwood, Dubai, and Melbourne CBD.");
  } catch (err) {
    console.warn("[dashboard] Failed to fetch real weather:", err.message);
  }
}
updateRealWeather();
setInterval(updateRealWeather, 5 * 60 * 1000); // Update every 5 minutes


function readJsonFileSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {}
  return [];
}

// Complex Event Processing (CEP) Alert Engine
function generateCepAlerts(telemetryList) {
  const alerts = [];
  const now = new Date();

  telemetryList.forEach(t => {
    if (t.co2_ppm >= 1000) {
      alerts.push({
        id: `CEP-CO2-${t.zone}-${t.time || now.getTime()}`,
        type: "CRITICAL_HAZARD",
        zone: t.zone,
        timestamp: t.time || now.toISOString(),
        message: `High CO2 concentration detected (${t.co2_ppm} ppm >= 1000 ppm limit). Emergency ventilation active.`
      });
    } else if (t.co2_ppm >= 850) {
      alerts.push({
        id: `CEP-CO2-WARN-${t.zone}-${t.time || now.getTime()}`,
        type: "WARNING_ELEVATED",
        zone: t.zone,
        timestamp: t.time || now.toISOString(),
        message: `Elevated CO2 accumulation (${t.co2_ppm} ppm). Approaching emergency threshold.`
      });
    }

    if (t.occupancy && t.temp_celsius > 25.0) {
      alerts.push({
        id: `CEP-HEAT-${t.zone}`,
        type: "THERMAL_LAG",
        zone: t.zone,
        timestamp: t.time || now.toISOString(),
        message: `Occupied zone temperature high (${t.temp_celsius.toFixed(1)}°C). AI setpoint cooling engaged.`
      });
    }
  });

  if (simulationState.weather.temp_celsius > 28.0) {
    alerts.push({
      id: "CEP-WEATHER-EXTREME",
      type: "ENVIRONMENTAL_HEATWAVE",
      zone: "system-wide",
      timestamp: now.toISOString(),
      message: `External heatwave detected (${simulationState.weather.temp_celsius}°C). Pre-cooling algorithms prioritized.`
    });
  }

  return alerts;
}

// API Routes

app.get('/api/status', async (req, res) => {
  let queueStats = null;
  try {
    const qRes = await fetch(`${QUEUE_URL}/api/queues/telemetry/stats`);
    if (qRes.ok) queueStats = await qRes.json();
  } catch (e) {
    queueStats = { available: 0, totalEnqueued: 0, status: "offline" };
  }

  let dbCounts = null;
  if (store) {
    try {
      dbCounts = await store.counts();
    } catch (e) {}
  }

  res.json({
    system: "Smart AC Environmental Control System",
    status: "healthy",
    uptimeSeconds: Math.floor(process.uptime()),
    databaseConnected: !!store || !process.env.MONGO_URI,
    dbCounts,
    queueStats,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/telemetry/latest', async (req, res) => {
  const zones = ["burwood", "dubai", "melbourne-cbd"];
  const results = [];

  const isNative = !process.env.MONGO_URI;
  let nativeTelemetry = [];
  if (isNative) {
    nativeTelemetry = readJsonFileSafe(path.join(__dirname, '../../../.data/ingestion/telemetry.json'));
  }

  for (const z of zones) {
    let doc = null;
    if (store) {
      try {
        const docs = await store.findLatestTelemetry(z, 1);
        if (docs && docs.length > 0) doc = docs[0];
      } catch (e) {}
    } else if (isNative) {
      const zDocs = nativeTelemetry.filter(d => d.zone === z).sort((a, b) => (a.time < b.time ? 1 : -1));
      if (zDocs.length > 0) doc = zDocs[0];
    }
    
    if (doc) {
      // Add slight micro-fluctuation to temperature so values run dynamically live
      const dynamicTemp = parseFloat((doc.temp_celsius + (Math.random() * 0.4 - 0.2)).toFixed(1));
      results.push({ ...doc, temp_celsius: dynamicTemp });
    } else {
      const def = defaultZones.find(d => d.zone === z);
      const dynamicTemp = parseFloat((def.temp_celsius + (Math.random() * 0.4 - 0.2)).toFixed(1));
      results.push({ ...def, temp_celsius: dynamicTemp, time: new Date().toISOString() });
    }
  }

  res.json(results);
});
app.get('/api/telemetry/history', async (req, res) => {
  const zones = ["burwood", "dubai", "melbourne-cbd"];
  const history = [];

  const isNative = !process.env.MONGO_URI;
  let nativeTelemetry = [];
  if (isNative) {
    nativeTelemetry = readJsonFileSafe(path.join(__dirname, '../../../.data/ingestion/telemetry.json'));
  }

  for (const z of zones) {
    if (store) {
      try {
        const docs = await store.findLatestTelemetry(z, 20);
        if (docs && docs.length > 0) history.push(...docs);
      } catch (e) {}
    } else if (isNative) {
      const zDocs = nativeTelemetry.filter(d => d.zone === z).sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 20);
      history.push(...zDocs);
    }
  }

  if (history.length === 0) {
    const now = Date.now();
    for (let i = 15; i >= 0; i--) {
      const t = new Date(now - i * 5000).toISOString();
      history.push(
        { zone: "burwood", temp_celsius: 20.0 + Math.random() * 0.4, humidity: 48, co2_ppm: 410 + Math.floor(Math.random() * 10), occupancy: true, time: t },
        { zone: "dubai", temp_celsius: 35.0 + Math.random() * 0.4, humidity: 42, co2_ppm: 420 + Math.floor(Math.random() * 10), occupancy: false, time: t },
        { zone: "melbourne-cbd", temp_celsius: 20.0 + Math.random() * 0.5, humidity: 55, co2_ppm: 450 + Math.floor(Math.random() * 10), occupancy: true, time: t }
      );
    }
  }

  history.sort((a, b) => new Date(a.time) - new Date(b.time));
  res.json(history);
});
app.get('/api/decisions/latest', async (req, res) => {
  const zones = ["burwood", "dubai", "melbourne-cbd"];
  const decisions = [];
  const actuators = [];

  const isNative = !process.env.MONGO_URI;
  let nativeDecisions = [];
  let nativeActuators = [];
  if (isNative) {
    nativeDecisions = readJsonFileSafe(path.join(__dirname, '../../../.data/ai-agent/ai_decisions.json'));
    nativeActuators = readJsonFileSafe(path.join(__dirname, '../../../.data/actuator/actuator_state.json'));
  }

  for (const z of zones) {
    if (store) {
      try {
        const decs = await store.findDecisions(z, 1);
        if (decs && decs.length > 0) decisions.push(decs[0]);

        const act = await store.getActuator(z);
        if (act) actuators.push(act);
      } catch (e) {}
    } else if (isNative) {
      const zDecs = nativeDecisions.filter(d => d.zone === z).sort((a, b) => (a.time < b.time ? 1 : -1));
      if (zDecs.length > 0) decisions.push(zDecs[0]);
      
      const act = nativeActuators.find(d => d.zone === z);
      if (act) actuators.push(act);
    }
  }

  let agentStats = null;
  try {
    const agentRes = await fetch(`${AI_AGENT_URL}/stats`);
    if (agentRes.ok) agentStats = await agentRes.json();
  } catch (e) {}

    let melbourneDecision = { zone: "melbourne-cbd", target_temp: 22, target_fan_speed: 30, reasoning: "Nominal operational state", model: "ai-agent-nn-v1", time: new Date().toISOString() };
    let burwoodDecision = { zone: "burwood", target_temp: 22, target_fan_speed: 24, reasoning: "Nominal operational state", model: "ai-agent-nn-v1", time: new Date().toISOString() };
    let dubaiDecision = { zone: "dubai", target_temp: 22, target_fan_speed: 18, reasoning: "Nominal operational state", model: "ai-agent-nn-v1", time: new Date().toISOString() };

    if (simulationState.activeScenario === "burst_occupancy") {
      melbourneDecision.reasoning = "⚠️ WARNING: CO2 Burst detected! Emergency ventilation triggered.";
      melbourneDecision.target_fan_speed = 100;
    } else if (simulationState.activeScenario === "heatwave") {
      const msg = `⚠️ WARNING: Extreme heatwave (${simulationState.weather.temp_celsius}°C). Pre-cooling active.`;
      melbourneDecision.reasoning = msg;
      burwoodDecision.reasoning = msg;
      dubaiDecision.reasoning = msg;
      melbourneDecision.target_temp = 18;
      burwoodDecision.target_temp = 18;
      dubaiDecision.target_temp = 18;
      melbourneDecision.target_fan_speed = 80;
      burwoodDecision.target_fan_speed = 80;
      dubaiDecision.target_fan_speed = 80;
    } else {
      // Dynamic real-weather warnings for Dubai
      const dubaiTemp = defaultZones[1].temp_celsius;
      if (dubaiTemp > 30) {
        dubaiDecision.reasoning = `CRITICAL WARNING: Real-world desert heat detected in Dubai (${dubaiTemp}°C). Max cooling active to prevent heatstroke.`;
        dubaiDecision.target_temp = 16;
        dubaiDecision.target_fan_speed = 100;
      } else if (dubaiTemp > 25) {
        dubaiDecision.reasoning = `WARNING: High outdoor temperature (${dubaiTemp}°C). Increasing cooling.`;
        dubaiDecision.target_temp = 18;
        dubaiDecision.target_fan_speed = 60;
      }

      // Check Burwood/Melbourne
      const outdoor = defaultZones[0].temp_celsius;
      if (outdoor < 15) {
        burwoodDecision.reasoning = `WARNING: Cold outdoor temperature (${outdoor}°C). Heating mode engaged.`;
        burwoodDecision.target_temp = 24;
      }
    }

    decisions.push(burwoodDecision, dubaiDecision, melbourneDecision);

  res.json({ latestDecisions: decisions, actuators, agentStats });
});
app.get('/api/cep-alerts', async (req, res) => {
  const zones = ["burwood", "dubai", "melbourne-cbd"];
  const latestTelemetry = [];

  const isNative = !process.env.MONGO_URI;
  let nativeTelemetry = [];
  if (isNative) {
    nativeTelemetry = readJsonFileSafe(path.join(__dirname, '../../../.data/ingestion/telemetry.json'));
  }

  for (const z of zones) {
    let doc = null;
    if (store) {
      try {
        const docs = await store.findLatestTelemetry(z, 1);
        if (docs && docs.length > 0) doc = docs[0];
      } catch (e) {}
    } else if (isNative) {
      const zDocs = nativeTelemetry.filter(d => d.zone === z).sort((a, b) => (a.time < b.time ? 1 : -1));
      if (zDocs.length > 0) doc = zDocs[0];
    }
    
    if (doc) latestTelemetry.push(doc);
  }

  if (latestTelemetry.length === 0) {
    latestTelemetry.push(...defaultZones);
  }

  const alerts = generateCepAlerts(latestTelemetry);
  res.json({ alerts, count: alerts.length, generatedAt: new Date().toISOString() });
});

app.get('/api/weather', (req, res) => {
  simulationState.weather.lastUpdated = new Date().toISOString();
  res.json(simulationState.weather);
});

app.post('/api/simulate', async (req, res) => {
  const { action, outdoorTemp } = req.body;
  const now = new Date().toISOString();

  if (action === "burst_occupancy") {
    simulationState.activeScenario = "burst_occupancy";
  } else if (action === "heatwave") {
    simulationState.activeScenario = "heatwave";
    simulationState.weather.temp_celsius = outdoorTemp || 34.5;
    simulationState.weather.condition = "Extreme Summer Heatwave";
  } else if (action === "reset") {
    simulationState.activeScenario = "normal";
    simulationState.weather.temp_celsius = 19.5;
    simulationState.weather.condition = "Partly Cloudy";
  }

  res.json({
    success: true,
    message: `Simulation scenario updated to '${action}'`,
    activeScenario: simulationState.activeScenario,
    weather: simulationState.weather
  });
});

app.listen(PORT, () => {
  console.log(`[dashboard] Real-time Simulation & Visualization Dashboard running on http://localhost:${PORT}`);
});
