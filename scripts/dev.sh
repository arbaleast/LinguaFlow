#!/usr/bin/env bash
# LinguaFlow 本地开发环境一键脚本
#
#   ./scripts/dev.sh start     启动后端(18080) + 前端 Vite(5173)，并做端到端校验
#   ./scripts/dev.sh stop      停止两者
#   ./scripts/dev.sh restart   重启两者
#   ./scripts/dev.sh status    查看运行状态
#   ./scripts/dev.sh logs      跟踪两边日志
#   ./scripts/dev.sh local     构建前端并嵌入后端，单端口(18080)生产式预览
#   ./scripts/dev.sh ssh       打印 SSH 端口转发命令
#
# 说明：
#   - 后端使用 local 模式：自动本地管理员登录、SQLite 落在 .tooling/data。
#   - 前端 Vite 把 /api 代理到后端，浏览器侧保持同源，避免 local 模式仅放行
#     自身端口的 CORS 限制；后端地址可用 LINGUAFLOW_API_TARGET 覆盖。
#   - 端口被别的程序占用时自动顺延到下一个空闲端口（数据目录也随之隔离），
#     并在输出里说明实际端口；端口上若是 LinguaFlow 自己的实例则直接复用。
#   - 停止时按 PID 与端口双重定位：只有确认端口上跑的是 LinguaFlow 才动手，
#     不会误伤同端口的其他程序。
#   - Go 工具链优先复用 PATH，其次复用 .tooling/go，都没有则自动下载到 .tooling/go。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.tooling"
LOG_DIR="$TOOLS/logs"
BACKEND_PID_FILE="$TOOLS/backend.pid"
FRONTEND_PID_FILE="$TOOLS/frontend.pid"

BACKEND_PORT_WANTED="${LINGUAFLOW_BACKEND_PORT:-18080}"
FRONTEND_PORT_WANTED="${LINGUAFLOW_FRONTEND_PORT:-5173}"
FRONTEND_HOST="${LINGUAFLOW_FRONTEND_HOST:-127.0.0.1}"
# 显式指定时按用户给定的地址代理；否则在后端端口确定后再推导。
API_TARGET="${LINGUAFLOW_API_TARGET:-}"
GO_VERSION="${LINGUAFLOW_GO_VERSION:-1.27.3}"

# 实际使用的端口，启动时按占用情况调整。
BACKEND_PORT="$BACKEND_PORT_WANTED"
FRONTEND_PORT="$FRONTEND_PORT_WANTED"

log() { printf '\033[36m[dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[dev]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[dev]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------- Go 工具链

go_binary() {
  if [ -n "${LINGUAFLOW_GO:-}" ] && [ -x "$LINGUAFLOW_GO" ]; then
    printf '%s' "$LINGUAFLOW_GO"
    return 0
  fi
  if command -v go >/dev/null 2>&1; then
    command -v go
    return 0
  fi
  if [ -x "$TOOLS/go/bin/go" ]; then
    printf '%s' "$TOOLS/go/bin/go"
    return 0
  fi
  return 1
}

ensure_go() {
  local go_bin
  if ! go_bin="$(go_binary)"; then
    local os arch
    case "$(uname -s)" in
      Linux) os=linux ;;
      Darwin) os=darwin ;;
      *) err "不支持的操作系统：$(uname -s)"; return 1 ;;
    esac
    case "$(uname -m)" in
      x86_64 | amd64) arch=amd64 ;;
      arm64 | aarch64) arch=arm64 ;;
      *) err "不支持的 CPU 架构：$(uname -m)"; return 1 ;;
    esac
    log "未找到 Go，正在下载 go${GO_VERSION}.${os}-${arch} ..."
    mkdir -p "$TOOLS"
    curl -fsSL --retry 5 --retry-delay 3 \
      -o "$TOOLS/go.tgz" "https://dl.google.com/go/go${GO_VERSION}.${os}-${arch}.tar.gz"
    rm -rf "$TOOLS/go"
    tar -xzf "$TOOLS/go.tgz" -C "$TOOLS"
    go_bin="$TOOLS/go/bin/go"
  fi

  export GOROOT="$(cd "$(dirname "$go_bin")/.." && pwd)"
  export GOPATH="$TOOLS/gopath"
  export GOMODCACHE="$TOOLS/gomodcache"
  export GOCACHE="$TOOLS/gocache"
  export PATH="$GOROOT/bin:$PATH"
  mkdir -p "$GOPATH" "$GOMODCACHE" "$GOCACHE"
  GO_BIN="$go_bin"
  export GO_BIN
}

