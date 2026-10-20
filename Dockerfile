FROM node:24-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run typecheck

RUN useradd --uid 10001 --user-group --create-home appuser \
  && mkdir -p /app/data \
  && chown -R appuser:appuser /app

ENV NODE_ENV=production
ENV PORT=8790
EXPOSE 8790

USER appuser
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8790/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
