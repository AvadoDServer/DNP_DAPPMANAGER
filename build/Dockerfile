# Debian (glibc) base on purpose. restartPatch recreates the DAPPMANAGER by
# running the HOST's docker-compose, a glibc binary, inside a container of this
# image. On Alpine that binary cannot run (the glibc compat packages no longer
# work on current Alpine), so the DAPPMANAGER could not update itself.
FROM --platform=linux/amd64 node:20-bookworm-slim AS build

RUN apt-get update && \
    apt-get install -y --no-install-recommends git python3 build-essential jq ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install app dependencies to use docker's layer cache
COPY build/src/package.json ./
COPY build/src/yarn.lock ./
RUN yarn install --production

# Add source
COPY build/src .

# Get this DNP version and git hash. Results in /usr/src/app/.version.json
COPY .git .git
COPY dappnode_package.json .
RUN ./getVersionData.sh

# This results in a single layer image
FROM --platform=linux/amd64 node:20-bookworm-slim

# Same API version as the Docker 20.10 engines updateAvadoHost.sh installs
ENV DOCKER_API_VERSION 1.41
ENV DOCKER_CLI_VERSION 20.10.24
ENV DOCKER_COMPOSE_VERSION 1.29.2
ENV DOCKER_COMPOSE_SHA256 f3f10cf3dbb8107e9ba2ea5f23c1d2159ff7321d16f0a23051d68d8e2547b323

# procps: free (getStats), bind9-dnsutils: nsupdate (dns_updater),
# miniupnpc: upnpc, xz-utils: package images, cron: dns_updater every minute
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl ca-certificates xz-utils miniupnpc bind9-dnsutils cron procps && \
    rm -rf /var/lib/apt/lists/*

# Docker CLI and docker-compose, both pinned. Compose stays on v1: it is what
# every installed package was created with (1.20.1 up to 10.0.45) and what the
# host runs, so container, network and volume handling does not change.
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz \
      | tar -xz -C /tmp docker/docker && \
    mv /tmp/docker/docker /usr/bin/docker && rm -rf /tmp/docker && \
    curl -fsSL -o /usr/local/bin/docker-compose \
      https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-Linux-x86_64 && \
    echo "${DOCKER_COMPOSE_SHA256}  /usr/local/bin/docker-compose" | sha256sum -c - && \
    chmod +x /usr/local/bin/docker-compose && \
    docker --version && docker-compose version

# Files for updating legacy Docker installations on the host
# Debian Buster (10)
ADD https://download.docker.com/linux/debian/dists/buster/pool/stable/amd64/containerd.io_1.4.4-1_amd64.deb /update/buster/
ADD https://download.docker.com/linux/debian/dists/buster/pool/stable/amd64/docker-ce-cli_20.10.17~3-0~debian-buster_amd64.deb /update/buster/
ADD https://download.docker.com/linux/debian/dists/buster/pool/stable/amd64/docker-ce_20.10.17~3-0~debian-buster_amd64.deb /update/buster/
# Debian Bullseye (11)
ADD https://download.docker.com/linux/debian/dists/bullseye/pool/stable/amd64/containerd.io_1.4.4-1_amd64.deb /update/bullseye/
ADD https://download.docker.com/linux/debian/dists/bullseye/pool/stable/amd64/docker-ce_20.10.17~3-0~debian-bullseye_amd64.deb /update/bullseye/
ADD https://download.docker.com/linux/debian/dists/bullseye/pool/stable/amd64/docker-ce-cli_20.10.17~3-0~debian-bullseye_amd64.deb /update/bullseye/
ADD build/updateAvadoHost.sh /update/
RUN chmod +x /update/updateAvadoHost.sh

# Copy files and do things that can change

WORKDIR /usr/src/app

COPY build/entrypoint.sh .
COPY build/dns_updater.sh /etc/periodic/1min/dns_updater
RUN chmod +x /etc/periodic/1min/dns_updater && \
    echo "* * * * * run-parts /etc/periodic/1min" | crontab -

ENV DB_PATH /usr/src/app/DNCORE/dappmanagerdb.json
ENV FILE_PATH /usr/src/app/DNCORE/static

# Copy the src the last as it's the more likely layer to change
COPY --from=build /usr/src/app /usr/src/app

ENTRYPOINT /usr/src/app/entrypoint.sh
