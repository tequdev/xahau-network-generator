FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.ts .
EXPOSE 8080
CMD ["node", "server.ts"]
