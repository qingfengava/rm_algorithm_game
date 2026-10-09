# Replay Gateway

Replay Gateway 负责通过 WebSocket 推送比赛事件，并提供历史回放读取接口。

Gateway 监听 `8082`，通过 Nginx 暴露为 `/ws/matches/{match_id}`。连接支持 `after_seq` 断点续播：先从 PostgreSQL 补发事件，再用 Redis Stream 作为实时唤醒通道。实时事件协议以 `docs/REPLAY_SCHEMA.md` 为准。
