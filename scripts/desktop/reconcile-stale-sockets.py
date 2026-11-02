#!/usr/bin/env python3
"""Service preflight: preserve only verified abandoned private Unix sockets.

Never changes credentials, ownership journals, or a socket with a live listener.
Run under the service UID before its process starts; same-UID/root are trusted.
"""
import errno
import os
from pathlib import Path
import pwd
import socket
import stat
import time


def reconcile(path: Path, backup: Path) -> bool:
    try:
        parent = path.parent.lstat()
        original = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise RuntimeError('Socket parent must be private and owned')
    if not stat.S_ISSOCK(original.st_mode) or original.st_uid != os.getuid() or original.st_mode & 0o077:
        raise RuntimeError('Refusing unexpected socket path')
    with socket.socket(socket.AF_UNIX) as probe:
        probe.settimeout(2)
        try:
            probe.connect(str(path))
        except OSError as error:
            if error.errno != errno.ECONNREFUSED:
                raise RuntimeError('Socket state uncertain; preserving it') from error
        else:
            raise RuntimeError('Socket listener is active; preserving it')
    backup.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = backup.lstat()
    if not stat.S_ISDIR(target.st_mode) or target.st_uid != os.getuid() or target.st_mode & 0o077:
        raise RuntimeError('Backup directory must be private and owned')
    current = path.lstat()
    if (current.st_dev, current.st_ino, current.st_mode, current.st_uid) != (original.st_dev, original.st_ino, original.st_mode, original.st_uid):
        raise RuntimeError('Socket changed during verification; preserving it')
    path.rename(backup / (path.name + '-' + str(time.time_ns())))
    print('Preserved verified abandoned socket:', path.name)
    return True


def main():
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    backup = home / 'craft-agents-backups' / 'stale-sockets'
    for relative in ['desktop-viewer/input.sock', 'companion/admin.sock']:
        reconcile(home / '.craft-agent' / relative, backup)


if __name__ == '__main__':
    main()
