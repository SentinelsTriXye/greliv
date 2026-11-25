FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production CONFIG=/config/config.json DATA=/data/etat.json
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
