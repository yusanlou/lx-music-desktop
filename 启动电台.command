#!/bin/zsh
# Finder 双击和终端执行都使用项目里的 Python，不依赖终端的 PATH。
PROJECT_DIR="${0:A:h}"
MINIAGENT_DIR="${RADIO_MINIAGENT_DIR:-${PROJECT_DIR:h}/miniagent}"
PYTHON="${MINIAGENT_DIR}/.venv/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  print -u2 "找不到 miniagent 的 Python 环境：$PYTHON"
  print -u2 "请检查 miniagent 是否和播放器放在同一父目录。"
  read "?按回车关闭窗口…"
  exit 1
fi

exec "$PYTHON" "$PROJECT_DIR/scripts/start-radio.py" --miniagent-dir "$MINIAGENT_DIR" "$@"
