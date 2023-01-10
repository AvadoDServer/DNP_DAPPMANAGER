FROM --platform=linux/amd64 node:10.15.3-alpine as build

RUN apk add --no-cache git python build-base bind-tools docker bash jq

WORKDIR /usr/src/app

# Install app dependencies to use docker's layer cache
COPY build/src/package.json ./
# COPY build/src/yarn.lock ./
#RUN yarn install --production
RUN npm i

# Add source
COPY build/src .

# Get this DNP version and git hash. Results in /usr/src/app/.version.json
COPY .git .git
COPY dappnode_package.json .
RUN ./getVersionData.sh

# This results in a single layer image
FROM --platform=linux/amd64 node:10.15.3-alpine

ENV DOCKER_COMPOSE_VERSION 1.20.1

RUN apk add --no-cache curl bind-dev xz libltdl miniupnpc

RUN ALPINE_GLIBC_BASE_URL="https://github.com/sgerrand/alpine-pkg-glibc/releases/download" && \
    ALPINE_GLIBC_PACKAGE_VERSION="2.28-r0" && \
    ALPINE_GLIBC_BASE_PACKAGE_FILENAME="glibc-$ALPINE_GLIBC_PACKAGE_VERSION.apk" && \
    ALPINE_GLIBC_BIN_PACKAGE_FILENAME="glibc-bin-$ALPINE_GLIBC_PACKAGE_VERSION.apk" && \
    ALPINE_GLIBC_I18N_PACKAGE_FILENAME="glibc-i18n-$ALPINE_GLIBC_PACKAGE_VERSION.apk" && \
    apk add --no-cache --virtual=.build-dependencies wget ca-certificates && \
    wget --no-verbose \
        "https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub" \
        -O "/etc/apk/keys/sgerrand.rsa.pub" && \
    wget --no-verbose \
        "$ALPINE_GLIBC_BASE_URL/$ALPINE_GLIBC_PACKAGE_VERSION/$ALPINE_GLIBC_BASE_PACKAGE_FILENAME" \
        "$ALPINE_GLIBC_BASE_URL/$ALPINE_GLIBC_PACKAGE_VERSION/$ALPINE_GLIBC_BIN_PACKAGE_FILENAME" \
        "$ALPINE_GLIBC_BASE_URL/$ALPINE_GLIBC_PACKAGE_VERSION/$ALPINE_GLIBC_I18N_PACKAGE_FILENAME" && \
    apk add --no-cache \
        "$ALPINE_GLIBC_BASE_PACKAGE_FILENAME" \
        "$ALPINE_GLIBC_BIN_PACKAGE_FILENAME" \
        "$ALPINE_GLIBC_I18N_PACKAGE_FILENAME" && \
    \
    rm "/etc/apk/keys/sgerrand.rsa.pub" && \
    /usr/glibc-compat/bin/localedef --force --inputfile POSIX --charmap UTF-8 "$LANG" || true && \
    echo "export LANG=$LANG" > /etc/profile.d/locale.sh && \
    \
    apk del glibc-i18n && \
    \
    rm "/root/.wget-hsts" && \
    apk del .build-dependencies && \
    rm \
        "$ALPINE_GLIBC_BASE_PACKAGE_FILENAME" \
        "$ALPINE_GLIBC_BIN_PACKAGE_FILENAME" \
        "$ALPINE_GLIBC_I18N_PACKAGE_FILENAME"

RUN curl -L https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-Linux-x86_64 > /usr/local/bin/docker-compose \
  && chmod +x /usr/local/bin/docker-compose


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
