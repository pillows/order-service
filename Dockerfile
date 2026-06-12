# Polymarket authenticated order-execution microservice.
# Holds the trading wallet and signs/submits real CLOB orders — run it on a
# dedicated, locked-down host.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8070

EXPOSE 8070

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:8070/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
