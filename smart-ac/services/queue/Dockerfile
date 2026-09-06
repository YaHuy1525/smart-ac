# Week 7: containerised cloud service (emulates one ECS Fargate task container)
FROM node:22-alpine

WORKDIR /app

# shared libraries used by every service
COPY services/lib /app/services/lib

# service sources + manifest
COPY services/queue/package.json /app/services/queue/package.json
COPY services/queue/src /app/services/queue/src

WORKDIR /app/services/queue
RUN npm install --omit=dev --no-audit --no-fund

EXPOSE 3100
CMD ["node", "src/server.js"]
