"""Exercise the exact Python entry point used by the common receiver."""
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class TencentBackupTest(unittest.TestCase):
    helper = Path(__file__).with_name('tencent-backup')

    def invoke(self, uid, name, arguments):
        with patch('os.geteuid', return_value=uid), patch('pwd.getpwuid', return_value=SimpleNamespace(pw_name=name)), patch.object(sys, 'argv', [str(self.helper), *arguments]), patch('os.execvp', side_effect=RuntimeError('exec intercepted')) as execute:
            with self.assertRaisesRegex(RuntimeError, 'exec intercepted'):
                runpy.run_path(str(self.helper), run_name='__main__')
            return execute.call_args.args

    def test_receiver_python_entry_drops_root_and_preserves_arguments(self):
        arguments = ['--db', '/var/lib/band-galaxy/progress.sqlite3', '--directory', '/backup path', '--prefix', 'predeploy']
        executable, command = self.invoke(0, 'root', arguments)
        self.assertEqual(executable, 'runuser')
        self.assertEqual(command[:5], ['runuser', '-u', 'band-galaxy', '--', 'python3'])
        self.assertEqual(Path(command[5]), self.helper.resolve().with_name('backup-sync.py'))
        self.assertEqual(command[6:], arguments)

    def test_service_owner_does_not_run_nested_runuser(self):
        executable, command = self.invoke(1001, 'band-galaxy', ['--verify-api', '/opt/yasi/api-current'])
        self.assertEqual(executable, 'python3')
        self.assertEqual(command[2:], ['--verify-api', '/opt/yasi/api-current'])

    def test_other_user_is_refused_before_exec(self):
        with patch('os.geteuid', return_value=1002), patch('pwd.getpwuid', return_value=SimpleNamespace(pw_name='unrelated')), patch('os.execvp') as execute:
            with self.assertRaises(SystemExit):
                runpy.run_path(str(self.helper), run_name='__main__')
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