# ---------------------------------------------------------------- 进程管理

pid_of() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(awk 'NR == 1 { print $1 }' "$file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  printf '%s' "$pid"
}

# pid 文件里同时记着端口：PID 在别的会话里可能看不见，端口则是共享可用的。
port_of() {
  local file="$1" fallback="$2" port
  [ -f "$file" ] || {
    printf '%s' "$fallback"
    return 0
  }
  port="$(awk 'NR == 1 { print $2 }' "$file" 2>/dev/null || true)"
  printf '%s' "${port:-$fallback}"
}

is_running() {
  local file="$1" pid
  pid="$(pid_of "$file")" || return 1
  kill -0 "$pid" 2>/dev/null
}

# PID 可能被系统回收复用，停止前确认它确实是目标进程。
pid_matches() {
  local pid="$1" pattern="$2"
  [ -n "$pattern" ] || return 0
  [ -r "/proc/$pid/cmdline" ] || return 0
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$pattern"
}

# 以独立进程组启动后台进程，pid 文件记录组长 PID 与端口，便于整组结束与跨会话识别。
spawn() {
  local pid_file="$1" log_file="$2" port="$3"
  shift 3
  setsid bash -c 'echo "$$ $2" > "$1"; shift 2; exec "$@"' _ "$pid_file" "$port" "$@" \
    >>"$log_file" 2>&1 &
}

stop_process() {
  local name="$1" pid_file="$2" expect="$3" pid
  if ! pid="$(pid_of "$pid_file")"; then
    log "$name 未在运行"
    rm -f "$pid_file"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    log "$name 未在运行（清理陈旧 pid 文件）"
    rm -f "$pid_file"
    return 0
  fi
  if ! pid_matches "$pid" "$expect"; then
    warn "$name 的 pid $pid 已被其他进程占用，跳过停止"
    rm -f "$pid_file"
    return 0
  fi
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  log "已停止 $name (pid $pid)"
}

# ---------------------------------------------------------------- 健康检查

# 端口是否已被占用（不区分占用者是谁）。
port_in_use() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && exec 3<&- 3>&- && return 0
  return 1
}

# 从起始端口往后找一个空闲端口。
find_free_port() {
  local port="$1" tries="${2:-20}" i
  for ((i = 0; i < tries; i++)); do
    if ! port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  return 1
}

# 端口上的服务是不是我们自己的后端（而不是恰好同端口的别的程序）。
backend_is_ours() {
  local port="$1" body
  body="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/v1/ping" 2>/dev/null || true)"
  case "$body" in
    *'"service":"linguaflow"'*) return 0 ;;
  esac
  return 1
}

# 端口上的服务是不是我们的开发服务器（首页 + /api 代理都对得上）。
frontend_is_ours() {
  local port="$1" body
  body="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/v1/mode" 2>/dev/null || true)"
  case "$body" in
    *'"mode":"local"'* | *'"mode":"server"'*) return 0 ;;
  esac
  return 1
}

