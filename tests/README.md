# Tests

`tests/cpp/` 保存 C++ 单元和集成测试，`tests/smoke.js` 验证本地 Compose 服务。

`tests/security/sandbox_acceptance.sh` 是容器级安全验收，需要 rootless
Podman 或 Docker 以及已构建的 Worker 镜像；它不属于默认 CTest，因为会创建并销毁容器。

阶段 5 的本地路由测试由 `npm --prefix services/api test` 执行；真实 PostgreSQL
持久化由 `npm --prefix services/api run test:integration` 验证，MinIO 预签名上传、下载
和 API 重启后的记录恢复由 `node tests/api_integration.js` 验证。
