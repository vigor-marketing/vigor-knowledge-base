FROM mirror.ccs.tencentyun.com/library/node:20-alpine

WORKDIR /app
ENV NPM_CONFIG_REGISTRY=https://mirrors.cloud.tencent.com/npm/
RUN npm install --global pnpm@10.14.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=4180
ENV APP_BASE_PATH=/apps/knowledge-base/

EXPOSE 4180
CMD ["node", "src/server.mjs"]
