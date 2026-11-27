"""A PTY shared by several viewers (report agent and agent connect).

The shell sessions in ``terminal_sandbox.Session`` keep their own copy of this
logic (they also keep transcripts and respawn shells). This class is the
smaller version for a single process that is not respawned: start once, fan
the output out to every viewer, keep the last ``scrollback`` bytes for new
viewers, and report the exit code. Each viewer is a ``terminal_service.Viewer``
(its own send queue, dropped at the backlog limit), so a slow device never
stalls the process or the other viewers.

``stop`` only signals the process group this class spawned (the PTY's session
leader is the child of ``spawn_pty``), never anything else.
"""
import os
import signal
import subprocess
import threading
import time

import terminal_sandbox as sb


class PtyFanout:
    def __init__(self, argv, *, env=None, cwd=None, size=(100, 30), scrollback=sb.SCROLLBACK_BYTES,
                 clock=time.monotonic, on_exit=None, name='bbterm-pty', exit_note=None):
        self.argv = list(argv)
        self.env, self.cwd = env, cwd
        self.size = size
        self.scrollback_limit = scrollback
        self.clock = clock
        self.on_exit = on_exit
        self.name = name
        self.exit_note = exit_note
        self.lock = threading.RLock()
        self.viewers = set()
        self.scrollback = bytearray()
        self.proc = None
        self.master = None
        self.exit_code = None
        self.started_at = None
        self.last_output = None
        self.reader = None

    # -- process ---------------------------------------------------------------------
    def start(self):
        with self.lock:
            self.proc, self.master = sb.spawn_pty(self.argv, cols=self.size[0], rows=self.size[1], cwd=self.cwd,
                                                  env=self.env)
            self.started_at = self.clock()
            self.reader = threading.Thread(target=self._read_loop, args=(self.master, self.proc), name=self.name,
                                           daemon=True)
            self.reader.start()

    @property
    def running(self):
        return self.proc is not None and self.exit_code is None

    def _read_loop(self, master, proc):
        while True:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                break
            self._output(data)
        try:
            code = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._signal_group(proc, signal.SIGKILL)
            code = proc.wait(timeout=5)
        with self.lock:
            self.exit_code = code
            try:
                os.close(master)
            except OSError:
                pass
            if self.master == master:
                self.master = None
            if self.exit_note:
                self._output(self.exit_note(code))
            self.broadcast({'type': 'exit', 'code': code})
        if self.on_exit is not None:
            try:
                self.on_exit(code)
            except Exception:
                pass

    def _output(self, data):
        with self.lock:
            self.last_output = self.clock()
            self.scrollback += data
            if len(self.scrollback) > self.scrollback_limit:
                del self.scrollback[:len(self.scrollback) - self.scrollback_limit]
            for viewer in list(self.viewers):
                viewer.send_output(data)

    @staticmethod
    def _signal_group(proc, sig):
        try:
            os.killpg(proc.pid, sig)  # the group spawn_pty created (start_new_session), nothing else
        except OSError:
            pass

    def stop(self, signals=(signal.SIGHUP, signal.SIGTERM), grace=2.0):
        """End the spawned process group: each signal in turn, then SIGKILL."""
        proc = self.proc
        if proc is None:
            return
        for sig in signals:
            if proc.poll() is not None:
                break
            self._signal_group(proc, sig)
            try:
                proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                continue
        if proc.poll() is None:
            self._signal_group(proc, signal.SIGKILL)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if self.reader is not None and self.reader is not threading.current_thread():
            self.reader.join(timeout=5)

    # -- viewers ---------------------------------------------------------------------
    def attach(self, viewer, hello):
        with self.lock:
            self.viewers.add(viewer)
            viewer.send_control(hello)
            if self.scrollback:
                viewer.send_output(bytes(self.scrollback))
            self.broadcast({'type': 'viewers', 'count': len(self.viewers)})

    def detach(self, viewer):
        """Remove a viewer; returns how many are left."""
        with self.lock:
            if viewer in self.viewers:
                self.viewers.discard(viewer)
                self.broadcast({'type': 'viewers', 'count': len(self.viewers)})
            return len(self.viewers)

    def close_viewers(self, message):
        with self.lock:
            viewers = list(self.viewers)
            self.viewers.clear()
        for viewer in viewers:
            viewer.send_control({'type': 'closed', 'message': message})
            viewer.close()

    def broadcast(self, message):
        with self.lock:
            for viewer in list(self.viewers):
                viewer.send_control(message)

    def write(self, data):
        with self.lock:
            master = self.master if self.running else None
        if master is None:
            return
        try:
            os.write(master, data)
        except OSError:
            pass

    def resize(self, cols, rows):
        with self.lock:
            self.size = (cols, rows)
            if self.master is not None:
                try:
                    sb.set_winsize(self.master, cols, rows)
                except OSError:
                    pass
