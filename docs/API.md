# API 基础服务

API 使用 PostgreSQL 保存业务状态，Redis 只用于提交完成后的唤醒通知，源码和编译产物保存在 S3 兼容对象存储。默认本地 Compose 使用 MinIO（S3 兼容）；API 不接收源码二进制流。

提交完成后由 Compile Worker 自动编译 C++23 并执行基础 bot 的红蓝双向资格赛。只有资格赛两场都获胜的提交才会进入 `QUEUED`（资格赛通过、等待正式匹配）。没有其他选手的榜上算法可以对战时（空榜，或榜上只有自己的旧版本）它会直接提升为 `FINISHED`；否则 Scheduler 创建它与其他选手每个榜上算法之间的红蓝交换两场 BO1，所有比赛完成后才提升为 `FINISHED`、替换自己的旧榜上版本并刷新排行榜。重新提交只取消尚未上榜的旧候选版本，榜上版本和战绩在新版本晋级前保持不变。被替换的版本只做软删除，历史提交记录、源码、编译日志和比赛回放继续保留；`GET /submissions` 会向提交者返回全部历史记录（按 `limit`/`offset` 分页），通过 `deleted_at` 和 `is_current` 可以区分历史版本、候选版本和当前榜上版本。

本地默认使用 MinIO，对象写入 `minio_data` 数据卷，`./run.sh down/restart` 不会清除（LocalStack 社区版不支持持久化，因此已替换）。PostgreSQL 中的提交、比赛和回放数据同样持久化。API 启动时会把 PostgreSQL 备份中缺失的源码和 runner 写回对象存储。源码确认完成后还会在 PostgreSQL artifact 行中保存私有备份，编译 runner 也保存备份；对象存储丢失对象时 Worker 会从数据库备份恢复并写回。生产环境仍应使用带版本控制和多副本的 S3、OSS、COS 等对象存储。

已进入排行榜的算法即使 runner 无法恢复（对象和数据库备份都不存在），也会保留在排行榜中并保持原有战绩；系统不再安排它参加新的对局，所有者需要重新提交。

## 认证

登录接口使用账号密码换取 Bearer 会话令牌，业务接口继续使用 `Authorization: Bearer <token>`。Compose 默认创建管理员账号 `root`，密码为 `416`；生产环境应通过 `ARENA_ADMIN_PASSWORD` 覆盖默认密码。

```http
POST /login
Content-Type: application/json

{"handle":"root","password":"416"}
```

响应中的 `token` 作为后续请求的 Bearer 令牌。密码只以 scrypt 哈希保存，数据库不保存明文密码。

管理员默认账户为 `root / 416`（可使用 `ARENA_ADMIN_HANDLE` 和 `ARENA_ADMIN_PASSWORD` 覆盖）。管理员登录后拥有 `/admin/*` 接口权限；普通用户访问这些接口会返回 `403 admin_required`。

## 管理员接口

```text
GET    /admin/users?limit=50&offset=0
POST   /admin/users
PATCH  /admin/users/{id}
DELETE /admin/users/{id}                 # 禁用账户
GET    /admin/submissions?limit=50&offset=0
DELETE /admin/submissions/{id}           # 软删除算法，保留比赛历史
PUT    /admin/leaderboard/{submissionId} # 设置胜/平/负覆盖
DELETE /admin/leaderboard/{submissionId} # 清除该覆盖
POST   /admin/leaderboard/recalculate
POST   /admin/leaderboard/recalculate?clear_overrides=true
```

创建账户示例：

```json
{"handle":"pilot_01","password":"strong-password","role":"PLAYER"}
```

修改账户可以提交 `password`、`role` 或 `active` 字段。系统不允许禁用或降级最后一个启用的管理员。删除算法只设置 `deleted_at`，不会删除比赛、事件和回放数据。

排行榜覆盖示例：

```json
{"wins":12,"draws":2,"losses":4,"reason":"人工复核"}
```

覆盖只允许作用于当前有效算法，胜率和得分率仍按覆盖后的三项战绩计算。`recalculate` 默认保留覆盖；传入 `clear_overrides=true` 后会清除全部覆盖并完全依据已完成比赛重算。

本地兼容的开发用户仍可通过 `ARENA_DEV_HANDLE` 和 `ARENA_DEV_TOKEN` 自动建立。生产部署应关闭开发用户配置，并在 API 容器中运行：

```bash
node provision_user.js handle-name strong-password
```

命令只把密码明文输出一次，数据库只保存密码哈希。

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
GET /submissions?limit=50&offset=0
GET /submissions/{id}
GET /leaderboard?limit=50&offset=0
GET /leaderboard/{submissionId}
GET /matches?limit=50&offset=0
GET /matches/{id}
GET /matches/{id}/replay
```

比赛进行中可通过网站的 WebSocket 回放连接实时接收事件：

```text
ws(s)://<host>/ws/matches/{id}?after_seq=<last_received_seq>
```

连接会先返回比赛快照，再补发 `after_seq` 之后的 PostgreSQL 事件；比赛结束时发送 `complete`。历史回放响应还会包含对象存储归档的 `archive_url`（若已归档）。

排行榜、比赛和回放接口不需要登录；这些公开接口只返回用户账号、比赛状态和统计数据，不返回算法版本名称。提交列表和提交详情只允许提交所属用户读取，版本名称、编译日志和源码链接仅在该用户的“我的版本”页面可见。历史版本仍可读取详情和正式对抗记录，但不能再次确认上传、进入调度或改变排行榜。所有列表接口限制 `limit <= 100`。

`GET /submissions/{id}` 返回 `submission` 和 `matches`：前者包含本人版本名称、状态、编译日志和正式比赛进度，后者包含该版本的正式对抗记录，包括对手用户名、红蓝方、状态、胜平负、地图种子及回放入口。详情页的胜率和得分率仅统计 `FINISHED` 对局，等待、运行中和运行失败的比赛不计入这两项统计。管理员仍可通过专用管理接口查看和管理算法。

## 状态

提交状态为：

```text
UPLOADED -> COMPILING -> COMPILE_FAILED
                         -> QUEUED（资格赛通过，等待正式匹配）
                         -> FINISHED（已进入排行榜）

正式比赛的 `RUNTIME_FAILED` 记录不会把提交直接标记为失败；它是单场比赛的终态，提交会在全部双向比赛终态后进入 `FINISHED`。
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
