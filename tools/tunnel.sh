#!/usr/bin/env bash
# ============================================================
# Vault Bridge 公网隧道（可选）
#
# 家里/公司 WiFi 直连局域网地址时不需要本脚本。
# 只有「手机用 4G/5G 在外网访问电脑」时才需要它。
#
# 用法：
#   tools/tunnel.sh start    启动隧道并打印公网地址
#   tools/tunnel.sh url      只打印当前公网地址
#   tools/tunnel.sh status   查看运行状态
#   tools/tunnel.sh stop     关闭隧道
#
# 说明：使用 Cloudflare 的免账号快速隧道（quick tunnel），
# 地址形如 https://xxx.trycloudflare.com，是 https，iOS 才允许访问。
# 快速隧道每次重启域名都会变，重启后需在手机上重新填一次地址。
# ============================================================
set -uo pipefail

PORT="${VAULT_BRIDGE_PORT:-8770}"
CLOUDFLARED="${CLOUDFLARED:-$HOME/bin/cloudflared}"
LOG="${TMPDIR:-/tmp}/vault-bridge-tunnel.log"
PIDFILE="${TMPDIR:-/tmp}/vault-bridge-tunnel.pid"
URLFILE="${TMPDIR:-/tmp}/vault-bridge-tunnel.url"

die() { echo "❌ $*" >&2; exit 1; }

is_running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null || echo "")
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  [ -x "$CLOUDFLARED" ] || die "找不到 cloudflared：$CLOUDFLARED（设置 CLOUDFLARED 环境变量指定路径）"
  if is_running; then
    echo "隧道已在运行：$(cat "$URLFILE" 2>/dev/null || echo '地址获取中')"
    return 0
  fi

  echo "▶ 正在建立隧道 → http://localhost:$PORT"
  : > "$LOG"
  # --protocol http2 在 UDP 受限的网络里更稳
  nohup "$CLOUDFLARED" tunnel --url "http://localhost:$PORT" \
    --no-autoupdate --protocol http2 > "$LOG" 2>&1 &
  echo $! > "$PIDFILE"

  local url="" i
  for i in $(seq 1 40); do
    sleep 2
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
    if [ -n "$url" ] && grep -q "Registered tunnel connection" "$LOG" 2>/dev/null; then
      break
    fi
    if ! is_running; then
      echo "❌ 隧道进程已退出，日志尾部："
      tail -15 "$LOG"
      rm -f "$PIDFILE"
      exit 1
    fi
  done

  if [ -z "$url" ]; then
    echo "❌ 未能取得公网地址，日志尾部："
    tail -15 "$LOG"
    exit 1
  fi

  echo "$url" > "$URLFILE"
  echo
  echo "✅ 公网地址：$url"
  echo
  echo "在手机 Obsidian 的 Vault Bridge 面板里把「电脑地址」改成上面的地址，"
  echo "令牌保持不变即可在外网使用。"
  echo
  echo "提示：本机若装了 VPN（如 aTrust），本机可能解析不了这个域名，"
  echo "      这不影响手机访问——手机用的是自己的网络与 DNS。"
}

cmd_stop() {
  if is_running; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    sleep 1
    echo "✅ 隧道已关闭"
  else
    echo "隧道未在运行"
  fi
  rm -f "$PIDFILE" "$URLFILE"
}

cmd_url() {
  if is_running; then
    cat "$URLFILE" 2>/dev/null || echo "(地址获取中)"
  else
    echo "(隧道未运行)"
  fi
}

cmd_status() {
  if is_running; then
    echo "✅ 运行中  PID=$(cat "$PIDFILE")"
    echo "   公网地址：$(cat "$URLFILE" 2>/dev/null || echo '获取中')"
    echo "   本地端口：$PORT"
  else
    echo "⏹  未运行"
  fi
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  url) cmd_url ;;
  *) echo "用法：$0 {start|stop|status|url}"; exit 1 ;;
esac
