FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/docker-sandbox-api/package.json ./package.json
COPY packages/docker-sandbox-api/src ./src

CMD ["npm", "run", "start"]
