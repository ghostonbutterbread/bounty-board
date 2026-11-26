"""Browser fixture for the report agent UI: Board + terminal service with the
report agent and agent connect on, plus the Serve-like front proxy, all on
127.0.0.1 with synthetic data.

  python3 tests/report_agent_browser_fixture.py DIR MODE

MODE is a comma list (always tailnet identity):
  nologin    no token file: the sandbox login is missing
  agentoff   the service runs without --report-agent
  noconnect  the service runs without --agent-connect
  down       the Board has --terminal-url but no terminal service answers
  nolive     the Board runs without live editing (the non-live report view)
  notokenflag  the service runs without --report-agent-token-file (login not editable)

The service runs in this process with the TEST-ONLY local backend, the fake CLI
(tests/fake_agent_cli.py) as "claude", a fake TLS model upstream (never
Anthropic) and a fake Herdr (tests/fake_herdr.py, never the real one). Prints
one JSON line {port, lane, token, herdr_state, herdr_log, program}.
"""
import json
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import app  # noqa: E402
import terminal_connect as tc  # noqa: E402
import terminal_report_agent as ra  # noqa: E402
import terminal_sandbox as sb  # noqa: E402
import terminal_service as ts  # noqa: E402
from tests import fake_model_upstream as fu  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402
from tests.terminal_browser_fixture import free_port, front_proxy  # noqa: E402

FAKE_CLI = ROOT / 'tests' / 'fake_agent_cli.py'
FAKE_HERDR = ROOT / 'tests' / 'fake_herdr.py'
FAKE_TOKEN = 'sk-ant-oat01-FAKE-browser-fixture-token-abcdefghijklmnop'


def herdr_agent(pane, terminal, ref, status, seq, foreground, kind='claude', title='Claude Code'):
    return {'agent': kind, 'agent_session': {'agent': kind, 'kind': 'id' if kind == 'claude' else 'path',
                                             'source': f'herdr:{kind}', 'value': ref},
            'agent_status': status, 'focused': False, 'pane_id': pane, 'revision': 1, 'state_change_seq': seq,
            'tab_id': 'w1:t1', 'terminal_id': terminal, 'terminal_title': title, 'terminal_title_stripped': title,
            'workspace_id': 'w1', 'foreground_cwd': foreground}


def main():
    target, modes = Path(sys.argv[1]), set(sys.argv[2].split(',')) | {'tailnet'}
    root = fx.make_root(target)
    lane = root / fx.FAMILY / fx.PROGRAM / fx.LANE
    program = os.path.realpath(root / fx.FAMILY / fx.PROGRAM)
    front, term_port = free_port(), free_port()
    board = app.make_server(root, port=0, terminal_url='/terminal/',
                            **({} if 'nolive' in modes else {'live_edit_dir': target / 'live-state'}))
    threading.Thread(target=board.serve_forever, daemon=True).start()

    token = target / 'secrets' / 'login-token'
    token.parent.mkdir(mode=0o700)
    if 'nologin' not in modes:
        fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, FAKE_TOKEN.encode() + b'\n')
        os.close(fd)
    herdr_state, herdr_log = target / 'herdr-state.json', target / 'herdr-log.jsonl'
    real_lane = os.path.realpath(lane)
    herdr_state.write_text(json.dumps({'agents': [
        herdr_agent('w1:p1', 'term_a1', 'uuid-a', 'idle', 10, program, title='Program-wide recon'),
        herdr_agent('w1:p2', 'term_b2', '/home/u/.omp/sessions/b.jsonl', 'working', 30, real_lane + '/reports/D1-sqli-login',
                    kind='omp', title='Lane hunter on D1'),
        herdr_agent('w1:p3', 'term_c3', 'uuid-c', 'blocked', 5, '/etc', title='Outside agent'),
        herdr_agent('w1:p4', 'term_d4', 'uuid-d', 'done', 50, real_lane, title='evil\x1b]0;x\x07‮title'),
    ], 'busy': []}))

    upstream = hub = connect = None
    if 'down' not in modes:
        cert, key = fu.make_cert(target / 'tls')
        upstream = fu.FakeUpstream(cert, key)
        if 'agentoff' not in modes:
            hub = ra.ReportAgentHub(enabled=True, root=root, state_dir=target / 'term-state', clis={'claude': str(FAKE_CLI)},
                                    token_file=None if 'notokenflag' in modes else token, relay_upstream=('127.0.0.1', upstream.port),
                                    relay_ssl_context=fu.client_context(cert), stop_grace=1.0)
        if 'noconnect' not in modes:
            env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'FAKE_HERDR_STATE': str(herdr_state),
                   'FAKE_HERDR_LOG': str(herdr_log), 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8'}
            connect = tc.ConnectHub(enabled=True, root=root, herdr=tc.Herdr(FAKE_HERDR, 'test-session', env=env),
                                    max_sessions=4, grace=0.5, pty_env=env)
        server = ts.make_service(root, port=term_port, allowed_origins=[f'http://127.0.0.1:{front}'],
                                 allowed_users=['ryu@example.test'], state_dir=target / 'term-state',
                                 backend=sb.LocalBackend(target / 'local'), min_free_memory=0, reap_interval=1,
                                 report_agent=hub, agent_connect=connect)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    front_proxy(front, board.server_port, term_port, modes)
    print(json.dumps({'port': front, 'lane': str(lane), 'token': str(token), 'herdr_state': str(herdr_state),
                      'herdr_log': str(herdr_log), 'program': program}), flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        if upstream:
            upstream.close()


if __name__ == '__main__':
    import signal
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    main()
