#!/usr/bin/env python3
"""One terminal owns the radio host and any services it starts on macOS."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
RUN = ROOT / '.radio-preview'


def say(message):
    print(message, flush=True)


def read_record(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def finish(process):
    if process is None or process.poll() is not None:
        return
    # Give the host a chance to cancel queued speech and leave radio mode.
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=12)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def interrupted(_signum, _frame):
    raise KeyboardInterrupt


def choose_player_mode():
    say('请选择播放器启动方式：')
    say('  1. 完整播放器（默认）')
    say('  2. 迷你电台')
    say('  3. 不启动客户端，仅连接已运行的播放器')
    say('  已运行的播放器会复用当前窗口；界面选择对新启动的窗口生效。')
    say('  q. 取消')
    while True:
        try:
            answer = input('选择 [1/2/3/q，回车选 1]：').strip().lower()
        except EOFError:
            return None
        if answer in ('', '1'):
            return 'full'
        if answer == '2':
            return 'mini'
        if answer == '3':
            return 'existing'
        if answer == 'q':
            return None
        say('请输入 1、2、3 或 q。')


def player_executable():
    electron_dir = ROOT / 'node_modules/electron'
    try:
        electron = electron_dir / 'dist' / (electron_dir / 'path.txt').read_text().strip()
    except OSError:
        raise RuntimeError('缺少 Electron 依赖，请先在播放器项目执行 npm install。') from None
    for path in (electron, ROOT / 'dist/main.js', ROOT / 'dist/renderer.js'):
        if not path.exists():
            raise RuntimeError(f'缺少启动文件：{path}')
    return electron


def launch(miniagent, check=False, player_mode='full'):
    python = miniagent / '.venv/bin/python'
    controller = miniagent / 'scripts/local_tts.py'
    for path in (python, controller, miniagent / 'radio.toml'):
        if not path.exists():
            raise RuntimeError(f'缺少启动文件：{path}')

    sys.path.insert(0, str(miniagent))
    from miniagent.tools import _lx_mcp as mcp
    from miniagent.speech import load_speech_config, speech_ffmpeg
    speech_config = load_speech_config()
    if speech_config.normalize_lufs is not None or speech_config.tail_tempo < 1 or speech_config.tail_pause or speech_config.speed != 1:
        speech_ffmpeg()
    # Reuse the service controller's status probe and ownership record.
    import importlib.util
    spec = importlib.util.spec_from_file_location('radio_local_tts', controller)
    tts = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tts)

    if check:
        if player_mode in ('full', 'mini'):
            player_executable()
        say('启动文件检查通过。')
        mode_labels = {'full': '完整播放器', 'mini': '迷你电台', 'existing': '仅连接已有播放器'}
        say(f'播放器模式：{mode_labels[player_mode]}')
        say(f'播放器 MCP：{mcp.MCP_URL}（{"在线" if mcp.alive() else "未启动"}）')
        say(f'本地 TTS：{"在线" if tts.status() is not None else "未启动"}')
        return 0

    RUN.mkdir(parents=True, exist_ok=True)
    # flock is released by the OS even after a crash; never unlink the lock file.
    with (RUN / 'launcher.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            say('电台启动脚本已经在运行，请回到原来的终端窗口。')
            return 0

        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, interrupted)
        player = child = None
        previous_tts_record = read_record(tts.PIDFILE)
        tts_starting = False
        owned_tts_record = None
        try:
            if player_mode == 'ask':
                player_mode = choose_player_mode()
                if player_mode is None:
                    say('已取消启动。')
                    return 0
            say('🎙 正在启动音乐电台…')
            if mcp.alive():
                say('播放器已经运行，复用当前窗口；所选界面模式仅对新启动的窗口生效。')
            else:
                if player_mode == 'existing':
                    raise RuntimeError(
                        f'选择了不启动客户端，但没有可用的播放器 MCP：{mcp.MCP_URL}\n'
                        '当前音乐播放、主持人口播混音和音量渐变仍依赖播放器。\n'
                        '请先打开播放器并启用 MCP，或重新启动脚本选择 1 或 2。'
                    )
                electron = player_executable()
                say('打开播放器，等待 MCP 服务就绪…')
                env = dict(os.environ)
                env.pop('ELECTRON_RUN_AS_NODE', None)
                with (RUN / 'launcher-player.log').open('ab') as log:
                    player_command = [str(electron), str(ROOT / 'scripts/radio-preview.cjs')]
                    if player_mode == 'mini':
                        player_command.append('--mini-player')
                    player = subprocess.Popen(
                        player_command,
                        cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                        stdout=log, stderr=log, start_new_session=True,
                    )
                deadline = time.monotonic() + 45
                while not mcp.alive():
                    if player.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError(
                            f'播放器 MCP 尚未就绪：{mcp.MCP_URL}\n'
                            '请在播放器设置中启用 MCP，端口与 miniagent/radio.toml 一致。\n'
                            f'播放器日志：{RUN / "launcher-player.log"}'
                        )
                    time.sleep(1)
            # The HTTP server can be ready before the renderer's tools are ready.
            deadline = time.monotonic() + 45
            while True:
                try:
                    state = mcp.get_radio_state()
                    if 'enabled' not in state:
                        raise RuntimeError('播放器没有返回电台状态')
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('播放器电台工具尚未就绪，请检查源码构建和 MCP 设置。') from None
                    time.sleep(1)

            tts_starting = True
            say('准备本地 TTS 和主持人声音，首次加载需要稍等…')
            child = subprocess.Popen([str(python), '-u', str(controller), 'start'],
                                     cwd=miniagent, start_new_session=True)
            result = child.wait()
            current_record = read_record(tts.PIDFILE)
            if current_record != previous_tts_record:
                owned_tts_record = current_record
            tts_starting = False
            if result != 0:
                raise RuntimeError(f'TTS 启动失败，请检查 {tts.LOG}')
            child = None

            say('\n服务已就绪。请输入节目主题；输入 exit 或按 Ctrl+C 收工。\n')
            child = subprocess.Popen([str(python), '-u', '-m', 'miniagent', '--radio'],
                                     cwd=miniagent, start_new_session=True)
            while True:
                try:
                    return child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    if player is not None and player.poll() is not None:
                        say('播放器已关闭，电台收工。')
                        finish(child)
                        return 0
        except KeyboardInterrupt:
            say('\n正在收工…')
            return 0
        finally:
            # Closing Terminal sends SIGHUP; cleanup must not be interrupted again.
            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(sig, signal.SIG_IGN)
            finish(child)
            current_record = read_record(tts.PIDFILE)
            if tts_starting and current_record != previous_tts_record:
                owned_tts_record = current_record
            if owned_tts_record is not None and current_record == owned_tts_record:
                say('关闭本次启动的 TTS，释放模型内存…')
                try:
                    subprocess.run([str(python), str(controller), 'stop'], cwd=miniagent,
                                   timeout=15, check=False)
                except (OSError, subprocess.TimeoutExpired) as exc:
                    say(f'TTS 停止未完成，请手动执行 local_tts.py stop：{exc}')
            if player is not None and player.poll() is None:
                say('关闭本次启动的播放器…')
                finish(player)
            say('电台启动脚本已退出。原先已运行的服务继续保留。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--miniagent-dir', type=Path,
                        default=Path(os.environ.get('RADIO_MINIAGENT_DIR', ROOT.parent / 'miniagent')))
    parser.add_argument('--check', action='store_true', help='只检查启动文件和服务状态')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--full-player', '--start-player', dest='player_mode', action='store_const', const='full',
                       help='启动完整播放器；已运行时复用，不显示选择菜单')
    modes.add_argument('--mini-player', dest='player_mode', action='store_const', const='mini',
                       help='启动迷你电台；已运行时复用，不显示选择菜单')
    modes.add_argument('--no-player', dest='player_mode', action='store_const', const='existing',
                       help='不启动 Electron，仅连接已运行的播放器 MCP')
    args = parser.parse_args()
    try:
        mode = args.player_mode or ('ask' if sys.stdin.isatty() and not args.check else 'full')
        return launch(args.miniagent_dir.expanduser().resolve(), args.check, mode)
    except Exception as exc:
        print(f'启动失败：{exc}', file=sys.stderr, flush=True)
        if sys.stdin.isatty():
            try:
                input('按回车关闭窗口…')
            except (EOFError, KeyboardInterrupt):
                pass
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
