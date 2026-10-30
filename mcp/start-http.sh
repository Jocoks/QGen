#!/system/bin/sh
# 启动 qsp-mcp 的 HTTP 服务（默认 127.0.0.1:8790）
# 用法： nohup sh mcp/start-http.sh [端口] >> ~/qsp-mcp.log 2>&1 &
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8790}"
NODE="$(command -v node || true)"
[ -x "$NODE" ] || { echo "找不到 node，请先安装 Node.js 或设置 NODE 环境变量" >&2; exit 1; }
exec "$NODE" "$DIR/server.js" --http "$PORT"
