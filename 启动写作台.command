#!/bin/bash
# 双击启动「写作台」。
# 关掉这个终端窗口 = 停止服务。
cd "$(dirname "$0")" || exit 1
echo "正在启动写作台…"
npm run serve
