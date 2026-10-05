FROM gcc:14-bookworm

RUN apt-get update \
    && apt-get install --no-install-recommends --yes unzip ripgrep coreutils \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 arena

WORKDIR /opt/arena
COPY sdk /opt/arena/sdk
COPY runner /opt/arena/runner

RUN chown -R arena:arena /opt/arena
USER arena

ENTRYPOINT ["/opt/arena/runner/compile_worker.sh"]
