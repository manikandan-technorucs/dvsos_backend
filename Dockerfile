FROM node:20-alpine

WORKDIR /app

# Install dependencies including OpenSSL for Prisma
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci --omit=dev

# Generate Prisma Client
RUN npx prisma generate

# Copy application source
COPY . .

# Expose port
EXPOSE 5000

# Start the application
CMD ["node", "src/server.js"]
