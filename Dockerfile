FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package.json ./
RUN npm install

# 复制源代码
COPY . .

# 暴露端口（Vercel Worker 使用）
EXPOSE 8080

# 启动命令
CMD ["npm", "run", "dev"]
