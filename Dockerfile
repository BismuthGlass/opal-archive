# syntax=docker/dockerfile:1
#
# OpalArchive in one image: the server, the frontend it serves, and the
# downloaders with what they need to run.
#
#   docker build -t opalarchive .
#   docker run -d --name opalarchive -p 127.0.0.1:7878:7878 -v opalarchive-data:/data opalarchive
#
# The library is kept in the volume at /data: the database, the files, and
# the logins saved for the downloaders. The port is published above to the
# machine itself only; OpalArchive has no login of its own, so anything
# that can reach the port can use it.

# The frontend, built to static files.
FROM node:lts-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# The server. SQLite is compiled into it.
FROM rust:1-trixie AS server
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
# Left in the cache mount, the build has to be copied out of it to be kept.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked \
    && cp target/release/opalarchive /opalarchive

# What runs. Debian 13 has ImageMagick 7, which is the one called `magick`.
FROM debian:trixie-slim

# What the server calls on: ImageMagick, ffmpeg and poppler for dimensions,
# lengths and thumbnails; curl to fetch a file from an address; `kill`, from
# procps, to stop a download; and Python for the downloaders' scripts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl ffmpeg imagemagick poppler-utils procps python3 \
    && rm -rf /var/lib/apt/lists/*

# uv runs the downloaders' scripts, fetching the packages each one names.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# It does not run as root. The library belongs to this user.
RUN useradd --create-home --uid 1000 opal \
    && mkdir /data \
    && chown opal:opal /data

WORKDIR /app
COPY --from=server /opalarchive /usr/local/bin/opalarchive
COPY --from=web /web/dist ./web
COPY downloaders ./downloaders

# Reachable from outside the container, which is where the port is
# published from; and headless, there being no browser here to read a
# login from: logins are sent by the browser extension, or uploaded.
ENV OPALARCHIVE_ADDR=0.0.0.0:7878 \
    OPALARCHIVE_DATA=/data \
    OPALARCHIVE_WEB=/app/web \
    OPALARCHIVE_DOWNLOADERS=/app/downloaders \
    OPALARCHIVE_HEADLESS=1 \
    UV_CACHE_DIR=/home/opal/.cache/uv \
    UV_PYTHON_DOWNLOADS=never

USER opal

# Each downloader's packages are fetched now, not at its first download.
# They are as new as the image: to update one, yt-dlp say, build it again.
RUN for script in downloaders/*/*.py; do \
        uv run --quiet --script "$script" --help > /dev/null || exit 1; \
    done

VOLUME /data
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -fsS http://127.0.0.1:7878/api/health > /dev/null || exit 1

CMD ["opalarchive"]
