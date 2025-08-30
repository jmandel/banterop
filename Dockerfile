FROM oven/bun:latest AS runtime

WORKDIR /app

# Install dependencies
COPY package.json bunfig.toml tsconfig.json ./
RUN bun install --ci

# Copy source
COPY src ./src
COPY tests ./tests
COPY a2a ./a2a

# Create non-root user (UID 10001) and switch
# Create non-root user (Debian-compatible invocation)
RUN useradd -u 10001 -m appuser || adduser --disabled-password --gecos "" --uid 10001 appuser \
    && mkdir -p /app/public \
    && chown -R 10001:10001 /app
USER appuser

# Default env
ENV PORT=3000 \
    NODE_ENV=production

EXPOSE 3000

# Volume for SQLite persistence
VOLUME ["/data"]

# Start unified server in production mode
CMD ["bun", "run", "start"]

