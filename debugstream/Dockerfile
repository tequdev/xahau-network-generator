FROM node:24-slim
WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev
COPY server.ts index.html ./
EXPOSE 8080
CMD ["node", "server.ts"]
