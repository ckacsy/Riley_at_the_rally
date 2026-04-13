FROM node:18-alpine AS build

WORKDIR /app

# Install backend dependencies (production only)
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy backend source
COPY backend/ ./backend/

# Copy frontend static files
COPY frontend/ ./frontend/

# --- Runtime stage ---
FROM node:18-alpine AS runtime

# Add non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy built artifacts from build stage
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend ./frontend

# Create writable directories for data and logs
RUN mkdir -p /app/backend/logs /app/backend/uploads \
    && chown -R appuser:appgroup /app

USER appuser

WORKDIR /app/backend

EXPOSE 5000

CMD ["node", "server.js"]
