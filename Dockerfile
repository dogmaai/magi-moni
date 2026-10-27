FROM node:24.22.1-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production || npm install
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
