# Eyniq Cache container image (DESIGN.md section 13): build with tsc, run on distroless
# Node 26 as non-root. Zero runtime dependencies, so the runtime stage has no node_modules.
#   docker build -f deploy/Dockerfile -t ghcr.io/eyniq/cache:dev .

# Base images are pinned by index digest. Update: docker buildx imagetools inspect <image:tag>
# and copy the top-level Digest.
FROM node:26-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
WORKDIR /app
RUN npm install --global pnpm@12.6.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
# An empty data dir owned by nonroot: Docker seeds new named volumes from it, so plain
# `docker run -v name:/data` works without root (Kubernetes uses fsGroup instead).
RUN mkdir -p /data-empty

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:33c86a63859efc2ebd88ea0a355863582ec6f1220d048de62baffb2584e709b3
LABEL org.opencontainers.image.source="https://github.com/eyniq/cache" \
      org.opencontainers.image.title="Eyniq Cache" \
      org.opencontainers.image.licenses="FSL-1.1-ALv2"
WORKDIR /app
# MALLOC_ARENA_MAX: fewer glibc arenas keep RSS lower when streaming large tarballs.
# MALLOC_MMAP_THRESHOLD_: a fixed 128 KiB threshold keeps large buffers on mmap, so their memory
# goes back to the system when freed (glibc's dynamic threshold otherwise climbs after large frees
# and ~450 MiB stayed held after a burst; idle 1010 -> 740 MiB, docs/OPERATIONS.md).
ENV NODE_ENV=production \
    FS_ROOT=/data \
    MALLOC_ARENA_MAX=2 \
    MALLOC_MMAP_THRESHOLD_=131072
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY LICENSE ./LICENSE
COPY --from=build --chown=65532:65532 /data-empty /data
# Only /data needs to be writable; run with a read-only root filesystem.
USER nonroot
EXPOSE 4873 9090
CMD ["dist/main.js"]
