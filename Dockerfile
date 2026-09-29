# Container image for suga.app and any Docker-native host.
#
# Zero-dependency app: no npm install step needed, so the image stays tiny
# (node:20-alpine, ~120 MB). The server is long-running; CMD is what keeps
# the container alive. On suga, deploy the repo via git and it builds this
# Dockerfile automatically.
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

COPY . .

EXPOSE 8080

CMD ["node", "platforms/node.js"]