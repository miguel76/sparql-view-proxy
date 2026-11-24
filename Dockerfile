FROM node:22-alpine

# jq runs the view filters; git + python3 run jqpm, which installs the jq
# packages a filter depends on (see docker-entrypoint.sh).
ARG JQPM_VERSION=0.2.0
RUN apk add --no-cache jq git python3 py3-pip \
 && pip install --no-cache-dir --break-system-packages --root-user-action=ignore "jqpm==${JQPM_VERSION}" \
 && apk del py3-pip

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/

ENV NODE_ENV=production \
    SPARQL_VIEW_PROXY_CONFIG=/config/config.json
USER node
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
