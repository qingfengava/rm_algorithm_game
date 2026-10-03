# 开发和代码审查流程

## 分支

`main` 只接受通过代码审查的变更。开发分支使用以下命名：

```text
feat/<short-name>
fix/<short-name>
docs/<short-name>
chore/<short-name>
```

分支从最新 `main` 创建，完成后提交 Pull Request。禁止直接向 `main` 推送未审查的功能代码。

## 提交前检查

```bash
./scripts/check.sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DARENA_BUILD_TESTS=ON
cmake --build build --parallel
ctest --test-dir build --output-on-failure
docker compose config --quiet
```

涉及容器或 API 的改动，还应执行：

```bash
docker compose up --build --abort-on-container-exit --exit-code-from test
```

## Pull Request 要求

- 标题说明变更目的。
- 描述中列出行为变化和测试结果。
- 规则、SDK 或回放字段变化必须同步修改 `docs/`。
- 新增规则行为必须增加测试。
- CI 全部通过后才能合并。
- 至少一名维护者审查通过后才能合并。

仓库托管平台上的 `main` 分支应开启分支保护，要求 Pull Request、CI 通过和代码审查后才能合并。远程仓库设置由项目维护者完成。
