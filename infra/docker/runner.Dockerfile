FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends --yes libgcc-s1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 arena

WORKDIR /app
USER arena

ENTRYPOINT ["/app/bot_runner"]