# 找出监听指定端口的进程：优先按命令行参数匹配（我们拉起的进程都带 --port），
# 退化到 /proc socket inode 反查（受限沙箱里 /proc/PID/fd 可能不可读）。
port_listener_pid() {
  local port="$1" p c inode pid hex
  for p in /proc/[0-9]*; do
    [ "$p" = "/proc/$$" ] && continue
    c="$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null)" || continue
    case "$c" in
      *linguaflow* | *vite*) ;;
      *) continue ;;
    esac
    case "$c" in
      *"--port $port "*)
        basename "$p"
        return 0
        ;;
    esac
  done

  hex="$(printf '%04X' "$port")"
  inode="$(awk -v h=":$hex" '$4 == "0A" && $2 ~ h { print $10; exit }' /proc/net/tcp 2>/dev/null)"
  if [ -z "$inode" ]; then
    inode="$(awk -v h=":$hex" '$4 == "0A" && $2 ~ h { print $10; exit }' /proc/net/tcp6 2>/dev/null)"
  fi
  [ -n "$inode" ] || return 1
  for pid in /proc/[0-9]*; do
    if ls -l "$pid/fd" 2>/dev/null | grep -q "socket:\[$inode\]"; then
      basename "$pid"
      return 0
    fi
  done
  return 1
}

# 启动失败时收拾干净：结束残留进程并清掉 pid 文件，避免下次误判"已在运行"。
cleanup_failed() {
  local pid_file="$1" pid
  pid="$(pid_of "$pid_file")" || {
    rm -f "$pid_file"
    return 0
  }
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  sleep 0.3
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pid_file"
}

