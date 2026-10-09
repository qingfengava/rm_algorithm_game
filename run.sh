#!/usr/bin/env bash
set -Eeuo pipefail

# One-command local deployment for the arena stack.
# The script intentionally keeps persistent PostgreSQL and Redis volumes when
# stopping services. Use `./run.sh reset` only when local data should be lost.

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose -f "$ROOT_DIR/docker-compose.yml")
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
WAIT_SECONDS="${ARENA_DEPLOY_WAIT_SECONDS:-120}"
BUILD=1

log() {
  printf '[arena] %s\n' "$*"
}

error() {
  printf '[arena] ERROR: %s\n' "$*" >&2
}

usage() {
  cat <<'EOF'
Usage: ./run.sh [options] <command>

Commands:
  up, start       Build and start the complete local service stack (default)
  down            Stop and remove containers, preserving named volumes
  reset           Stop services and delete local database/Redis volumes
  restart         Stop and start the complete stack
  status          Show container and health status
  logs [service]  Follow logs; optionally limit to one Compose service
  test            Run the Compose smoke test
  build           Build all Compose images without starting services

Options:
  --no-build      Reuse existing images for up/start/restart
  --build         Force image builds (default)
  -h, --help      Show this help

Examples:
  ./run.sh
  ./run.sh --no-build up
  ./run.sh logs api
  ./run.sh test
EOF
}

die() {
  error "$*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "未找到命令：$1"
}

prepare_env() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi
  [[ -f "$ENV_EXAMPLE" ]] || die "缺少 .env.example，无法创建本地配置"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  log "已从 .env.example 创建 .env；如需修改端口或密码，请先编辑 .env"
}

check_docker() {
  require_command docker
  docker compose version >/dev/null 2>&1 || die "当前 Docker 未安装 Compose 插件"
  docker info >/dev/null 2>&1 || die "无法连接 Docker daemon，请启动 Docker 并确认当前用户有权限"
}

compose_config() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" config --quiet
}

compose_up() {
  local -a args=(--env-file "$ENV_FILE" up -d)
  if [[ "$BUILD" -eq 1 ]]; then
    args+=(--build)
  fi
  # The test service is intentionally excluded from normal deployment. It is
  # a one-shot smoke test and can be run explicitly with `./run.sh test`.
  args+=(postgres redis minio api scheduler compile-worker match-worker replay-gateway web)
  "${COMPOSE[@]}" "${args[@]}"
}

url_ready() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl --silent --show-error --fail --max-time 3 "$url" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --timeout=3 --output-document=- "$url" >/dev/null 2>&1
  else
    # Docker images are guaranteed to contain Node.js for both endpoints used
    # here, so this fallback does not require curl on the host.
    "${COMPOSE[@]}" --env-file "$ENV_FILE" exec -T api node -e \
      'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' "$url" >/dev/null 2>&1
  fi
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local deadline=$((SECONDS + WAIT_SECONDS))
  log "等待 $label 健康检查：$url"
  while (( SECONDS < deadline )); do
    if url_ready "$url"; then
      log "$label 已就绪"
      return 0
    fi
    sleep 2
  done
  error "$label 在 ${WAIT_SECONDS}s 内未就绪"
  "${COMPOSE[@]}" --env-file "$ENV_FILE" ps >&2 || true
  return 1
}

up() {
  prepare_env
  compose_config || die "Compose 配置校验失败"
  compose_up
  wait_for_url "API" "http://127.0.0.1:8080/health"
  wait_for_url "前端" "http://127.0.0.1:8081/healthz"
  cat <<'EOF'

空域竞技场已启动：
  前端：     http://localhost:8081
  API：      http://localhost:8080/health
  S3：       http://localhost:4566
  管理员：   root / 416

常用命令：
  ./run.sh status
  ./run.sh logs
  ./run.sh test
  ./run.sh down
EOF
}

main() {
  local command="up"
  while (($# > 0)); do
    case "$1" in
      --no-build) BUILD=0; shift ;;
      --build) BUILD=1; shift ;;
      -h|--help) usage; return 0 ;;
      up|start|down|reset|restart|status|logs|test|build)
        command="$1"; shift; break ;;
      *) die "未知参数或命令：$1（使用 --help 查看用法）" ;;
    esac
  done

  prepare_env
  check_docker
  case "$command" in
    up|start)
      (($# == 0)) || die "${command} 不接受额外参数"
      up
      ;;
    down)
      (($# == 0)) || die "down 不接受额外参数"
      "${COMPOSE[@]}" --env-file "$ENV_FILE" down --remove-orphans
      ;;
    reset)
      (($# == 0)) || die "reset 不接受额外参数"
      error "reset 将删除本地 PostgreSQL 和 Redis 数据卷"
      read -r -p "输入 RESET 确认：" confirmation
      [[ "$confirmation" == "RESET" ]] || die "已取消"
      "${COMPOSE[@]}" --env-file "$ENV_FILE" down --remove-orphans --volumes
      ;;
    restart)
      (($# == 0)) || die "restart 不接受额外参数"
      "${COMPOSE[@]}" --env-file "$ENV_FILE" down --remove-orphans
      up
      ;;
    status)
      (($# == 0)) || die "status 不接受额外参数"
      "${COMPOSE[@]}" --env-file "$ENV_FILE" ps
      ;;
    logs)
      local -a log_args=(logs -f --tail="${ARENA_LOG_TAIL:-200}")
      (($# == 0)) || log_args+=("$@")
      "${COMPOSE[@]}" --env-file "$ENV_FILE" "${log_args[@]}"
      ;;
    test)
      (($# == 0)) || die "test 不接受额外参数"
      prepare_env
      compose_config || die "Compose 配置校验失败"
      "${COMPOSE[@]}" --env-file "$ENV_FILE" run --rm test
      ;;
    build)
      (($# == 0)) || die "build 不接受额外参数"
      prepare_env
      compose_config || die "Compose 配置校验失败"
      "${COMPOSE[@]}" --env-file "$ENV_FILE" build
      ;;
  esac
}

main "$@"
