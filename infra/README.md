# 本地开发环境

## 启动依赖和测试服务

在仓库根目录执行：

```bash
docker compose up --build
```

服务地址：

```text
前端：http://localhost:8081
API：http://localhost:8080/v1/health
MinIO 控制台：http://localhost:9001
PostgreSQL：localhost:5432
Redis：localhost:6379
```

`test` 容器会检查 API、PostgreSQL、Redis、MinIO 和前端是否可访问，并输出 `compose smoke test passed`。

## 构建固定工具链镜像

```bash
docker build -f infra/docker/cpp-compile.Dockerfile -t arena/cpp-compile:local .
docker build -f infra/docker/runtime.Dockerfile -t arena/runtime:local .
```

这两个镜像供后续 Compile Worker 和 Match Worker 使用。选手代码必须在独立沙箱中运行，不能直接在 API 容器内执行。