wait_for_http() {
  local url="$1" timeout="${2:-60}" started
  started=$(date +%s)
  while [ "$(( $(date +%s) - started ))" -lt "$timeout" ]; do
    if curl -fsS --max-time 2 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# ---------------------------------------------------------------- 启动

build_backend() {
  log "构建后端二进制 ..."
  (cd "$ROOT/backend" && "$GO_BIN" build -o "$TOOLS/linguaflow-dev" ./cmd/linguaflow)
  log "后端构建完成"
}

# 决定后端用哪个端口，并设置数据目录。
# 返回 0 表示可以自己启动；BACKEND_REUSED=1 表示已有实例可直接复用。
resolve_backend_port() {
  BACKEND_DATA_DIR="$TOOLS/data"
  BACKEND_REUSED=0
  if ! port_in_use "$BACKEND_PORT"; then
    return 0
  fi
  if backend_is_ours "$BACKEND_PORT"; then
    warn "端口 $BACKEND_PORT 上已有 LinguaFlow 后端在运行，直接复用"
    warn "如需跑最新代码，请先停掉它，或用 LINGUAFLOW_BACKEND_PORT 换端口"
    BACKEND_REUSED=1
    return 0
  fi
  # 端口被别的程序占用：换端口，同时换数据目录（同一数据目录不允许两个实例并存，
  # 否则新实例会以 storage_generation_conflict 退出）。
  local free
  if ! free="$(find_free_port $((BACKEND_PORT + 1)))"; then
    err "端口 $BACKEND_PORT 被其他程序占用，且找不到空闲端口"
    return 1
  fi
  warn "端口 $BACKEND_PORT 被其他程序占用，改用 $free"
  BACKEND_PORT="$free"
  BACKEND_DATA_DIR="$TOOLS/data-$free"
  return 0
}

# 决定前端用哪个端口。BACKEND_REUSED 同理。
resolve_frontend_port() {
  FRONTEND_REUSED=0
  if ! port_in_use "$FRONTEND_PORT"; then
    return 0
  fi
  if frontend_is_ours "$FRONTEND_PORT"; then
    warn "端口 $FRONTEND_PORT 上已有开发服务器在运行，直接复用"
    warn "如需跑最新代码，请先停掉它，或用 LINGUAFLOW_FRONTEND_PORT 换端口"
    FRONTEND_REUSED=1
    return 0
  fi
  local free
  if ! free="$(find_free_port $((FRONTEND_PORT + 1)))"; then
    err "端口 $FRONTEND_PORT 被其他程序占用，且找不到空闲端口"
    return 1
  fi
  warn "端口 $FRONTEND_PORT 被其他程序占用，改用 $free"
  FRONTEND_PORT="$free"
  return 0
}

start_backend() {
  if is_running "$BACKEND_PID_FILE"; then
    log "后端已在运行 (pid $(pid_of "$BACKEND_PID_FILE"))"
    return 0
  fi
  resolve_backend_port || return 1
  if [ "$BACKEND_REUSED" = 1 ]; then
    return 0
  fi

  mkdir -p "$LOG_DIR" "$BACKEND_DATA_DIR"
  : >"$LOG_DIR/backend.log"
  spawn "$BACKEND_PID_FILE" "$LOG_DIR/backend.log" "$BACKEND_PORT" \
    "$TOOLS/linguaflow-dev" local --no-browser --port "$BACKEND_PORT" --data-dir "$BACKEND_DATA_DIR"

  if ! wait_for_http "http://127.0.0.1:$BACKEND_PORT/api/v1/ping" 60; then
    err "后端启动失败，日志尾部："
    tail -n 30 "$LOG_DIR/backend.log" >&2 || true
    cleanup_failed "$BACKEND_PID_FILE"
    return 1
  fi
  if ! is_running "$BACKEND_PID_FILE"; then
    err "后端进程已退出（日志尾部），常见原因：数据目录被另一个实例占用"
    tail -n 30 "$LOG_DIR/backend.log" >&2 || true
    cleanup_failed "$BACKEND_PID_FILE"
    return 1
  fi
  log "后端就绪 http://127.0.0.1:$BACKEND_PORT"
}

ensure_node_modules() {
  if [ ! -x "$ROOT/frontend/node_modules/.bin/vite" ]; then
    log "安装前端依赖 ..."
    (cd "$ROOT/frontend" && pnpm install)
  fi
}

start_frontend() {
  if is_running "$FRONTEND_PID_FILE"; then
    log "前端已在运行 (pid $(pid_of "$FRONTEND_PID_FILE"))"
    return 0
  fi
  resolve_frontend_port || return 1
  if [ "$FRONTEND_REUSED" = 1 ]; then
    return 0
  fi

  ensure_node_modules
  mkdir -p "$LOG_DIR"
  # VITE_DEVTOOLS_DISABLE_CLIENT_AUTH=true：关闭 Vite DevTools 的 otp 客户端配对门禁，
  # 避免每次开 DevTools 都要去终端抄 6 位验证码；本地/SSH 隧道场景足够安全。
  : >"$LOG_DIR/frontend.log"
  # 必须在 frontend/ 下启动：Vite 以进程 cwd 作为站点根目录。
  (cd "$ROOT/frontend" && LINGUAFLOW_API_TARGET="$API_TARGET" \
    VITE_DEVTOOLS_DISABLE_CLIENT_AUTH=true \
    spawn "$FRONTEND_PID_FILE" "$LOG_DIR/frontend.log" "$FRONTEND_PORT" \
    "$ROOT/frontend/node_modules/.bin/vite" --host "$FRONTEND_HOST" --port "$FRONTEND_PORT" --strictPort)

  if ! wait_for_http "http://$FRONTEND_HOST:$FRONTEND_PORT/" 90; then
    err "前端启动失败，日志尾部："
    tail -n 30 "$LOG_DIR/frontend.log" >&2 || true
    cleanup_failed "$FRONTEND_PID_FILE"
    return 1
  fi
  if ! is_running "$FRONTEND_PID_FILE"; then
    err "前端进程已退出（日志尾部）"
    tail -n 30 "$LOG_DIR/frontend.log" >&2 || true
    cleanup_failed "$FRONTEND_PID_FILE"
    return 1
  fi
  log "前端就绪 http://$FRONTEND_HOST:$FRONTEND_PORT"
}

# 端到端校验：浏览器实际走的就是这条路径（前端同源 -> Vite 代理 -> 后端）。
verify_stack() {
  local mode
  mode="$(curl -fsS --max-time 5 "http://$FRONTEND_HOST:$FRONTEND_PORT/api/v1/mode" 2>/dev/null || true)"
  case "$mode" in
    *'"local"'*)
      log "开发代理已生效：$FRONTEND_HOST:$FRONTEND_PORT/api/v1 -> $API_TARGET"
      ;;
    *)
      err "开发代理未生效：/api/v1/mode 返回 '$mode'"
      err "前端将无法自动连接后端，请检查 Vite 代理配置与 LINGUAFLOW_API_TARGET"
      return 1
      ;;
  esac
}

