FROM debian:bookworm-slim

RUN useradd --create-home --uid 10001 arena

WORKDIR /app
USER arena

CMD ["/bin/sh"]
