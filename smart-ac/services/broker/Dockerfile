# Week 7: containerised MQTT broker (emulates the AWS IoT Core device gateway task)
FROM node:22-alpine

WORKDIR /app

COPY services/lib /app/services/lib
COPY services/broker/package.json /app/services/broker/package.json
COPY services/broker/src /app/services/broker/src

WORKDIR /app/services/broker
RUN npm install --omit=dev --no-audit --no-fund

EXPOSE 1883 31883
CMD ["node", "src/server.js"]
