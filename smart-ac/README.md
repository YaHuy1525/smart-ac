# Smart AI-Driven Air Conditioning & Environmental Control System (SIT314 Task 1.2D)

A working, containerised implementation of the 9-week project plan through **Week 7**
("Auto Scaling Ready"). The system emulates the full AWS IoT architecture locally so the
whole closed loop - virtual room sensors on an edge gateway, MQTT ingestion, a cloud AI
decision engine and setpoint actuation back to the edge - can be demonstrated on one
machine, offline.

> Local emulation choices (approved in the plan): **Aedes MQTT broker** stands in for
> AWS IoT Core, a **REST SQS emulator** for AWS SQS, **MongoDB container** for MongoDB
> Atlas, and **Docker Compose** for ECS Fargate. `deploy/ecs/README.md` maps every
> component to its real AWS equivalent.

![architecture](../architecture_diagram.png)  ![data flow](../data_flow_diagram.png)

## What runs (Week 7 stack)

| Component        | Role                                                                 | Port(s)           |
| ---------------- | -------------------------------------------------------------------- | ----------------- |
| `nodered`        | Edge gateway: virtual DHT22/MH-Z19/PIR sensors in 3 zones, 5 s sliding-average smoothing, local CO2>1000 ppm emergency fan (hysteresis 1000/850) | 1880 (editor)     |
| `broker` (Aedes) | AWS IoT Core emulator: MQTT device gateway + topic-rules engine (`zones/+/telemetry` -> `telemetry` queue) | 1883, 31883 stats |
| `queue`          | AWS SQS emulator (`telemetry`, `ai-jobs`, `actuator-jobs`): visibility timeouts, receipt-handle delete, at-least-once redelivery, depth stats | 3100              |
| `ingestion`      | SQS consumer: validates telemetry, stores to MongoDB, per-zone minute aggregation, emergency (>=1000 ppm) job enqueue | 3120              |
| `ai-agent`       | Cloud AI decision engine: a **trained neural-network policy** (`ai-agent-nn-v1`, src/nn.js) picks comfort setpoint + fan from 7 zone-state features (occupancy, temp, CO2, CO2 trend, current setpoint/fan), wrapped by hard safety guardrails (18-26 C clamp; CO2 >= 1000 ppm emergency 22 C/fan 100 %), hysteresis dedupe, and a **monitoring skill** that flags stuck/missing sensors, CO2 stress and unresponsive AC units every 20 s | 3130              |
| `actuator`       | Applies AI decisions: persists state, publishes `zones/{zone}/setpoint` back to the broker for the edge | 3140              |
| `mongo`          | MongoDB 7 (host port 27018), indexes on `zone` + `time`              | 27018             |

Zones: `east-office`, `west-office`, `meeting-room`. The meeting room is scripted to
fill twice per run (CO2 rises past 1000 ppm ~50 s and ~6 min after the flow starts) so
every demo run exercises local + cloud emergency handling and both hysteresis clears.

## Week -> deliverable mapping

| Week | Plan milestone | Deliverable in this repo |
| ---- | -------------- | ------------------------ |
| 1    | Project planning | `Task1.2D_Project_Plan_Updated.*` (project root), this README |
| 2    | Edge setup: Node-RED + virtual sensors | `edge/build_flow.js` -> `edge/flows.json` (18-node flow: 3 virtual zones, 0.25 s sampling, 5 s average, CO2 local emergency fan <500 ms) |
| 3    | Cloud setup: IoT Core + queue | `services/broker/` (Aedes = AWS IoT Core emulator, MQTT rules engine), `services/queue/` (SQS emulator) |
| 4    | Ingestion service | `services/ingestion/`: SQS polling (batch 10, 30 s visibility), schema validation, MongoDB store, minute aggregation |
| 5    | AI agent engine | `services/ai-agent/`: pure decision engine `src/agent.js` driven by an **offline-trained NN** (`train/train_model.js`, model in `src/model/model.json`) + `src/monitor.js` anomaly skill + 26 Jest tests; hard 18-26 C limits, emergency 22 C/fan 100 %, command dedupe |
| 6    | Control feedback (actuation) | `services/actuator/`: consumes decisions, persists state, publishes MQTT setpoints consumed by the Node-RED flow (closed loop) |
| 7    | Containers & scaling | `Dockerfile` per service, `docker-compose.yml` (healthchecks, dependency chains), scaling docs `deploy/ecs/README.md` (queue-depth autoscaling, max 10 containers), `docker compose up -d --scale ingestion=2` |

