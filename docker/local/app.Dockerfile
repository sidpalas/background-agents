FROM node:22-bookworm

WORKDIR /workspace

COPY . .

RUN npm ci

CMD ["bash"]
