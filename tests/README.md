# Tests

`tests/cpp/` 保存 C++ 单元和集成测试，`tests/smoke.js` 验证本地 Compose 服务。

`tests/security/sandbox_acceptance.sh` 是容器级安全验收，需要 rootless
Podman 或 Docker 以及已构建的 Worker 镜像；它不属于默认 CTest，因为会创建并销毁容器。
