#!/usr/bin/env python3
"""Fake ``herdr`` for agent connect tests (never the real Herdr, never a real agent).

Implements the subset the service uses:
  herdr --session S agent list
  herdr --session S agent get <target>
  herdr --session S agent read <target> --source visible [--lines N]
  herdr --session S agent attach <target> [--takeover]

State comes from the JSON file in ``FAKE_HERDR_STATE`` ({"agents": [...],
"busy": [pane ids where attach fails]}). Every call appends its argv to
``FAKE_HERDR_LOG``. ``attach`` is an interactive echo program: it prints
``ATTACHED <pane> <cols>x<rows>``, echoes input lines, prints its size on
SIGWINCH, and records each signal it receives (``SIGNAL <name>``) to the log
before exiting on SIGHUP/SIGTERM.
"""
import fcntl
import json
import os
import signal
import struct
import sys
import termios
import time


def log(entry):
    path = os.environ.get('FAKE_HERDR_LOG')
    if path:
        with open(path, 'a', encoding='utf-8') as stream:
            stream.write(json.dumps(entry) + '\n')


def state():
    with open(os.environ['FAKE_HERDR_STATE'], encoding='utf-8') as stream:
        return json.load(stream)


def size():
    try:
        rows, cols, _, _ = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))
        return f'{cols}x{rows}'
    except OSError:
        return '?'


def attach(pane):
    data = state()
    if pane in data.get('busy', []):
        print('error: another client is attached to this agent', flush=True)
        sys.exit(3)
    if pane not in [a.get('pane_id') for a in data.get('agents', [])]:
        print('error: no such pane', flush=True)
        sys.exit(4)

    def on_signal(signum, _frame):
        log({'pid': os.getpid(), 'signal': signal.Signals(signum).name})
        if signum in (signal.SIGHUP, signal.SIGTERM):
            sys.exit(0)

    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, on_signal)
    signal.signal(signal.SIGWINCH, lambda *_: print(f'SIZE {size()}', flush=True))
    log({'pid': os.getpid(), 'attached': pane})
    print(f'ATTACHED {pane} {size()}', flush=True)
    while True:
        line = sys.stdin.readline()
        if not line:
            time.sleep(0.05)
            continue
        print('AGENT-ECHO ' + line.strip(), flush=True)


def main():
    argv = sys.argv[1:]
    log({'argv': argv})
    if len(argv) < 4 or argv[0] != '--session' or argv[2] != 'agent':
        print('usage: herdr --session S agent ...', file=sys.stderr)
        return 2
    command, rest = argv[3], argv[4:]
    if command == 'list':
        print(json.dumps({'id': 'cli:agent:list', 'result': {'agents': state().get('agents', [])}}))
        return 0
    if command == 'get' and rest:
        found = [a for a in state().get('agents', []) if a.get('pane_id') == rest[0]]
        print(json.dumps({'id': 'cli:agent:get', 'result': found[0] if found else None}))
        return 0 if found else 1
    if command == 'read' and rest:
        print('visible text of ' + rest[0])
        return 0
    if command == 'attach' and rest:
        attach(rest[0])
        return 0
    return 2


if __name__ == '__main__':
    sys.exit(main())
