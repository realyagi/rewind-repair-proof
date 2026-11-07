FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY server.mjs static.mjs ./
USER root
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- --header="Authorization: Bearer $SANDBOX_TOKEN" http://127.0.0.1:5000/health || exit 1
CMD ["node", "server.mjs"]
