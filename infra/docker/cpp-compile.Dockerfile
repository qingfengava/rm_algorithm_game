FROM gcc:14-bookworm

RUN apt-get update \
    && apt-get install --no-install-recommends --yes cmake ninja-build unzip ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["bash"]
