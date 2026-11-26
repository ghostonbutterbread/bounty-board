#!/usr/bin/env python3
"""Stand-in for a coding CLI in report agent tests (never a real CLI, never a real login).

Prints what it was given (argv, cwd, the task file, selected env), makes one
model request through the relay (127.0.0.1:3129 in a sandbox, or the
``BBTERM_TEST_MODEL_SOCK`` Unix socket with the local test backend) with
credentials the relay must drop, then echoes input lines. Input ``spam``
prints a line every 0.2 s for 3 s; ``child`` starts ``sleep 300`` and prints
its pid; ``quit`` exits with code 7.
"""
import json
import os
import socket
import sys
import time


def model_request():
    body = json.dumps({'model': 'claude-test', 'stream': True, 'max_tokens': 8,
                       'messages': [{'role': 'user', 'content': 'hi'}]}).encode()
    head = ('POST /v1/messages?beta=true HTTP/1.1\r\nHost: 127.0.0.1:3129\r\nContent-Type: application/json\r\n'
            'Authorization: Bearer dummy-from-cli\r\nx-api-key: dummy-key\r\nCookie: c=1\r\nProxy-Authorization: x\r\n'
            'anthropic-beta: claude-code-20250219\r\nanthropic-version: 2023-06-01\r\n'
            f'Content-Length: {len(body)}\r\n\r\n').encode()
    path = os.environ.get('BBTERM_TEST_MODEL_SOCK')
    if path:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(path)
    else:
        sock = socket.create_connection(('127.0.0.1', 3129), timeout=20)
    sock.settimeout(20)
    sock.sendall(head + body)
    data = b''
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        data += chunk
    sock.close()
    return data


def main():
    print('FAKE-CLI-START', flush=True)
    print('ARGV ' + json.dumps(sys.argv[1:]), flush=True)
    print('CWD ' + os.getcwd(), flush=True)
    home = os.environ.get('HOME', '')
    print('BASE_URL ' + os.environ.get('ANTHROPIC_BASE_URL', '-'), flush=True)
    print('TOKEN_IS_DUMMY ' + str(os.environ.get('CLAUDE_CODE_OAUTH_TOKEN', '').startswith('sk-ant-oat01-report-agent-relay-placeholder')), flush=True)
    try:
        with open(os.path.join(home, '.report-agent/task.md'), encoding='utf-8') as stream:
            task = stream.read()
        print('TASK-BEGIN\n' + task.replace('\n', '\r\n') + '\r\nTASK-END', flush=True)
    except OSError as error:
        print('TASK-MISSING ' + str(error), flush=True)
    for name in ('.claude.json', '.claude/settings.json'):
        print(f'HOMEFILE {name} {os.path.exists(os.path.join(home, name))}', flush=True)
    if os.environ.get('FAKE_CLI_NO_MODEL') != '1':
        try:
            reply = model_request()
            status = reply.split(b'\r\n', 1)[0].decode('latin-1')
            print('MODEL-STATUS ' + status, flush=True)
            print('MODEL-REPLY ' + ('FAKE-REPLY-OK' if b'FAKE-REPLY-OK' in reply else 'none'), flush=True)
        except OSError as error:
            print('MODEL-ERROR ' + type(error).__name__, flush=True)
    print('READY', flush=True)
    for line in sys.stdin:
        line = line.strip()
        if line == 'quit':
            print('BYE', flush=True)
            sys.exit(7)
        if line == 'child':  # like a tool call that started a long-running command
            import subprocess
            child = subprocess.Popen(['sleep', '300'])
            print(f'CHILD {child.pid}', flush=True)
            continue
        if line == 'spam':
            for i in range(15):
                print(f'spam-{i}', flush=True)
                time.sleep(0.2)
            continue
        print('ECHO ' + line, flush=True)


if __name__ == '__main__':
    main()
