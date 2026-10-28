# Сервер Zvon для VPS/хостинга (без интерфейса). Инструкция: deploy/README.md
#
# Сборка:  docker build -t zvon-server .
# Запуск:  cd deploy && docker compose up -d

# 1. Зависимости сервера: нативные модули собираются под обычный Node.js (не под Electron).
#    Готовый mediasoup-worker подходит не для всех систем — тогда mediasoup собирает его
#    из исходников (5–10 минут), для этого нужны python3-pip, make и g++.
FROM node:22-bookworm AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-pip \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: не запускать postinstall приложения (он пересобирает модули под Electron).
# Затем отдельно ставим то, что нужно серверу: better-sqlite3 и mediasoup-worker.
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild better-sqlite3 mediasoup \
  && rm -rf node_modules/uiohook-napi \
    node_modules/mediasoup/worker/deps node_modules/mediasoup/worker/src \
    node_modules/mediasoup/worker/subprojects node_modules/mediasoup/worker/test \
    node_modules/mediasoup/worker/fuzzer node_modules/mediasoup/worker/out/Release/subprojects \
  && test -x node_modules/mediasoup/worker/out/Release/mediasoup-worker

# 2. Сборка кода (out/main/server.js).
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx electron-vite build

# 3. Итоговый образ.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    ZVON_DATA=/data
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/out/main ./out/main
# Работаем от root: папка данных монтируется с хоста (./data), и её владелец там — root.
VOLUME ["/data"]
# 7777/tcp — чат и файлы; 40000/udp и 40000/tcp — голос и демонстрация экрана.
EXPOSE 7777/tcp 40000/udp 40000/tcp
CMD ["node", "out/main/server.js"]
