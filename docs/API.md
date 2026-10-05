# API 基础服务

API 使用 PostgreSQL 保存业务状态，Redis 只用于提交完成后的唤醒通知，源码和编译产物保存在 S3 兼容对象存储。默认本地 Compose 使用 LocalStack S3；API 不接收源码二进制流。

本地默认使用 LocalStack 社区版的临时 S3 状态，PostgreSQL 中的提交、比赛和回放数据仍然持久化。API 重启不会清除仍在运行的对象存储容器；需要对象状态跨容器重建保留时，生产环境应使用 S3、OSS、COS 等持久化对象存储。

## 认证

当前基础服务使用 `Authorization: Bearer <token>`。本地 Compose 可以通过 `ARENA_DEV_HANDLE` 和 `ARENA_DEV_TOKEN` 自动建立开发用户。生产部署应关闭开发用户配置，并在 API 容器中运行：

```bash
node provision_user.js handle-name
```

命令只把 token 明文输出一次，数据库只保存 SHA-256 摘要。

## 提交上传

```http
POST /submissions
Authorization: Bearer <token>
Content-Type: application/json

{"name":"my bot"}
```

响应包含 `upload` 表单字段。浏览器直接把 `submission.zip` 以 `multipart/form-data` POST 到 `upload.url`，再调用：

```http
POST /submissions/{id}/complete
Authorization: Bearer <token>
```

对象存储会校验 `application/zip` 和 5 MiB 大小上限。创建记录后状态为 `UPLOADED`，但 `source.confirmed` 为 `false`；调度器只处理 `submission_artifacts.uploaded_at` 已设置的记录。确认成功后 `source.confirmed` 变为 `true`，即可从 PostgreSQL 查询并恢复未处理任务。源码下载 URL 只在提交详情中返回，并且是短期预签名 URL。

## 查询接口

```text
GET /health
GET /submissions/{id}
GET /leaderboard?limit=50&offset=0
GET /matches?limit=50&offset=0
GET /matches/{id}
GET /matches/{id}/replay
```

排行榜、比赛和回放接口不需要登录；提交详情只允许提交所属用户读取。所有列表接口限制 `limit <= 100`。

## 状态

提交状态为：

```text
UPLOADED -> COMPILING -> COMPILE_FAILED
                         -> QUEUED -> RUNNING -> FINISHED
                                             -> RUNTIME_FAILED
```

`submission_artifacts` 记录源码、编译产物和编译日志对象；`compile_log` 同时保留短日志摘要，便于直接查询失败原因。比赛事件按 `(match_id, seq)` 唯一约束追加，回放接口按序读取 PostgreSQL 事件。比赛的 64 位地图种子在 JSON 中以十进制字符串返回，避免 JavaScript 精度损失。

## 本地验收

启动 Compose 后执行：

```bash
node tests/api_integration.js
```

它会创建提交、直接上传 ZIP、确认上传、查询下载 URL 并校验下载字节完全一致。API 重启后可使用命令输出的提交 ID 执行：

```bash
node tests/api_integration.js --verify <submission-id>
```

数据库层状态迁移测试：

```bash
npm --prefix services/api run test:integration
```
