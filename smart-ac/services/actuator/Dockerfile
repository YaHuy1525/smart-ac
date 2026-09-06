# Week 7: containerised actuator microservice (MQTT downlink to the edge)
FROM node:22-alpine

WORKDIR /app

COPY services/lib /app/services/lib
COPY services/actuator/package.json /app/services/actuator/package.json
COPY services/actuator/src /app/services/actuator/src

WORKDIR /app/services/actuator
RUN npm install --omit=dev --no-audit --no-fund

EXPOSE 3140
CMD ["node", "src/server.js"]
