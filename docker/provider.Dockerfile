FROM node:24-bookworm-slim
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter "@xorv/cli..." && pnpm --filter @xorv/protocol build && pnpm --filter @xorv/cli build
ENV XORV_HOME=/data
CMD ["node", "scripts/hosted-echo-provider.mjs"]
