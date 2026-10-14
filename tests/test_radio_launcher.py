"""Lifecycle regressions: reuse, startup rollback and service ownership."""
import fcntl
import importlib.util
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
MINIAGENT = ROOT.parent / 'miniagent'
sys.path.insert(0, str(MINIAGENT))
from miniagent.tools import _lx_mcp as mcp

spec = importlib.util.spec_from_file_location('radio_launcher', ROOT / 'scripts/start-radio.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.run = Path(self.temporary.name)
        self.patches = [
            patch.object(launcher, 'RUN', self.run),
            patch.object(launcher, 'say'),
            patch.object(launcher.signal, 'signal'),
            patch.object(mcp, 'alive', return_value=True),
            patch.object(mcp, 'get_radio_state', return_value={'enabled': False}),
            patch.object(launcher, 'finish'),
            patch.object(launcher.subprocess, 'run'),
        ]
        self.mocks = [p.start() for p in self.patches]
        for p in self.patches:
            self.addCleanup(p.stop)
        self.stop_service = self.mocks[-1]
        self.old = {'pid': 1, 'started_at': 100}
        self.owned = {'pid': 2, 'started_at': 200}

    def execute(self, records, *, controller_result=0, agent_interrupt=False, player_mode='full'):
        controller = Mock()
        controller.wait.return_value = controller_result
        agent = Mock()
        agent.wait.return_value = 0
        if agent_interrupt:
            agent.wait.side_effect = KeyboardInterrupt
        with patch.object(launcher, 'read_record', side_effect=records), \
                patch.object(launcher.subprocess, 'Popen', side_effect=[controller, agent]) as spawn:
            result = launcher.launch(MINIAGENT, player_mode=player_mode)
        return result, spawn

    def test_reused_tts_is_preserved(self):
        result, spawn = self.execute([self.old, self.old, self.old])
        self.assertEqual(result, 0)
        self.assertEqual(spawn.call_count, 2)
        self.stop_service.assert_not_called()

    def test_created_tts_is_stopped(self):
        result, _ = self.execute([None, self.owned, self.owned])
        self.assertEqual(result, 0)
        self.assertEqual(self.stop_service.call_args.args[0][-1], 'stop')

    def test_replacement_tts_is_preserved(self):
        replacement = {'pid': 3, 'started_at': 300}
        self.execute([None, self.owned, replacement])
        self.stop_service.assert_not_called()

    def test_failed_warmup_rolls_back_created_tts(self):
        with self.assertRaisesRegex(RuntimeError, 'TTS 启动失败'):
            self.execute([None, self.owned, self.owned], controller_result=1)
        self.assertEqual(self.stop_service.call_args.args[0][-1], 'stop')

    def test_interrupt_stops_owned_tts(self):
        result, _ = self.execute([None, self.owned, self.owned], agent_interrupt=True)
        self.assertEqual(result, 0)
        self.stop_service.assert_called_once()

    def test_duplicate_does_not_start_processes(self):
        with (self.run / 'launcher.lock').open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(launcher.subprocess, 'Popen') as spawn:
                self.assertEqual(launcher.launch(MINIAGENT), 0)
            spawn.assert_not_called()

    def test_existing_mode_needs_no_local_electron(self):
        with patch.object(launcher, 'ROOT', self.run):
            result, spawn = self.execute([self.old, self.old, self.old], player_mode='existing')
        self.assertEqual(result, 0)
        self.assertEqual(spawn.call_count, 2)
        self.stop_service.assert_not_called()

    def test_existing_mode_offline_starts_nothing(self):
        with patch.object(mcp, 'alive', return_value=False), \
                patch.object(launcher.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, '没有可用的播放器 MCP'):
                launcher.launch(MINIAGENT, player_mode='existing')
        spawn.assert_not_called()
        self.stop_service.assert_not_called()

    def test_interactive_existing_choice(self):
        with patch('builtins.input', return_value='3'):
            result, spawn = self.execute([self.old, self.old, self.old], player_mode='ask')
        self.assertEqual(result, 0)
        self.assertEqual(spawn.call_count, 2)

    def test_interactive_cancel_starts_nothing(self):
        with patch('builtins.input', return_value='q'), \
                patch.object(launcher.subprocess, 'Popen') as spawn:
            self.assertEqual(launcher.launch(MINIAGENT, player_mode='ask'), 0)
        spawn.assert_not_called()

    def test_closing_owned_player_stops_host(self):
        player = Mock()
        player.poll.return_value = 0
        controller = Mock()
        controller.wait.return_value = 0
        agent = Mock()
        agent.wait.side_effect = subprocess.TimeoutExpired('miniagent', 1)
        with patch.object(mcp, 'alive', side_effect=[False, True]), \
                patch.object(launcher, 'read_record', side_effect=[self.old, self.old, self.old]), \
                patch.object(launcher.subprocess, 'Popen', side_effect=[player, controller, agent]) as spawn:
            self.assertEqual(launcher.launch(MINIAGENT), 0)
        self.assertNotIn('--mini-player', spawn.call_args_list[0].args[0])
        self.assertTrue(any(call.args == (agent,) for call in self.mocks[-2].call_args_list))
        self.stop_service.assert_not_called()


    def test_interactive_mode_reaches_player_process(self):
        for answer, mini in (('', False), ('1', False), ('2', True)):
            with self.subTest(answer=answer), \
                    patch('builtins.input', return_value=answer), \
                    patch.object(mcp, 'alive', side_effect=[False, True]), \
                    patch.object(launcher, 'read_record', side_effect=[self.old, self.old, self.old]), \
                    patch.object(launcher.subprocess, 'Popen') as spawn:
                spawn.return_value.wait.return_value = 0
                self.assertEqual(launcher.launch(MINIAGENT, player_mode='ask'), 0)
                self.assertEqual('--mini-player' in spawn.call_args_list[0].args[0], mini)

    def test_invalid_choice_can_be_corrected(self):
        with patch('builtins.input', side_effect=['bad', '2']):
            self.assertEqual(launcher.choose_player_mode(), 'mini')


class CommandLineTest(unittest.TestCase):
    def test_explicit_modes_skip_menu(self):
        for flag, mode in (('--full-player', 'full'), ('--start-player', 'full'),
                           ('--mini-player', 'mini'), ('--no-player', 'existing')):
            with self.subTest(flag=flag), patch.object(sys, 'argv', ['start-radio.py', flag]), \
                    patch.object(sys.stdin, 'isatty', return_value=True), \
                    patch.object(launcher, 'launch', return_value=0) as launch:
                self.assertEqual(launcher.main(), 0)
                self.assertEqual(launch.call_args.args[2], mode)

    def test_interactive_default_shows_menu(self):
        with patch.object(sys, 'argv', ['start-radio.py']), \
                patch.object(sys.stdin, 'isatty', return_value=True), \
                patch.object(launcher, 'launch', return_value=0) as launch:
            self.assertEqual(launcher.main(), 0)
        self.assertEqual(launch.call_args.args[2], 'ask')

    def test_noninteractive_default_is_full(self):
        with patch.object(sys, 'argv', ['start-radio.py']), \
                patch.object(sys.stdin, 'isatty', return_value=False), \
                patch.object(launcher, 'launch', return_value=0) as launch:
            self.assertEqual(launcher.main(), 0)
        self.assertEqual(launch.call_args.args[2], 'full')


class ShutdownTest(unittest.TestCase):
    def test_already_exited_process_is_not_signalled(self):
        process = Mock()
        process.poll.return_value = 0
        with patch.object(launcher.os, 'killpg') as kill:
            launcher.finish(process)
        kill.assert_not_called()

    def test_live_host_receives_interrupt_for_radio_cleanup(self):
        process = Mock(pid=123)
        process.poll.return_value = None
        with patch.object(launcher.os, 'killpg') as kill:
            launcher.finish(process)
        kill.assert_called_once_with(123, signal.SIGINT)
        process.wait.assert_called_once_with(timeout=12)


if __name__ == '__main__':
    unittest.main()