cmd_start() {
  ensure_go
  build_backend
  start_backend
  # 后端端口可能因占用而调整，代理目标随后端走。
  API_TARGET="${API_TARGET:-http://127.0.0.1:$BACKEND_PORT}"
  start_frontend
  verify_stack
  echo
  log "开发环境已就绪"
  echo "  前端 (Vite)  http://$FRONTEND_HOST:$FRONTEND_PORT"
  echo "  后端 (API)   http://127.0.0.1:$BACKEND_PORT/api/v1"
  echo "  日志          $LOG_DIR/backend.log / $LOG_DIR/frontend.log"
  echo "  停止          $0 stop"
  echo
  echo "  提示：服务连接页请保留默认的相对地址 /api/v1，填绝对地址会被跨域拦截"
  echo "  远程访问      $0 ssh <用户>@<主机>"
}

# 生成 SSH 端口转发命令：端口按当前实际使用的取值。
# 用法：dev.sh ssh [用户@主机] [本地端口]
# 本地端口可与远端不同（例如本地 5173 已被占用时，用 15173 转发远端 5173）。
cmd_ssh() {
  local target="${1:-}" local_port="${2:-}"
  local frontend_port backend_port cmd lf lb
  frontend_port="$(port_of "$FRONTEND_PID_FILE" "$FRONTEND_PORT_WANTED")"
  backend_port="$(port_of "$BACKEND_PID_FILE" "$BACKEND_PORT_WANTED")"
  if [ -n "$local_port" ]; then
    lf="$local_port"
    lb="$((local_port + 1))"
  else
    lf="$frontend_port"
    lb="$backend_port"
  fi
  cmd="ssh -N -L $lf:127.0.0.1:$frontend_port -L $lb:127.0.0.1:$backend_port"
  if [ -n "$target" ]; then
    cmd="$cmd $target"
  else
    cmd="$cmd <用户>@<主机>"
  fi
  printf '%s\n' "$cmd"
  echo
  echo "  在本地浏览器打开 http://localhost:$lf"
  echo "  （本地端口可改：$0 ssh ${target:-用户@主机} 15173）"
  echo "  远端端口：前端 $frontend_port，后端 $backend_port"
  echo "  先在远端跑 $0 start，否则隧道通了也没有服务响应"
  echo "  用 localhost / 127.0.0.1 访问才能保留安全上下文；"
  echo "  若要用自定义主机名，启动时加 LINGUAFLOW_DEV_HOSTS=<主机名> 让 Vite 放行"
}

cmd_stop() {
  stop_process "前端" "$FRONTEND_PID_FILE" "vite"
  stop_process "后端" "$BACKEND_PID_FILE" "linguaflow"
  # pid 文件可能来自别的会话（PID 不可见），退回到按端口停止；
  # 只有确认端口上跑的是 LinguaFlow 自己的服务才会动手，绝不误伤其他程序。
  stop_by_port "前端" "$(port_of "$FRONTEND_PID_FILE" "$FRONTEND_PORT_WANTED")" frontend_is_ours
  stop_by_port "后端" "$(port_of "$BACKEND_PID_FILE" "$BACKEND_PORT_WANTED")" backend_is_ours
  stop_by_port "前端" "$FRONTEND_PORT" frontend_is_ours
  stop_by_port "后端" "$BACKEND_PORT" backend_is_ours
}

# 按端口停止：先确认身份，再找到监听进程并结束它。
stop_by_port() {
  local name="$1" port="$2" identity="$3" pid
  port_in_use "$port" || return 0
  if ! "$identity" "$port"; then
    warn "端口 $port 上不是 LinguaFlow 的服务，未做任何处理"
    return 0
  fi
  pid="$(port_listener_pid "$port")" || {
    warn "端口 $port 上的 LinguaFlow 服务无法定位进程（可能属于其他会话）"
    return 0
  }
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  log "已按端口停止 $name (pid $pid, 端口 $port)"
}

