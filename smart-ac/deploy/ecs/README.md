# Week 7 -> AWS ECS Fargate deployment mapping

The containerised stack in `docker-compose.yml` runs the exact same images and
environment variables a Fargate deployment would use. This document maps every
local component to its AWS equivalent so the demo can be reproduced on real AWS
(Week 7 milestone "Auto Scaling Ready" / plan NFR1: auto scale up to 100 room
zones, max 10 containers per Risk 1).

## Service -> AWS mapping

| Local component        | AWS equivalent                                   | Notes |
| ---------------------- | ------------------------------------------------ | ----- |
| `nodered` container    | Edge gateway on the building site                | Publishes MQTT 5 s smoothed telemetry, local CO2>1000 emergency fan |
| `broker` (Aedes)       | AWS IoT Core (device gateway + topic rules)      | X.509/TLS 1.3 certificates replace the open MQTT port (NFR3) |
| `queue` (REST emulator)| AWS SQS queue(s)                                  | `telemetry`, `ai-jobs`, `actuator-jobs` = three SQS queues |
| `mongo` container      | MongoDB Atlas cluster                            | Indexes on `zone`+`time` (Risk 3 mitigation) |
| `ingestion` container  | ECS Fargate task (service `ingestion`)           | Polls SQS `telemetry`, batch 10, visibility timeout 30 s |
| `ai-agent` container   | ECS Fargate task (service `ai-agent`)            | Polls SQS `ai-jobs` |
| `actuator` container   | ECS Fargate task (service `actuator`)            | Polls SQS `actuator-jobs`, publishes MQTT setpoint topics |
| `docker compose` scale | ECS Service Auto Scaling (target tracking)       | See scaling policy below |

## Scaling policy (NFR1)

Real AWS autoscaling for each consumer service:

```
TargetTrackingScalingPolicy on ApplicationAutoScaling:
  Service:  ingestion / ai-agent / actuator
  Metric:   SQS queue depth (ApproximateNumberOfMessagesVisible)
  Target:   avg messages per container per poll cycle ~ 5
  Min:      1 container   Max: 10 containers (plan Risk 1)
```

Rationale: the ingestion loop receives up to 10 messages per second per
replica, so when the telemetry queue backs up, Fargate adds replicas; when the
queue drains, it removes them. Multiple replicas act as *competing consumers*
on the same queue - each message is processed exactly once per replica set.

Try it locally (while the stack is running):

```powershell
docker compose up -d --scale ingestion=2 --scale ai-agent=2
docker compose ps          # shows both replicas of each service
```

`curl http://127.0.0.1:3100/api/queues/telemetry/stats` shows the queue depth
that would feed the autoscaling metric. Log lines include the container PID /
replica so you can see the load split across consumers.

## Optional real-AWS bring-up (requires an AWS account + credentials)

1. Create IoT Core thing + X.509 certs, attach the policy allowing
   `iot:Connect`, `iot:Publish` on `zones/+/telemetry`.
2. Create the three SQS queues and an IoT Core topic rule:
   `SELECT * FROM 'zones/+/telemetry'` -> SQS `telemetry`.
3. Build + push the images to ECR, register task definitions
   (`services/*/Dockerfile` are the task container definitions).
4. Create the ECS cluster + services with the target-tracking policy above and
   the MongoDB Atlas connection string as a secret.
5. Re-point Node-RED MQTT server to the IoT Core endpoint with the device certs.

Cost control (plan Risk 1): SQS batching (max 10), max 10 containers per
service, CloudWatch billing alarm.
