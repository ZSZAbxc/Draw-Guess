# Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# 你的服务监听端口（和你之前设置的服务端口一致，比如 3000 或 80）
EXPOSE 3000

CMD ["npm", "start"]
