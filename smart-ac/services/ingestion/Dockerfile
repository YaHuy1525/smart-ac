# Week 7: containerised ingestion microservice (auto-scalable consumer of the telemetry queue)
FROM node:22-alpine

WORKDIR /app

COPY services/lib /app/services/lib
COPY services/ingestion/package.json /app/services/ingestion/package.json
COPY services/ingestion/src /app/services/ingestion/src

WORKDIR /app/services/ingestion
RUN npm install --omit=dev --no-audit --no-fund

EXPOSE 3120
CMD ["node", "src/server.js"]
