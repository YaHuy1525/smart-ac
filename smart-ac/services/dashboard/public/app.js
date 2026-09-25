// Smart AC Dashboard Frontend Logic (Vanilla JS, Real-Time Polling & Plotly Charts)

const API_BASE = "";

// State tracking
let plotlyInitialized = false;
let graphPaused = false;

function toggleGraph() {
  graphPaused = !graphPaused;
  const btn = document.getElementById('toggleGraphBtn');
  if (btn) {
    if (graphPaused) {
      btn.innerHTML = '▶ Resume Graph';
      btn.style.color = 'var(--success)';
      btn.style.borderColor = 'var(--success)';
    } else {
      btn.innerHTML = '⏸ Pause Graph';
      btn.style.color = 'var(--primary)';
      btn.style.borderColor = 'var(--primary)';
    }
  }
}

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  initPlotlyChart();
  fetchAllBackendData();
  // Poll every 2 seconds for real-time backend updates
  setInterval(fetchAllBackendData, 2000);
});

async function fetchAllBackendData() {
  await Promise.all([
    fetchSystemStatus(),
    fetchLatestTelemetry(),
    fetchLatestDecisions(),
    fetchCepAlerts(),
    fetchWeatherFeed(),
    graphPaused ? Promise.resolve() : fetchTelemetryHistory()
  ]);
}

// 1. Fetch System Health & Queue Depth Status
async function fetchSystemStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/status`);
    if (!res.ok) return;
    const data = await res.json();
    
    // Database / Store Badge
    const dbBadge = document.getElementById("dbStatus");
    if (dbBadge) {
      dbBadge.textContent = data.databaseConnected ? "Store: Active" : "Store: Standby";
      dbBadge.className = data.databaseConnected ? "badge badge-success" : "badge badge-warning";
    }

    // SQS Queue Badge
    const queueBadge = document.getElementById("queueStatus");
    if (queueBadge && data.queueStats) {
      const avail = data.queueStats.available || 0;
      queueBadge.textContent = `Queue: ${avail} pending`;
      queueBadge.className = avail > 0 ? "badge badge-warning" : "badge badge-info";
    }
  } catch (err) {}
}

// 2. Fetch Weather Feed Data
async function fetchWeatherFeed() {
  try {
    const res = await fetch(`${API_BASE}/api/weather`);
    if (!res.ok) return;
    const weather = await res.json();
    
    const tempEl = document.getElementById("weatherTemp");
    const locEl = document.getElementById("weatherLoc");
    const condEl = document.getElementById("weatherCond");
    const humEl = document.getElementById("weatherHum");

    if (tempEl) tempEl.textContent = `${weather.temp_celsius.toFixed(1)} °C`;
    if (locEl) locEl.textContent = weather.location;
    if (condEl) condEl.textContent = weather.condition;
    if (humEl) humEl.textContent = `${weather.humidity}%`;
  } catch (err) {}
}

// 3. Fetch Latest Telemetry across 3 Physical Zones
async function fetchLatestTelemetry() {
  try {
    const res = await fetch(`${API_BASE}/api/telemetry/latest`);
    if (!res.ok) return;
    const zones = await res.json();

    zones.forEach(z => {
      const zoneKey = z.zone;
      const tempEl = document.getElementById(`temp-${zoneKey}`);
      const co2El = document.getElementById(`co2-${zoneKey}`);
      const humEl = document.getElementById(`hum-${zoneKey}`);
      const occEl = document.getElementById(`occ-${zoneKey}`);
      const fanEl = document.getElementById(`fan-${zoneKey}`);
      const barEl = document.getElementById(`bar-co2-${zoneKey}`);

      if (tempEl) tempEl.textContent = `${z.temp_celsius.toFixed(1)} °C`;
      if (co2El) co2El.textContent = `${z.co2_ppm} ppm`;
      if (humEl) humEl.textContent = `${z.humidity}%`;

      if (occEl) {
        occEl.textContent = z.occupancy ? "Occupied" : "Unoccupied";
        occEl.className = z.occupancy ? "occupancy-pill" : "occupancy-pill pill-unoccupied";
      }

      // Emergency Local Fan check (CO2 >= 1000 ppm)
      if (fanEl) {
        if (z.co2_ppm >= 1000) {
          fanEl.textContent = "EMERGENCY FAN 100%";
          fanEl.className = "fan-pill pill-emergency";
        } else {
          fanEl.textContent = "NORMAL";
          fanEl.className = "fan-pill pill-normal";
        }
      }

      // CO2 status bar percentage fill & warning colors
      if (barEl) {
        const pct = Math.min(100, Math.max(10, (z.co2_ppm / 1200) * 100));
        barEl.style.width = `${pct}%`;
        if (z.co2_ppm >= 1000) {
          barEl.className = "status-bar-fill fill-danger";
        } else if (z.co2_ppm >= 800) {
          barEl.className = "status-bar-fill fill-warn";
        } else {
          barEl.className = "status-bar-fill fill-good";
        }
      }
    });
  } catch (err) {}
}

// 4. Fetch Latest AI Agent Decisions & Reasoning Stream
async function fetchLatestDecisions() {
  try {
    const res = await fetch(`${API_BASE}/api/decisions/latest`);
    if (!res.ok) return;
    const data = await res.json();
    const decisions = data.latestDecisions || [];

    const feedEl = document.getElementById("aiReasoningFeed");
    if (feedEl && decisions.length > 0) {
      feedEl.innerHTML = decisions.map(d => `
        <div class="feed-item">
          <div class="feed-time">${d.time ? new Date(d.time).toLocaleTimeString() : 'Recent'} — ${d.zone} [${d.model || 'ai-agent-nn-v1'}]</div>
          <div class="feed-text"><strong>Target:</strong> ${d.target_temp}°C / Fan ${d.target_fan_speed}% | <strong>Reasoning:</strong> ${d.reasoning || 'Neural policy optimization'}</div>
        </div>
      `).join('');

      // Update AI target setpoint labels on zone cards
      decisions.forEach(d => {
        const spEl = document.getElementById(`ai-setpoint-${d.zone}`);
        if (spEl) {
          spEl.textContent = `${d.target_temp}.0 °C / Fan ${d.target_fan_speed}%`;
        }
      });
    }
  } catch (err) {}
}

// 5. Fetch Complex Event Processing (CEP) Threshold Alerts
async function fetchCepAlerts() {
  try {
    const res = await fetch(`${API_BASE}/api/cep-alerts`);
    if (!res.ok) return;
    const data = await res.json();
    const alerts = data.alerts || [];

    const badgeEl = document.getElementById("cepCountBadge");
    const feedEl = document.getElementById("cepAlertsFeed");

    if (badgeEl) {
      badgeEl.textContent = `${alerts.length} Active Alert${alerts.length === 1 ? '' : 's'}`;
      badgeEl.className = alerts.length > 0 ? "alert-count-badge" : "card-tag";
    }

    if (feedEl) {
      if (alerts.length === 0) {
        feedEl.innerHTML = `<div class="empty-feed">System nominal. Monitoring real-time threshold breaches & sensor anomalies...</div>`;
      } else {
        feedEl.innerHTML = alerts.map(a => `
          <div class="cep-alert-item ${a.type === 'CRITICAL_HAZARD' ? 'alert-critical' : 'alert-warning'}">
            <div><strong>[${a.type}]</strong> ${a.message}</div>
            <div class="feed-time">${a.zone}</div>
          </div>
        `).join('');
      }
    }
  } catch (err) {}
}

// 6. Interactive Scenario Control Action
async function triggerScenario(action) {
  try {
    const res = await fetch(`${API_BASE}/api/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    if (res.ok) {
      await fetchAllBackendData();
    }
  } catch (err) {
    console.error("Simulation trigger error", err);
  }
}

