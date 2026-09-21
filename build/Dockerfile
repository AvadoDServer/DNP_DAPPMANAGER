FROM --platform=linux/amd64 node:20-alpine AS build

RUN apk add --no-cache git python3 build-base bind-tools docker bash jq

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
FROM --platform=linux/amd64 node:20-alpine

ENV DOCKER_COMPOSE_VERSION v2.24.0
ENV DOCKER_API_VERSION 1.41

RUN apk add --no-cache curl bind-dev xz libltdl miniupnpc docker-cli-compose

# Install glibc for compatibility (some binaries may need it)
RUN apk add --no-cache --virtual=.build-dependencies wget ca-certificates && \
    wget -q -O /etc/apk/keys/sgerrand.rsa.pub https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub && \
    wget -q https://github.com/sgerrand/alpine-pkg-glibc/releases/download/2.35-r1/glibc-2.35-r1.apk && \
    wget -q https://github.com/sgerrand/alpine-pkg-glibc/releases/download/2.35-r1/glibc-bin-2.35-r1.apk && \
    apk add --no-cache --force-overwrite glibc-2.35-r1.apk glibc-bin-2.35-r1.apk && \
    rm -f /etc/apk/keys/sgerrand.rsa.pub glibc-2.35-r1.apk glibc-bin-2.35-r1.apk && \
    apk del .build-dependencies || true

# glibc-bin pulls in gcompat, whose musl-based /lib/ld-linux-x86-64.so.2 then
# loads glibc binaries and fails. restartPatch runs the host's glibc
# docker-compose inside this image to recreate the DAPPMANAGER, so the loader
# must be the real one. The check fails the build instead of shipping an image
# that cannot update itself.
RUN ln -sf /usr/glibc-compat/lib/ld-linux-x86-64.so.2 /lib/ld-linux-x86-64.so.2 && \
    mkdir -p /lib64 && \
    ln -sf /usr/glibc-compat/lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2 && \
    /lib64/ld-linux-x86-64.so.2 --version | grep -q "GNU libc"

# Create docker-compose wrapper script that calls "docker compose"
RUN echo '#!/bin/sh' > /usr/local/bin/docker-compose && \
    echo 'exec docker compose "$@"' >> /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose


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

COPY --from=build /usr/bin/nsupdate /usr/bin/nsupdate
COPY --from=build /usr/bin/docker /usr/bin/docker

COPY build/entrypoint.sh .
COPY build/dns_updater.sh /etc/periodic/1min/dns_updater
RUN crontab -l | { cat; echo "*       *       *       *       *       run-parts   /etc/periodic/1min"; } | crontab -

ENV DB_PATH /usr/src/app/DNCORE/dappmanagerdb.json
ENV FILE_PATH /usr/src/app/DNCORE/static

# Copy the src the last as it's the more likely layer to change
COPY --from=build /usr/src/app /usr/src/app

ENTRYPOINT /usr/src/app/entrypoint.sh
