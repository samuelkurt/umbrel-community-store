#!/usr/bin/env python3
# Runs one shell on a pseudo terminal for the Blockhaus terminal page.
#   stdin  : keystrokes from the browser (raw bytes)
#   stdout : everything the shell prints (raw bytes)
#   fd 3   : control lines, one JSON object per line, e.g. {"cols":120,"rows":30}
# Exit code = exit code of the shell (128+signal if it was killed by one).
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def set_size(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', max(1, min(rows, 500)), max(1, min(cols, 1000)), 0, 0))
    except OSError:
        pass


def main():
    shell = os.environ.get('BH_SHELL') or '/bin/bash'
    cwd = os.environ.get('BH_CWD') or os.path.expanduser('~')
    cols = int(os.environ.get('BH_COLS') or 80)
    rows = int(os.environ.get('BH_ROWS') or 24)
    env = {k: v for k, v in os.environ.items() if not k.startswith('BH_')}
    env.setdefault('TERM', 'xterm-256color')
    env['COLORTERM'] = 'truecolor'

    pid, master = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
        except OSError:
            pass
        try:
            os.execvpe(shell, [shell, '-l'], env)
        except OSError as e:
            sys.stderr.write('Shell konnte nicht gestartet werden: %s\r\n' % e)
            os._exit(127)
    set_size(master, rows, cols)
    fcntl.fcntl(master, fcntl.F_SETFL, fcntl.fcntl(master, fcntl.F_GETFL) | os.O_NONBLOCK)

    out = sys.stdout.buffer
    pending = b''           # bytes for the shell that did not fit yet
    ctl = b''
    stdin_open = True
    ctl_open = True
    status = None

    def finish():
        # collect the exit status of the shell
        nonlocal status
        deadline = time.time() + 2
        while status is None and time.time() < deadline:
            p, st = os.waitpid(pid, os.WNOHANG)
            if p:
                status = st
                break
            time.sleep(0.02)
        if status is None:
            try:
                os.kill(pid, signal.SIGKILL)
                _, status = os.waitpid(pid, 0)
            except OSError:
                status = 0
        code = os.waitstatus_to_exitcode(status)
        sys.exit(code if code >= 0 else 128 - code)

    while True:
        rlist = [master]
        if ctl_open:
            rlist.append(3)
        if stdin_open:
            rlist.append(0)
        wlist = [master] if pending else []
        try:
            r, w, _ = select.select(rlist, wlist, [], 1.0)
        except InterruptedError:
            continue
        if master in w and pending:
            try:
                n = os.write(master, pending)
                pending = pending[n:]
            except (BlockingIOError, InterruptedError):
                pass
            except OSError:
                pending = b''
        if master in r:
            try:
                data = os.read(master, 65536)
            except BlockingIOError:
                data = None
            except OSError as e:
                if e.errno == errno.EIO:
                    break
                raise
            if data == b'':
                break
            if data:
                out.write(data)
                out.flush()
        if 3 in r:
            try:
                chunk = os.read(3, 4096)
            except OSError:
                chunk = b''
            if chunk:
                ctl += chunk
                while b'\n' in ctl:
                    line, ctl = ctl.split(b'\n', 1)
                    try:
                        m = json.loads(line)
                        set_size(master, int(m.get('rows', rows)), int(m.get('cols', cols)))
                    except (ValueError, TypeError):
                        pass
            else:
                ctl_open = False
        if stdin_open and 0 in r:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b''
            if not data:
                # the panel went away: hang up the shell like a closed terminal window
                stdin_open = False
                try:
                    os.kill(pid, signal.SIGHUP)
                except OSError:
                    pass
            else:
                pending += data
    finish()


if __name__ == '__main__':
    main()
