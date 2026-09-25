FROM node:22-alpine

WORKDIR /app

COPY services/lib /app/services/lib
COPY services/dashboard/package.json /app/services/dashboard/package.json
COPY services/dashboard/src /app/services/dashboard/src
COPY services/dashboard/public /app/services/dashboard/public

WORKDIR /app/services/dashboard
RUN npm install --omit=dev --no-audit --no-fund

EXPOSE 3000
CMD ["node", "src/server.js"]

