#!/system/bin/sh
# 停止 qsp-mcp HTTP 服务
pkill -f "server.js --http" && echo "qsp-mcp 已停止" || echo "qsp-mcp 未在运行"
