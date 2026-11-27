"""--report-agent-skills-dir: discovery, the one shared read-only tree, regeneration and garbage
collection. Synthetic skills only (no real skill folder is read)."""
import os
import shutil
import stat
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import terminal_agent_cli as cli  # noqa: E402
import terminal_report_agent as ra  # noqa: E402
import terminal_service as ts  # noqa: E402
from tests import terminal_fixture as fx  # noqa: E402
from tests.test_terminal_report_agent import ts_args  # noqa: E402

BODY_MARK = 'SKILL-BODY-CONTENT-MARK'


def skill(folder, name, extra_front='', body=''):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: synthetic {name}\n{extra_front}---\n'
                                     f'{BODY_MARK} {body}\n')
    return folder


class Session:
    def __init__(self, sid):
        self.id, self.agent, self.relay = sid, None, None


class SkillsTreeTests(unittest.TestCase):
    def setUp(self):
        self.base = fx.tmp_base('skillstree')
        self.root = fx.make_root(self.base)
        root_a, root_b = self.base / 'bbh-runtime', self.base / 'ai-policies'
        skill(root_a / 'alpha', 'alpha', body='alpha v1')
        skill(root_a / 'Beta_Skill.v2', 'Beta_Skill.v2')
        skill(root_b / 'gamma', 'gamma', extra_front='allowed-tools: [Bash, WebFetch]\n')
        (root_b / 'gamma' / 'sub').mkdir()
        (root_b / 'gamma' / 'sub' / 'notes.md').write_text('notes\n')
        (root_b / 'gamma' / 'nested-link').symlink_to('/etc/hostname')          # nested symlink: skipped
        (root_b / 'gamma' / 'sub' / 'up').symlink_to('..')
        os.chmod(root_a / 'alpha' / 'SKILL.md', 0o664)                             # group-writable: accepted
        os.chmod(root_a / 'alpha', 0o775)
        self.dir = self.base / 'claude-skills'
        self.dir.mkdir(mode=0o755)
        os.chmod(self.dir, 0o775)                                                  # group-writable dir: accepted
        for name, target in (('alpha', root_a / 'alpha'), ('Beta_Skill.v2', root_a / 'Beta_Skill.v2'), ('gamma', root_b / 'gamma'),
                             ('broken', self.base / 'missing'), ('insider', self.root / fx.FAMILY / 'leak')):
            (self.dir / name).symlink_to(target)
        skill(self.root / fx.FAMILY / 'leak', 'insider')                         # a link into --root: refused
        (self.dir / 'synced' / 'nested').mkdir(parents=True)                       # real folder, no top-level SKILL.md
        skill(self.dir / 'synced' / 'nested', 'nested')
        skill(self.dir / 'local-real', 'local-real')                               # real folder with SKILL.md
        (self.dir / 'README.md').write_text('not a skill\n')
        self.explicit = skill(self.base / 'explicit' / 'alpha', 'alpha', body='explicit wins')  # name clash
        self.logs = []
        self.hub = ra.ReportAgentHub(enabled=True, root=self.root, state_dir=self.base / 'state', clis={'claude': sys.executable},
                                     skills_dir=str(self.dir), skills={'alpha': str(self.explicit)}, template='x',
                                     log=self.logs.append)

    def tearDown(self):
        self.hub.close()
        shutil.rmtree(self.base, ignore_errors=True)

    def trees(self):
        return sorted(p.name for p in (self.base / 'state/report-agent').glob('skills-tree-*'))

    def mount_of(self, args):
        found = [a for a in args if a.endswith('target=/opt/report-agent/skills,readonly')]
        self.assertEqual(len(found), 1, args)
        return Path(found[0].split('source=', 1)[1].split(',', 1)[0])

    def test_discovery_copy_and_single_mount(self):
        session = Session('s1')
        args = self.hub.run_args_extra(session)
        tree = self.mount_of(args)
        self.assertEqual([a for a in args if '/opt/report-agent/skills/' in a], [], 'no per-skill mounts')
        self.assertEqual(sorted(os.listdir(tree)), ['Beta_Skill.v2', 'alpha', 'gamma', 'local-real'])
        self.assertEqual(session.agent_mounts['skills'], ['Beta_Skill.v2', 'alpha', 'gamma', 'local-real'])
        self.assertIn('explicit wins', (tree / 'alpha' / 'SKILL.md').read_text(), 'the explicit skill wins the clash')
        gamma = (tree / 'gamma' / 'SKILL.md').read_text()
        self.assertNotIn('allowed-tools', gamma)
        self.assertEqual((tree / 'gamma' / 'sub' / 'notes.md').read_text(), 'notes\n')
        for link in ('gamma/nested-link', 'gamma/sub/up'):
            self.assertFalse(os.path.lexists(tree / link), link)
        for folder, dirs, files in os.walk(tree):
            for name in files:
                self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(folder, name)).st_mode), 0o644)
            for name in dirs:
                self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(folder, name)).st_mode), 0o755)
        self.assertTrue(str(tree).startswith(str(self.base / 'state/report-agent/skills-tree-')))
        log = '\n'.join(self.logs)
        for name, reason in (('broken', 'broken link'), ('insider', 'inside the Board data root'), ('synced', 'no top-level SKILL.md'),
                             ('README.md', 'not a directory')):
            self.assertIn(f"skipped {name!r}: {reason}", log)
        self.assertIn('skills dir: 4 skills found, 4 skipped', log)
        self.assertIn("'alpha': the --report-agent-skill folder replaces the skills dir entry", log)
        self.assertNotIn(BODY_MARK, log, 'log lines carry names and counts, never contents')
        # The HOME link: one link to the one mount.
        files, links = cli.ClaudeAdapter().home_files(session.agent_mounts['skills'])
        self.assertEqual(links, {'.claude/skills': '/opt/report-agent/skills'})

    def test_same_sources_reuse_the_tree_and_changes_regenerate_it(self):
        s1, s2 = Session('s1'), Session('s2')
        first = self.mount_of(self.hub.run_args_extra(s1))
        self.assertEqual(self.mount_of(self.hub.run_args_extra(s2)), first, 'one tree shared by every sandbox')
        time.sleep(0.01)
        (self.base / 'bbh-runtime' / 'Beta_Skill.v2' / 'SKILL.md').write_text('---\nname: Beta_Skill.v2\n---\nv2\n')
        s3 = Session('s3')
        second = self.mount_of(self.hub.run_args_extra(s3))
        self.assertNotEqual(second, first)
        self.assertIn('v2', (second / 'Beta_Skill.v2' / 'SKILL.md').read_text())
        self.assertEqual(self.trees(), sorted([first.name, second.name]), 'the old tree stays while s1 and s2 mount it')
        self.hub.session_destroyed(s1)
        self.assertTrue(first.is_dir(), 's2 still mounts it')
        self.hub.session_destroyed(s2)
        self.assertFalse(first.exists(), 'no live container uses it: removed')
        self.assertEqual(self.trees(), [second.name])
        # A top-level link pointed elsewhere also regenerates.
        os.unlink(self.dir / 'gamma')
        (self.dir / 'gamma').symlink_to(self.base / 'bbh-runtime' / 'alpha')
        s4 = Session('s4')
        third = self.mount_of(self.hub.run_args_extra(s4))
        self.assertNotEqual(third, second)
        self.assertIn('alpha v1', (third / 'gamma' / 'SKILL.md').read_text())
        self.hub.session_destroyed(s3)
        self.assertEqual(self.trees(), [third.name])
        # A new skill appears in the folder.
        skill(self.base / 'ai-policies' / 'delta', 'delta')
        (self.dir / 'delta').symlink_to(self.base / 'ai-policies' / 'delta')
        self.assertIn('delta', os.listdir(self.mount_of(self.hub.run_args_extra(Session('s5')))))

    def test_total_cap_refuses_the_tree(self):
        saved = cli.TREE_MAX_FILES
        cli.TREE_MAX_FILES = 3
        try:
            session = Session('s1')
            args = self.hub.run_args_extra(session)
            self.assertEqual([a for a in args if '/opt/report-agent/skills' in a], [])
            self.assertEqual(session.agent_mounts['skills'], [])
            self.assertTrue(any(line.startswith('skills tree refused: more than 256 MiB or 3 files') for line in self.logs))
            self.assertEqual(self.trees(), [])
            self.assertEqual([p.name for p in (self.base / 'state/report-agent').iterdir() if 'skills-tree' in p.name], [], 'no temp left')
            files, links = cli.ClaudeAdapter().home_files(session.agent_mounts['skills'])
            self.assertEqual(links, {})
        finally:
            cli.TREE_MAX_FILES = saved

    def test_old_trees_are_removed_at_start(self):
        self.hub.run_args_extra(Session('s1'))
        self.assertEqual(len(self.trees()), 1)
        again = ra.ReportAgentHub(enabled=True, root=self.root, state_dir=self.base / 'state', template='x', log=self.logs.append)
        try:
            self.assertEqual(self.trees(), [], 'containers from the last run were reaped; their trees go too')
        finally:
            again.close()

    def test_skills_dir_rules(self):
        cli.check_skills_dir(str(self.dir))   # group-writable is fine
        os.chmod(self.dir, 0o777)
        with self.assertRaises(cli.CliError):
            cli.check_skills_dir(str(self.dir))
        self.assertEqual(cli.discover_skills(str(self.dir), self.root, self.logs.append), {})
        self.assertIn('skills dir not used', self.logs[-1])
        os.chmod(self.dir, 0o755)
        link = self.base / 'skills-link'
        link.symlink_to(self.dir)
        with self.assertRaises(cli.CliError):
            cli.check_skills_dir(str(link))
        with self.assertRaises(cli.CliError):
            cli.check_skills_dir(str(self.base / 'nope'))
        # The flag: needs --report-agent; refused when it breaks the rules; combines with --report-agent-skill.
        parse = lambda *extra: ts.build_agent_hubs(ts_args(self.root, self.base, *extra))
        with self.assertRaises(ValueError):
            parse('--report-agent-skills-dir', str(self.dir))
        with self.assertRaises(ValueError):
            parse('--report-agent', '--report-agent-skills-dir', str(link))
        hub, _ = parse('--report-agent', '--report-agent-skills-dir', str(self.dir), '--report-agent-skill', f'alpha={self.explicit}')
        try:
            self.assertEqual((hub.skills_dir, hub.skills), (str(self.dir), {'alpha': str(self.explicit)}))
        finally:
            hub.close()


if __name__ == '__main__':
    unittest.main()
