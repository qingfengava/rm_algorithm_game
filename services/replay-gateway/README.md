# Replay Gateway

Replay Gateway 负责通过 WebSocket 推送比赛事件，并提供历史回放读取接口。

阶段 1 仅建立服务边界。实时事件协议以 `docs/REPLAY_SCHEMA.md` 为准。
