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
docker build -f infra/docker/compile-worker.Dockerfile -t arena-compile-worker:local .
docker build -f infra/docker/match-worker.Dockerfile -t arena-match-worker:local .
docker build -f infra/docker/runner.Dockerfile -t arena-runner:local .
```

Compile Worker 和 Match Worker 必须使用 rootless Docker 或 rootless Podman 启动。API 容器只负责提交、查询和调度，不直接执行选手二进制。

本地运行编译 Worker：

```bash
mkdir -p /tmp/arena-output
runner/run_compile_worker.sh submission.zip /tmp/arena-output/bot_runner
```

`runner/build_submission.sh` 也会通过同一个 Compile Worker 编译，并通过
Match Worker 执行两场资格赛；它不会在宿主机直接编译或运行选手程序。

本地运行 Match Worker：

```bash
runner/run_match_worker.sh red_runner blue_runner
```

资格赛可以显式选择方向：

```bash
runner/run_match_worker.sh --qualify-red candidate baseline
runner/run_match_worker.sh --qualify-blue baseline candidate
```

两个启动器都会拒绝 rootful 引擎，默认启用无网络、只读根文件系统、无 capabilities、禁止提权、seccomp、cgroup CPU/内存、进程数和外部超时。选手 runner 只通过只读单文件挂载进入容器，不挂载宿主机目录。

Compile Worker 只把提交 ZIP 以只读方式挂载，并把单独的输出暂存目录以读写方式挂载。它使用 rootless 用户命名空间中的容器 UID 0 写入该目录；这不是宿主机 root 权限，其他宿主机目录不会暴露给 Worker。

算法 seccomp 配置位于 [`infra/seccomp/algorithm.json`](seccomp/algorithm.json)，Match Worker 使用允许裁判 fork/exec 的 [`infra/seccomp/match-worker.json`](seccomp/match-worker.json)。Compile Worker 使用独立的 [`infra/seccomp/compile-worker.json`](seccomp/compile-worker.json)，编译阶段允许编译器创建子进程，但禁止网络和特权系统调用。

容器环境准备完成后，运行安全验收：

```bash
tests/security/sandbox_acceptance.sh
```

该验收会检查安全算法可以运行，文件读取、网络 socket、创建子进程和超量地址空间申请被拒绝，并确认死循环会以超时状态结束。它需要 rootless Podman 或 Docker 以及已构建的 Worker 镜像。
