# 生产镜像：浏览器依赖/字体随 Playwright 官方运行时镜像内置。
# 构建上下文必须是仓库根目录：
#   docker build -f apps/worker/Dockerfile .
# 注意：本镜像刻意不包含 tests-golden（黄金评测答案）——生产 worker
# 不做 mock 评测；需要评测答案的环境在宿主侧运行测试。
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker ./apps/worker
# worker 编译需要引用 api/src（共享服务模块）：
COPY apps/api/src ./apps/api/src
RUN pnpm install --frozen-lockfile --filter @ai-qa/worker...
RUN pnpm --filter @ai-qa/api exec prisma generate
RUN pnpm --filter @ai-qa/worker build

# Playwright 官方镜像：Chromium+Firefox+WebKit 与系统字体/依赖齐备，
# 版本与 package.json 的 playwright 大版本对齐。
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/packages ./packages
WORKDIR /app/apps/worker
EXPOSE 7200
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_PORT||7200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "dist/worker/src/server.js"]
