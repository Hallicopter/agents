import importlib.util
from pathlib import Path
import os
import socket
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('reconcile', Path(__file__).with_name('reconcile-stale-sockets.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='socket-test-')
        self.root = Path(self.temp.name)
        self.path = self.root / 'input.sock'
        self.backup = self.root / 'backup'
    def tearDown(self):
        self.temp.cleanup()
    def bind(self, listening=False):
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(self.path)); os.chmod(self.path, 0o600)
        if listening: server.listen(2)
        return server
    def test_abandoned_socket_preserved_with_same_inode(self):
        server = self.bind(); server.close()
        inode = self.path.stat().st_ino
        self.assertTrue(module.reconcile(self.path, self.backup))
        self.assertFalse(self.path.exists())
        self.assertEqual(next(self.backup.iterdir()).stat().st_ino, inode)
    def test_live_listener_never_removed(self):
        server = self.bind(True)
        try:
            with self.assertRaises(RuntimeError): module.reconcile(self.path, self.backup)
            self.assertTrue(self.path.exists())
        finally: server.close()
    def test_missing_path_is_noop(self):
        self.assertFalse(module.reconcile(self.path, self.backup))
    def test_regular_file_and_symlink_refused(self):
        self.path.write_text('preserve')
        with self.assertRaises(RuntimeError): module.reconcile(self.path, self.backup)
        self.path.unlink(); self.path.symlink_to(self.root / 'missing')
        with self.assertRaises(RuntimeError): module.reconcile(self.path, self.backup)
        self.assertTrue(self.path.is_symlink())
    def test_public_parent_refused(self):
        server = self.bind(); server.close(); self.root.chmod(0o755)
        with self.assertRaises(RuntimeError): module.reconcile(self.path, self.backup)
        self.root.chmod(0o700)

if __name__ == '__main__': unittest.main()
