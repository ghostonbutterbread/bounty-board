"""Regression tests for the re-review of 7696646..7e6c930 (docs/integrations/report-agent-ui.md, review
round 2): skills tree V1, V2, V3, V6 and the credential rules V4, V5. Synthetic skills and fake values only.

The one-liner test needs Docker (BBTERM_DOCKER_TESTS=1, image BBTERM_TEST_IMAGE, default
bbterm-test-image-agent:latest); its container is named bbterm-test-rv2-* and removed."""
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import terminal_agent_cli as cli  # noqa: E402
import terminal_report_agent as ra  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402

IMAGE = os.environ.get('BBTERM_TEST_IMAGE', 'bbterm-test-image-agent:latest')
DOCKER = os.environ.get('BBTERM_DOCKER_TESTS') == '1'


def skill(folder, name):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: synthetic\n---\nbody\n')
    return folder


class Session:
    def __init__(self, sid):
        self.id, self.agent, self.relay = sid, None, None


class Base(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('rv2tree')
        self.root = fx.make_root(self.base)
        self.src = self.base / 'repo'
        self.dir = self.base / 'claude-skills'
        self.dir.mkdir(mode=0o755)
        skill(self.src / 'alpha', 'alpha')
        (self.dir / 'alpha').symlink_to(self.src / 'alpha')
        self.logs = []
        self.hub = ra.ReportAgentHub(enabled=True, root=self.root, state_dir=self.base / 'state', clis={'claude': sys.executable},
                                     skills_dir=str(self.dir), template='x', log=self.logs.append)

    def tearDown(self):
        self.hub.close()
        shutil.rmtree(self.base, ignore_errors=True)

    @staticmethod
    def mount_of(args):
        return Path([a for a in args if a.endswith('target=/opt/report-agent/skills,readonly')][0].split('source=', 1)[1].split(',', 1)[0])


class GcRace(Base):
    """V3: the tree handed to a starting sandbox is in use before tree_lock is released."""

    def test_tree_returned_to_a_starting_sandbox_survives_a_concurrent_rebuild(self):
        t1, _ = self.hub.skills_tree(user='A')                 # sandbox A, before its docker run
        (self.src / 'alpha' / 'SKILL.md').write_text('---\nname: alpha\ndescription: v2\n---\nedited\n')
        t2 = self.mount_of(self.hub.run_args_extra(Session('B')))   # sandbox B starts meanwhile, after an edit
        self.assertNotEqual(str(t2), t1)
        self.assertTrue(os.path.isdir(t1), 'the tree handed to sandbox A was deleted before its docker run')
        self.hub.session_destroyed(Session('A'))              # A's docker run failed or A was removed: released
        self.assertFalse(os.path.exists(t1))


class FifoHang(Base):
    """V2: nothing under tree_lock may block on a FIFO."""

    def test_fifo_in_a_skill_does_not_block_builds_or_stop(self):
        os.mkfifo(self.src / 'alpha' / 'pipe')
        builder = threading.Thread(target=self.hub.skills_tree, daemon=True)
        builder.start()
        builder.join(3)
        stopper = threading.Thread(target=self.hub.session_destroyed, args=(Session('other'),), daemon=True)
        stopper.start()
        stopper.join(3)
        hung = builder.is_alive(), stopper.is_alive()
        if builder.is_alive():   # unblock the open() so the test process can exit
            fd = os.open(self.src / 'alpha' / 'pipe', os.O_WRONLY | os.O_NONBLOCK)
            os.close(fd)
        self.assertEqual(hung, (False, False), 'a build blocked on a FIFO while holding tree_lock')
        tree = self.hub.tree[1]
        self.assertFalse(os.path.lexists(os.path.join(tree, 'alpha', 'pipe')))


class Exposure(Base):
    """V1 and V6: VCS metadata, dot-directories and private or hard-linked files never reach the tree."""

    def test_git_metadata_and_dot_directories_are_not_copied(self):
        git = self.src / 'alpha' / '.git'
        (git / 'objects' / 'ab').mkdir(parents=True)
        (git / 'config').write_text('[remote "origin"]\n\turl = https://FAKE-USER:FAKE-PAT@example.invalid/r.git\n')
        (git / 'objects' / 'ab' / 'cdef').write_bytes(b'x\x9c' + os.urandom(32))
        for vcs in ('.hg', '.svn', '.bzr', 'CVS', '.pytest_cache'):
            (self.src / 'alpha' / 'sub' / vcs).mkdir(parents=True, exist_ok=True)
            (self.src / 'alpha' / 'sub' / vcs / 'x').write_text('meta\n')
        (self.src / 'alpha' / 'sub' / '.git').write_text('gitdir: /home/someone/repo/.git/worktrees/x\n')  # a worktree's .git file
        (self.src / 'alpha' / 'sub' / 'kept.md').write_text('kept\n')
        (self.src / 'alpha' / '.gitignore').write_text('*.pyc\n')   # dot-files other than .git are kept
        tree, _ = self.hub.skills_tree()
        copied = sorted(str(p.relative_to(tree)) for p in Path(tree).rglob('*'))
        self.assertEqual(copied, ['alpha', 'alpha/.gitignore', 'alpha/SKILL.md', 'alpha/sub', 'alpha/sub/kept.md'])
        # The signature ignores them too: editing .git does not rebuild the tree.
        (git / 'config').write_text('changed\n')
        self.assertEqual(self.hub.skills_tree()[0], tree)

    def test_hard_linked_and_private_files_are_not_copied(self):
        private = self.base / 'private-notes'
        private.write_text('FAKE-PRIVATE-CONTENT\n')
        os.chmod(private, 0o600)
        os.link(private, self.src / 'alpha' / 'notes.md')
        shared = self.src / 'alpha' / 'shared.md'
        shared.write_text('shared\n')
        os.link(shared, self.base / 'other-link')          # world-readable, but two links: skipped too
        own = self.src / 'alpha' / 'mine.txt'
        own.write_text('FAKE-OWNER-ONLY\n')
        os.chmod(own, 0o600)
        tree, _ = self.hub.skills_tree()
        self.assertEqual(sorted(os.listdir(Path(tree) / 'alpha')), ['SKILL.md'])
        lines = [line for line in self.logs if 'skipped' in line and "skill 'alpha'" in line]
        self.assertEqual(sorted(lines), sorted([
            "skill 'alpha': skipped 'mine.txt': not readable by others",
            "skill 'alpha': skipped 'notes.md': more than one hard link",
            "skill 'alpha': skipped 'shared.md': more than one hard link"]))
        self.assertNotIn('FAKE-', '\n'.join(self.logs))


class SwapRace(Base):
    """V6: a folder swapped for a link into --root after the checks is refused."""

    def test_target_swapped_to_a_link_into_root_after_checks_is_not_copied(self):
        inside = self.root / fx.FAMILY / 'private-data'
        skill(inside, 'alpha')
        (inside / 'root-secret.txt').write_text('FAKE-ROOT-DATA\n')
        real_sig, target = cli.skill_signature, str(self.src / 'alpha')

        def swapping(path):
            out = real_sig(path)
            if path == target and not os.path.islink(path):
                os.rename(path, path + '.moved')
                os.symlink(inside, path)
            return out
        cli.skill_signature = swapping
        try:
            tree, _ = self.hub.skills_tree()
        finally:
            cli.skill_signature = real_sig
        self.assertFalse(os.path.exists(os.path.join(tree or '/nonexistent', 'alpha', 'root-secret.txt')),
                         'a file from inside --root was copied into the tree')

    def test_folder_replaced_by_another_folder_after_discovery_is_refused(self):
        real_sig, target = cli.skill_signature, str(self.src / 'alpha')

        def replacing(path):
            out = real_sig(path)
            if path == target and os.path.isdir(path + '.orig') is False:
                os.rename(path, path + '.orig')
                skill(Path(path), 'alpha')    # same name, another inode
                (Path(path) / 'planted.txt').write_text('planted\n')
            return out
        cli.skill_signature = replacing
        try:
            tree, names = self.hub.skills_tree()
        finally:
            cli.skill_signature = real_sig
        self.assertNotIn('alpha', names)
        self.assertTrue(any("skill 'alpha' not copied" in line and 'changed after it was checked' in line for line in self.logs))


ONE_LINER = "rm -f /tmp/bb-auth; (umask 077; set -C; IFS= read -rs BB_AUTH && printf '%s' \"$BB_AUTH\" > /tmp/bb-auth)"


def template_one_liner():
    found = re.findall(r'`([^`]*BB_AUTH[^`]*)`', (ROOT / 'agent_prompts/report-agent.md').read_text())
    return found[0] if found else ''


class CredentialRules(unittest.TestCase):
    """V4 and V5."""

    def test_managed_policy_denies_reading_the_credential_file(self):
        deny = cli.REGISTRY['claude'].adapter.managed_settings()['permissions']['deny']
        self.assertIn('Read(//tmp/bb-auth)', deny)
        self.assertNotIn('Bash', ' '.join(cli.REGISTRY['claude'].adapter.managed_settings()['permissions']['allow']))

    def test_template_has_the_exact_one_liner(self):
        self.assertEqual(template_one_liner(), ONE_LINER)

    @unittest.skipUnless(DOCKER and shutil.which('docker'), 'set BBTERM_DOCKER_TESTS=1 to run the one-liner in the sandbox image')
    def test_one_liner_in_the_sandbox_image(self):
        line = template_one_liner()
        self.assertTrue(line.startswith('rm -f /tmp/bb-auth; ('))
        inner = line[len('rm -f /tmp/bb-auth; '):]   # what runs if a link is planted right after the rm
        script = r'''
set -u
{ %(line)s; } <<< 'FAKE-CRED-1'
echo "mode=$(stat -c %%a /tmp/bb-auth) owner=$(stat -c %%u /tmp/bb-auth) content=$(cat /tmp/bb-auth) var=${BB_AUTH-unset}"
echo orig > /tmp/target; rm -f /tmp/bb-auth; ln -s /tmp/target /tmp/bb-auth
{ %(inner)s; } 2>/dev/null <<< 'FAKE-CRED-2'; echo "link-to-file rc=$? target=$(cat /tmp/target)"
rm -f /tmp/bb-auth; ln -s /tmp/nothing-here /tmp/bb-auth
{ %(inner)s; } 2>/dev/null <<< 'FAKE-CRED-3'; echo "dangling rc=$? created=$([ -e /tmp/nothing-here ] && echo yes || echo no)"
ln -sf /tmp/target /tmp/bb-auth
{ %(line)s; } <<< 'FAKE-CRED-4'
echo "full-line link=$([ -L /tmp/bb-auth ] && echo yes || echo no) mode=$(stat -c %%a /tmp/bb-auth) target=$(cat /tmp/target) var=${BB_AUTH-unset}"
''' % {'line': line, 'inner': inner}
        name = f'bbterm-test-rv2-{secrets.token_hex(4)}'
        try:
            result = subprocess.run(['docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--user', f'{os.getuid()}:{os.getgid()}',
                                     '--tmpfs', '/tmp:rw,nosuid,nodev,size=8m,mode=1777', '--entrypoint', 'bash', IMAGE, '-c', script],
                                    capture_output=True, text=True, timeout=120)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
        out = result.stdout
        self.assertIn(f'mode=600 owner={os.getuid()} content=FAKE-CRED-1 var=unset', out, out + result.stderr)
        self.assertRegex(out, r'link-to-file rc=[1-9]\d* target=orig', 'a planted link to a file is refused, the file untouched')
        self.assertIn('dangling rc=', out)
        self.assertNotIn('dangling rc=0', out)
        self.assertIn('created=no', out, 'a planted dangling link is refused, nothing created')
        self.assertIn('full-line link=no mode=600 target=orig var=unset', out, 'the full line removes a planted link first')


if __name__ == '__main__':
    unittest.main()