## Quick start (Week 7 containerised stack)

Prerequisites: Docker Desktop (Compose v2). No cloud account, no certificates, no internet needed after images are pulled.

```powershell
cd smart-ac
docker compose up -d --build   # build + start all 7 services (healthchecked)
docker compose ps              # all services should be "healthy"
```

- Node-RED editor: http://localhost:1880 (flow `edge/flows.json` is baked into the
  image; it auto-starts the virtual sensors).
- Watch the closed loop: `docker compose logs -f` shows edge emergencies,
  ingestion, NN-based AI decisions, `[ai-monitor]` anomaly events and actuation
  back to the edge.
- About 40 s after the meeting room fills, CO2 > 1000 ppm triggers the local fan
  (141-214 ms), then the cloud NN/guardrail decision (22 C / fan 100 %) is applied
  back from the cloud (~135-916 ms from the triggering reading). It clears ~35 s
  after the meeting empties (CO2 < 850 ppm); the room fills again at ~T+5 min.
  `east-office` is mildly occupied (the NN settles it near 23 C), `west-office`
  stays empty (energy-saving 26 C).
- Reset the demo scenario at any time: `docker compose up -d --build nodered`.

### Scaling demo (Week 7 / NFR1)

```powershell
docker compose up -d --scale ingestion=2 --scale ai-agent=2   # competing consumers
curl http://127.0.0.1:3100/api/queues/telemetry/stats          # queue depth = autoscaling metric
```

The three SQS-emulator queues back the target-tracking scaling policy described in
`deploy/ecs/README.md` (SQS `ApproximateNumberOfMessagesVisible`, min 1 / max 10).

## Verification & evidence

```powershell
npm test                                  # 26 Jest unit tests (agent engine + monitor skill + telemetry validator)
node scripts/verify_stack.js              # health + queue semantics + business evidence, ALL PASS
node scripts/key_events.js                # rebuild evidence/04 key-events digest from the captured logs
```

Evidence from the final clean run (all artefacts in [`evidence/`](evidence/)):

| File | Contents | Result |
| ---- | -------- | ------ |
| `00_unit_tests.txt` | `npm test` | 26/26 tests passed |
| `01_week7_docker_compose_ps.txt` | `docker compose ps` after 10 min | all 7 services healthy |
| `02_week7_verify_stack.txt` | `verify_stack.js` full report | **ALL CHECKS PASSED** |
| `03_week7_full_logs.txt` | `docker compose logs --no-color -t` (10 min, timestamped) | full pipeline trace |
| `04_week7_key_events.txt` | digest: counters + emergencies/decisions/monitor events + latencies | see summary below |
| `05_model_training.txt` | NN training run: 9,900 samples, 100 epochs, val metrics | model committed |

Key numbers from the evidence run (2026-09-06, compose boot 08:36:55 UTC, flow clock
reset 08:38:01 UTC, capture 08:48:2X UTC - ~10.4 min of flow time):

**AI model (this run drove all decisions)**

- `ai-agent-nn-v1`: 7-24-16-2 MLP (626 params), trained offline on 9,900 simulated
  minutes (7,920 train / 1,980 val) by behavioural cloning of a 6-minute receding-
  horizon MPC expert that mirrors the edge physics (see `05_model_training.txt`).
- Validation: setpoint MAE **0.17 C**, fan MAE **3.8 %**, exact action match
  **82.6 %**, total control cost within **+3 %** of the expert on held-out states.
- Guardrails on top: 18-26 C hard clamp (NFR3) and CO2 >= 1000 ppm emergency
  override (22 C / fan 100 %); hysteresis dedupe suppressed 23 of 38 jobs.

**Closed loop**

- 426 telemetry records stored this run, 0 invalid, 36 minute aggregates flushed
  (11.3 k+ records cumulative in MongoDB across sessions).
- 15 AI decisions stored, 23 "no change" dedupe skips; all target temps within 18-26 C.
- Local emergency fan: **141 ms** and **214 ms** after raw CO2 > 1000 ppm (NFR2
  target < 500 ms); hysteresis released at 849/848 ppm ~35 s after each meeting ended.
