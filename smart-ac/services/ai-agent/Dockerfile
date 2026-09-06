# Week 7: containerised AI agent microservice
FROM node:22-alpine

WORKDIR /app

COPY services/lib /app/services/lib
COPY services/ai-agent/package.json /app/services/ai-agent/package.json
COPY services/ai-agent/src /app/services/ai-agent/src

WORKDIR /app/services/ai-agent
RUN npm install --omit=dev --no-audit --no-fund

EXPOSE 3130
CMD ["node", "src/server.js"]