print_state() {
  local name="$1" pid_file="$2" url="$3" port="$4" identity="$5"
  if is_running "$pid_file"; then
    printf '  %s  运行中 (pid %s)' "$name" "$(pid_of "$pid_file")"
    if curl -fsS --max-time 2 -o /dev/null "$url" 2>/dev/null; then
      printf '  健康检查通过\n'
    else
      printf '  健康检查失败\n'
    fi
  elif port_in_use "$port"; then
    # 端口有人占，但不是本脚本拉起的：区分"别的 LinguaFlow 实例"和"完全无关的程序"。
    if "$identity" "$port"; then
      printf '  %s  由其他 LinguaFlow 实例提供（端口 %s，本脚本未持有）\n' "$name" "$port"
    else
      printf '  %s  端口 %s 被其他程序占用（非 LinguaFlow）\n' "$name" "$port"
    fi
  else
    printf '  %s  未运行\n' "$name"
  fi
}

cmd_status() {
  local backend_port frontend_port
  backend_port="$(port_of "$BACKEND_PID_FILE" "$BACKEND_PORT_WANTED")"
  frontend_port="$(port_of "$FRONTEND_PID_FILE" "$FRONTEND_PORT_WANTED")"
  print_state "后端" "$BACKEND_PID_FILE" "http://127.0.0.1:$backend_port/api/v1/ping" "$backend_port" backend_is_ours
  print_state "前端" "$FRONTEND_PID_FILE" "http://$FRONTEND_HOST:$frontend_port/" "$frontend_port" frontend_is_ours
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  touch "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log"
  tail -n 100 -f "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log"
}

# 生产式预览：前端构建产物嵌入后端，单端口对外提供完整应用。
cmd_local() {
  ensure_go
  ensure_node_modules
  log "构建前端 ..."
  (cd "$ROOT/frontend" && "$ROOT/frontend/node_modules/.bin/vite" build)

  local dist="$ROOT/backend/internal/web/dist" backup
  backup="$(mktemp -d)"
  cp -r "$dist" "$backup/dist"
  # 构建失败也要还原被跟踪的占位文件，避免污染工作区。
  trap 'rm -rf "$dist"; cp -r "$backup/dist" "$dist"; rm -rf "$backup"' RETURN
  log "嵌入前端产物并构建后端 ..."
  rm -rf "$dist"
  cp -r "$ROOT/frontend/dist" "$dist"
  (cd "$ROOT/backend" && "$GO_BIN" build -o "$TOOLS/linguaflow-local" ./cmd/linguaflow)
  rm -rf "$dist"
  cp -r "$backup/dist" "$dist"
  rm -rf "$backup"
  trap - RETURN

  stop_process "前端" "$FRONTEND_PID_FILE" "vite"
  stop_process "后端" "$BACKEND_PID_FILE" "linguaflow"
  stop_by_port "前端" "$FRONTEND_PORT" frontend_is_ours
  stop_by_port "后端" "$BACKEND_PORT" backend_is_ours

  resolve_backend_port || return 1
  if [ "$BACKEND_REUSED" = 1 ]; then
    log "已有 LinguaFlow 后端在运行，直接复用 http://127.0.0.1:$BACKEND_PORT"
    return 0
  fi
  mkdir -p "$LOG_DIR" "$BACKEND_DATA_DIR"
  : >"$LOG_DIR/backend.log"
  spawn "$BACKEND_PID_FILE" "$LOG_DIR/backend.log" "$BACKEND_PORT" \
    "$TOOLS/linguaflow-local" local --no-browser --port "$BACKEND_PORT" --data-dir "$BACKEND_DATA_DIR"
  if wait_for_http "http://127.0.0.1:$BACKEND_PORT/api/v1/ping" 60; then
    log "单端口预览就绪 http://127.0.0.1:$BACKEND_PORT"
  else
    err "启动失败，日志尾部："
    tail -n 30 "$LOG_DIR/backend.log" >&2 || true
    return 1
  fi
}

usage() {
  # 打印文件头部的注释块作为帮助信息。
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart)
    cmd_stop
    cmd_start
    ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  local) cmd_local ;;
  ssh) cmd_ssh "${2:-}" "${3:-}" ;;
  -h | --help | help) usage ;;
  *)
    err "未知命令：$1"
    usage
    exit 1
    ;;
esac