- Cloud real-time emergency decisions: `latencyFromSensorMs` **135 ms** and **916 ms**
  (NFR2 target < 2000 ms). Minute-boundary confirmation jobs measure 2.9-4.5 s from
  the minute's last reading - bounded by the 5 s publish + 60 s aggregation cadence;
  the NN forward pass itself is < 1 ms (`lastInferenceMs=0`) and the actuation loop
  runs at ~280 ms.
- Meeting-room emergency decisions: 22 C / fan 100 %, reasoning "CO2 emergency
  detected (1xx ppm >= 1000 ppm)"; after each clear the NN restored energy-saving
  26 C / fan 18-19 %.
- Final actuator state: west-office 26 C/18 % (energy-saving), east-office 23 C/24 %
  (comfort; reasoning "CO2 rising 87 ppm/min, ventilating proactively"), meeting-room
  26 C/18 % - every decision logged with `model ai-agent-nn-v1`.

**Monitoring skill (agent-side)**

- 37 monitor cycles in ~10 min (every 20 s across 3 zones), zero NO_TELEMETRY events.
- Detected and auto-resolved: CO2_RISING x3 (983 ppm +220 ppm/min, 1228 ppm
  +494 ppm/min, 1031 ppm +149 ppm/min), CO2_HIGH **alert** at 1308 ppm, and
  FLAT_SENSOR cycles in the quiet offices (quantisation-flat readings at steady
  state; they resolve as soon as real movement resumes). 14 opens + 14 resolves
  logged in-window; boot-time stale-state flags (ACTUATOR_STALE) also resolved.

**Broker / queues**

- Broker rules engine: 481 MQTT publishes -> 444 forwarded, 0 failed, 0 DLQ.
- All three queues fully drained at capture: telemetry 426 enqueued/426 deleted,
  depth 0 (consumers keep up - scaling NFR1 healthy).

## Native (no-Docker) developer run

For fast iteration without containers, all five cloud services can run directly on Node
(file-backed store under `.data/`; MongoDB optional via `MONGO_URI`):

```powershell
node scripts/dev_stack.js                 # queue, broker, ingestion, ai-agent, actuator
docker compose up -d nodered              # edge gateway still runs as a container
```

## Repository layout

```
smart-ac/
├── docker-compose.yml        Week 7 orchestration (7 services, healthchecks)
├── edge/                     Week 2: Node-RED flow builder + generated flows.json
├── services/
│   ├── lib/                  shared logger, telemetry schema/validator, SQS client, store
│   ├── queue/                Week 3: AWS SQS emulator (REST)
│   ├── broker/               Week 3: Aedes MQTT broker + topic-rules engine (IoT Core emulator)
│   ├── ingestion/            Week 4: ingestion microservice (poll, validate, store, aggregate)
│   ├── ai-agent/             Week 5: AI decision engine + job consumer
│   │   ├── src/nn.js         NN model loader + forward pass (predict < 1 ms)
│   │   ├── src/agent.js      NN policy + guardrails + reasoning (engine)
│   │   ├── src/monitor.js    monitoring skill (6 anomaly detectors)
│   │   ├── src/model/        model.json (committed weights + metadata)
│   │   └── train/            train_model.js: MPC expert + behavioural cloning
│   └── actuator/             Week 6: setpoint actuation + state store
├── deploy/ecs/               Week 7: local -> AWS ECS Fargate mapping + scaling policy
├── scripts/                  verify_stack.js (evidence), key_events.js (digest), dev_stack.js (native run)
├── tests/                    Jest unit tests (agent engine + monitor skill, telemetry validator)
└── evidence/                 captured run evidence (see table above)
```

## Functional requirements covered

- **FR1** Edge emergency handling: CO2 >= 1000 ppm forces the local fan to 100% in
  <500 ms with 850 ppm hysteresis (evidenced 141/214 ms).
- **FR2** 5-second sliding-average smoothing on the gateway before telemetry is published.
- **FR3** Cloud AI agent decides per zone from aggregated minute data + latest readings:
  the decisions are outputs of the trained NN policy (`ai-agent-nn-v1`), never a lookup
  table, and every decision stores its reasoning + model tag.
- **FR4** Decisions are actuated back to the edge as MQTT setpoints (closed loop).
- **NFR1** Queue-backed consumer scaling (compose `--scale` demo + ECS policy docs).
- **NFR2** End-to-end latency budgets: local <500 ms (141-214 ms), cloud real-time
  emergency path <2 s (135-916 ms); NN inference itself <1 ms.
- **NFR3** Hard temperature limits 18-26 C enforced by the engine regardless of input.
