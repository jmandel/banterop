FROM oven/bun:latest AS runtime

WORKDIR /app

# Install dependencies
COPY package.json bunfig.toml tsconfig.json ./
RUN bun install --ci

# Copy source
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts

# Create non-root user (UID 10001) and switch
# Create non-root user (Debian-compatible invocation)
RUN useradd -u 10001 -m appuser || adduser --disabled-password --gecos "" --uid 10001 appuser \
    && mkdir -p /app/public \
    && chown -R 10001:10001 /app
USER appuser

# Default env
ENV PORT=3000 \
    DB_PATH=/data/data.db \
    NODE_ENV=production

EXPOSE 3000

# Volume for SQLite persistence
VOLUME ["/data"]

# Build frontends and start prod server (static + API under /api)
# Build frontends at container startup using env (PUBLIC_*), then start prod server
CMD ["bun", "src/prod/index.ts"]


