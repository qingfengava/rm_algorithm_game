# 无人机算法对抗赛

这是 4x4 双平面无人机算法对抗赛的平台仓库。选手程序只允许使用 C++23；规则、SDK 和提交约束见 `docs/`。

## 本地环境

要求：

- CMake 3.22 或更高版本。
- 支持 C++23 的 C++ 编译器。
- Docker Engine 和 Docker Compose。
- Node.js 22 或更高版本。

执行 C++ 构建和测试：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DARENA_BUILD_TESTS=ON
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

启动 PostgreSQL、Redis、S3 兼容对象存储、Compile Worker、Scheduler、Match Worker、API、前端和 Compose smoke test：

```bash
docker compose up --build
```

服务地址：

```text
前端：http://localhost:8081
API：http://localhost:8080/health
对象存储（LocalStack S3）：http://localhost:4566
```

运行源码检查：

```bash
./scripts/check.sh
```

## 仓库结构

```text
engine/       C++23 规则引擎
sdk/          选手 C++23 SDK
runner/       选手算法运行器
services/     API、调度、比赛 Worker、回放网关
web/          网站前端
infra/        Docker 和部署文件
tests/        C++ 和服务测试
docs/         规则、API、提交和回放规范
```

API 基础服务、PostgreSQL/Redis/MinIO 数据流和上传验收见 [`docs/API.md`](docs/API.md)。
Scheduler 和 Match Worker 的比赛队列、双向配对及排行榜重算见 [`services/scheduler/README.md`](services/scheduler/README.md)
和 [`services/match-worker/README.md`](services/match-worker/README.md)。
Compile Worker 会消费上传完成通知，编译并运行双向资格赛；通过后提交才进入正式对战队列。

## 开发约定

任何规则或 API 变化都必须同步修改 `docs/` 和对应测试。