// 7. Plotly Real-Time Environmental Trend Analytics
function initPlotlyChart() {
  const container = document.getElementById('plotlyChartContainer');
  if (!container || typeof Plotly === 'undefined') return;

  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 15, r: 20, l: 45, b: 35 },
    xaxis: { showgrid: true, gridcolor: 'rgba(255,255,255,0.06)', color: '#94a3b8', font: { family: 'Inter' } },
    yaxis: { title: 'CO2 (ppm)', showgrid: true, gridcolor: 'rgba(255,255,255,0.06)', color: '#94a3b8', font: { family: 'Inter' } },
    legend: { orientation: 'h', y: 1.15, font: { color: '#f8fafc', family: 'Inter', size: 11 } }
  };

  const initialData = [
    { x: [], y: [], name: 'Burwood CO2', mode: 'lines+markers', line: { color: '#38bdf8', width: 2.5 } },
    { x: [], y: [], name: 'Dubai CO2', mode: 'lines+markers', line: { color: '#22c55e', width: 2.5 } },
    { x: [], y: [], name: 'Melbourne CBD CO2', mode: 'lines+markers', line: { color: '#ef4444', width: 2.5 } }
  ];

  Plotly.newPlot('plotlyChartContainer', initialData, layout, { responsive: true, displayModeBar: false });
  plotlyInitialized = true;
}

async function fetchTelemetryHistory() {
  if (!plotlyInitialized || typeof Plotly === 'undefined') return;

  try {
    const res = await fetch(`${API_BASE}/api/telemetry/history`);
    if (!res.ok) return;
    const history = await res.json();

    const eastX = [], eastY = [];
    const westX = [], westY = [];
    const meetX = [], meetY = [];

    history.forEach(h => {
      const timeStr = new Date(h.time).toLocaleTimeString();
      if (h.zone === 'burwood') { eastX.push(timeStr); eastY.push(h.co2_ppm); }
      if (h.zone === 'dubai') { westX.push(timeStr); westY.push(h.co2_ppm); }
      if (h.zone === 'melbourne-cbd') { meetX.push(timeStr); meetY.push(h.co2_ppm); }
    });

    Plotly.update('plotlyChartContainer', {
      x: [eastX, westX, meetX],
      y: [eastY, westY, meetY]
    });
  } catch (err) {}
}
