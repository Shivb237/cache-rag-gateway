# Gateway service image. Build for the machine it will run on: Fargate ARM and your Apple-silicon Mac are both arm64.
#   docker build --platform linux/arm64 -t cache-rag-gateway .
FROM node:24-slim

# Switch to the unprivileged "node" user BEFORE installing anything. (A later `chown -R` would copy every installed file
# into a new layer and double the image size.) Only the empty /app directory needs re-owning.
WORKDIR /app
RUN chown node:node /app
USER node

# Dependencies first, so this layer is reused when only the code changes. tsx runs the TypeScript directly, so it is a
# production dependency; the compiler and test tools are left out.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node configs ./configs
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node data/eval ./data/eval

# Build the vector index and download the embedding model into the image, so the container starts fast and needs no
# model download at runtime. Secrets are NOT baked in: they are passed as environment variables when it runs.
RUN npm run index

ENV PORT=8080 \
    CONFIG_OVERRIDE=configs/providers/claude_sonnet.yaml
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/serve.ts"]
