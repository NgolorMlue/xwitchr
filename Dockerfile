FROM node:20-alpine

WORKDIR /app

ARG APP_PORT=51067
ARG DASHBOARD_USERNAME=admin
# DASHBOARD_PASSWORD must be set at build-time or run-time — no default for security
ARG DASHBOARD_PASSWORD

ENV NODE_ENV=production \
    PORT=${APP_PORT} \
    DASHBOARD_USERNAME=${DASHBOARD_USERNAME} \
    DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data

EXPOSE ${APP_PORT}

CMD ["node", "server.js"]
