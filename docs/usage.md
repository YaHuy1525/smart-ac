# Smart AC System — Usage Guide

The Smart AC project emulates the full AWS IoT air-conditioning pipeline
locally: virtual room sensors on a Node-RED edge gateway, MQTT ingestion
through an Aedes broker standing in for AWS IoT Core, an SQS-style job queue,
a trained neural-network decision engine and setpoint actuation back to the
edge. Everything runs with Docker Compose on one machine, offline.

This guide covers the operational steps — start the stack, watch the closed
loop, verify the results. The full architecture notes, the week-by-week
deliverable mapping and the captured evidence live in
[smart-ac/README.md](../smart-ac/README.md).

## Prerequisites

- Docker Desktop with Compose v2
- Node.js 18+ (only for the native dev run and the Jest tests)
- No cloud account, no certificates, no internet access needed after the
  images are pulled

## Quick start (containerised stack)

```powershell
cd smart-ac
docker compose up -d --build   # build + start all 7 services (healthchecked)
docker compose ps              # every service should report "healthy"
docker compose logs -f         # watch edge, ingestion, AI decisions, actuation
```

### Service ports

| Service        | Port              | Role                                                  |
| -------------- | ----------------- | ----------------------------------------------------- |
| Node-RED       | 1880 (editor)     | edge gateway with the virtual sensors                 |
| MQTT broker    | 1883, 31883 stats | Aedes broker + topic-rules engine (IoT Core emulator) |
| Queue API      | 3100              | SQS emulator (`telemetry`, `ai-jobs`, `actuator-jobs`) |
| Ingestion      | 3120              | validates telemetry, stores to MongoDB, aggregates    |
| AI agent       | 3130              | NN policy + guardrails + monitoring skill             |
| Actuator       | 3140              | applies decisions, publishes setpoints back           |
| MongoDB        | 27018             | telemetry + actuator state store                      |

## Watching the closed loop

The meeting room is scripted to fill twice per run (CO2 rises past
1000 ppm about 50 s and about 6 min after the flow starts), so every demo run
exercises both emergency paths:

- The local edge fan answers a CO2 reading above 1000 ppm in under 500 ms.
- The cloud NN decision (22 C / fan 100 % under the emergency override) is
  applied back at the edge within the 2 s budget.
- Both emergencies clear about 35 s after the room empties (below 850 ppm
  hysteresis); `east-office` settles near 23 C and `west-office` stays at the
  energy-saving 26 C.

Reset the demo scenario at any time:

```powershell
docker compose up -d --build nodered
```

### Scaling demo

```powershell
docker compose up -d --scale ingestion=2 --scale ai-agent=2   # competing consumers
curl http://127.0.0.1:3100/api/queues/telemetry/stats          # queue depth metric
```

The three emulator queues back the queue-depth autoscaling policy documented
in [smart-ac/deploy/ecs/README.md](../smart-ac/deploy/ecs/README.md)
(min 1 / max 10 containers).

## Native (no-Docker) developer run

All five cloud services can run directly on Node for fast iteration
(file-backed store under `.data/`; MongoDB optional via `MONGO_URI`):

```powershell
node scripts/dev_stack.js      # queue, broker, ingestion, ai-agent, actuator
docker compose up -d nodered   # the edge gateway still runs as a container
```

## Tests and verification

```powershell
npm test                      # Jest unit tests (agent engine, monitor skill, validator)
node scripts/verify_stack.js  # health + queue semantics + business evidence
node scripts/key_events.js    # rebuild the evidence/04 key-events digest
```

`verify_stack.js` prints an ALL PASSED / FAILED summary; the committed run
artefacts it checks against live in [`smart-ac/evidence/`](../smart-ac/evidence/).

## Where to go next

| Document | Contents |
| -------- | -------- |
| [smart-ac/README.md](../smart-ac/README.md) | architecture, week → deliverable mapping, evidence numbers |
| [smart-ac/deploy/ecs/README.md](../smart-ac/deploy/ecs/README.md) | local → AWS ECS Fargate mapping and the scaling policy |
