"""Synthetic tests for the live report editing engine (disposable roots only)."""
import os
import queue
import stat
import tempfile
import time
import unittest
from pathlib import Path

from live_editing import (LiveReports, NotEditable, ReportUnavailable, UnresolvedConflict, has_markers,
                          revision_of)

REL = 'web_bounty/alpha/web/reports/report.md'
BASE = 'title\n\nintro line\n\nmiddle line\n\nclosing line\n'


class LiveEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='live-engine-')
        self.addCleanup(self.tmp.cleanup)
        top = Path(self.tmp.name)
        self.root = top / 'root'
        self.report = self.root / REL
        self.report.parent.mkdir(parents=True)
        self.report.write_text(BASE)
        os.chmod(self.report, 0o640)
        self.state = top / 'state'
        self.hooks = {}
        self.live = self.make()

    def make(self, **kwargs):
        def hook(point):
            action = self.hooks.pop(point, None)
            if action:
                action()
        live = LiveReports(self.root, self.state, hook=hook, poll_interval=kwargs.pop('poll_interval', 60), **kwargs)
        self.addCleanup(live.close)
        return live

    def staging(self):
        return [p.name for p in self.report.parent.iterdir() if p.name.startswith('.syncthing.')]

    def test_fast_forward_save_preserves_mode_and_leaves_no_staging(self):
        opened = self.live.open(REL)
        self.assertEqual(opened['content'], BASE)
        self.assertTrue(opened['editable'])
        result = self.live.save(REL, opened['revision'], BASE.replace('intro', 'INTRO'), client='a')
        self.assertEqual(result['status'], 'saved')
        self.assertEqual(self.report.read_text(), BASE.replace('intro', 'INTRO'))
        self.assertEqual(stat.S_IMODE(self.report.stat().st_mode), 0o640)
        self.assertEqual(self.staging(), [])

    def test_external_change_merges_with_stale_base(self):
        opened = self.live.open(REL)
        self.report.write_text(BASE.replace('closing', 'CLOSING (agent)'))
        result = self.live.save(REL, opened['revision'], BASE.replace('intro', 'INTRO (me)'), client='a')
        self.assertEqual(result['status'], 'merged')
        text = self.report.read_text()
        self.assertIn('INTRO (me)', text)
        self.assertIn('CLOSING (agent)', text)
        self.assertEqual(result['content'], text)

    def test_overlapping_edit_returns_markers_and_keeps_file(self):
        opened = self.live.open(REL)
        agent = BASE.replace('middle line', 'middle from agent')
        self.report.write_text(agent)
        result = self.live.save(REL, opened['revision'], BASE.replace('middle line', 'middle from me'), client='a')
        self.assertEqual(result['status'], 'conflict')
        self.assertTrue(has_markers(result['content']))
        self.assertIn('middle from me', result['content'])
        self.assertIn('middle from agent', result['content'])
        self.assertEqual(self.report.read_text(), agent)
        with self.assertRaises(UnresolvedConflict):
            self.live.save(REL, result['revision'], result['content'], client='a')
        resolved = agent.replace('middle from agent', 'middle from both')
        final = self.live.save(REL, result['revision'], resolved, client='a')
        self.assertEqual(final['status'], 'saved')
        self.assertEqual(self.report.read_text(), resolved)
        kinds = [e['kind'] for e in self.live.history_page(REL)]
        self.assertIn('conflict_draft', kinds)

    def test_typing_during_save_rebases_through_sent_revision(self):
        opened = self.live.open(REL)
        self.report.write_text(BASE.replace('closing', 'closing (agent)'))
        sent = BASE.replace('intro', 'intro A')
        first = self.live.save(REL, opened['revision'], sent, client='a')
        self.assertEqual(first['status'], 'merged')
        # The browser kept typing on top of what it sent; it never saw the agent change.
        typed = sent.replace('middle', 'middle B')
        second = self.live.save(REL, first['sent_revision'], typed, client='a')
        text = self.report.read_text()
        for expected in ('intro A', 'middle B', 'closing (agent)'):
            self.assertIn(expected, text)
        self.assertEqual(second['content'], text)

    def test_change_between_observation_and_check_is_merged(self):
        opened = self.live.open(REL)
        self.hooks['before_check'] = lambda: self.report.write_text(BASE.replace('closing', 'closing (late)'))
        result = self.live.save(REL, opened['revision'], BASE.replace('intro', 'intro (me)'), client='a')
        text = self.report.read_text()
        self.assertIn('intro (me)', text)
        self.assertIn('closing (late)', text)
        self.assertEqual(result['content'], text)

    def test_write_between_check_and_exchange_is_recovered(self):
        opened = self.live.open(REL)
        late = BASE.replace('closing', 'closing (raced)')

        def race():
            # Mimic an editor's in-place write that lands after the check.
            with open(self.report, 'w') as stream:
                stream.write(late)
        self.hooks['before_exchange'] = race
        result = self.live.save(REL, opened['revision'], BASE.replace('intro', 'intro (me)'), client='a')
        text = self.report.read_text()
        self.assertIn('intro (me)', text)
        self.assertIn('closing (raced)', text)
        self.assertEqual(result['content'], text)
        self.assertIn(revision_of(late), [e['revision'] for e in self.live.history_page(REL)])
        self.assertEqual(self.staging(), [])

    def test_conflicting_write_between_check_and_exchange_stays_on_disk(self):
        opened = self.live.open(REL)
        late = BASE.replace('middle line', 'middle (raced)')

        def race():
            with open(self.report, 'w') as stream:
                stream.write(late)
        self.hooks['before_exchange'] = race
        events = self.live.subscribe(REL)
        mine = BASE.replace('middle line', 'middle (me)')
        result = self.live.save(REL, opened['revision'], mine, client='a')
        self.assertEqual(result['status'], 'conflict')
        self.assertEqual(self.report.read_text(), late)
        self.assertEqual(result['revision'], revision_of(late))
        self.assertIn('middle (me)', result['content'])
        self.assertIn('middle (raced)', result['content'])
        self.assertEqual(events.get_nowait()['revision'], revision_of(late))
        # A client that kept typing re-sends from its old base: still a conflict,
        # the raced text is not erased.
        again = self.live.save(REL, opened['revision'], mine + 'more\n', client='a')
        self.assertEqual(again['status'], 'conflict')
        self.assertEqual(self.report.read_text(), late)

    def test_setext_underline_is_not_a_conflict_separator(self):
        opened = self.live.open(REL)
        self.report.write_text(BASE.replace('middle line', 'middle from agent'))
        result = self.live.save(REL, opened['revision'], BASE.replace('middle line', 'Heading\n======='), client='a')
        self.assertEqual(result['status'], 'conflict')
        separators = [line for line in result['content'].split('\n') if line and set(line) == {'='}]
        self.assertEqual(sorted(separators), ['=======', '=' * 15])
        self.assertTrue(has_markers('<<<<<<< your edit (Bounty Board)\n'), 'older 7-wide markers are still refused')

    def test_crlf_line_endings_are_preserved(self):
        self.report.write_bytes(BASE.replace('\n', '\r\n').encode())
        opened = self.live.open(REL)
        self.assertNotIn('\r', opened['content'])
        self.live.save(REL, opened['revision'], opened['content'].replace('intro', 'INTRO'), client='a')
        self.assertEqual(self.report.read_bytes(), BASE.replace('intro', 'INTRO').replace('\n', '\r\n').encode())

    def test_not_editable_report_is_refused(self):
        live = LiveReports(self.root, self.state / 'other', editable=lambda rel, text: False, poll_interval=60)
        self.addCleanup(live.close)
        opened = live.open(REL)
        self.assertFalse(opened['editable'])
        with self.assertRaises(NotEditable):
            live.save(REL, opened['revision'], 'changed\n')
        self.assertEqual(self.report.read_text(), BASE)

    def test_symlinked_report_and_directories_are_unavailable(self):
        outside = Path(self.tmp.name) / 'outside.md'
        outside.write_text('secret\n')
        link = self.report.parent / 'link.md'
        link.symlink_to(outside)
        with self.assertRaises(ReportUnavailable):
            self.live.open('web_bounty/alpha/web/reports/link.md')
        (self.root / 'web_bounty/beta').mkdir()
        (self.root / 'web_bounty/beta/web').symlink_to(self.root / 'web_bounty/alpha/web')
        with self.assertRaises((ReportUnavailable, OSError)):
            self.live.open('web_bounty/beta/web/reports/report.md')
        self.assertEqual(outside.read_text(), 'secret\n')

    def test_state_directory_inside_root_is_refused(self):
        with self.assertRaises(ValueError):
            LiveReports(self.root, self.root / '.history')

    def test_watcher_announces_external_change(self):
        live = self.make(poll_interval=0.05)
        live.open(REL)
        events = live.subscribe(REL)
        time.sleep(0.02)
        self.report.write_text(BASE + 'appended by agent\n')
        event = events.get(timeout=5)
        self.assertEqual(event['type'], 'changed')
        self.assertEqual(event['revision'], revision_of(BASE + 'appended by agent\n'))
        self.assertEqual(live.open(REL)['content'], BASE + 'appended by agent\n')

    def test_lost_board_write_conflict_copy_is_merged_automatically(self):
        opened = self.live.open(REL)
        mine = BASE.replace('intro', 'intro (board)')
        self.live.save(REL, opened['revision'], mine, client='a')
        # Syncthing: another device's edit (from BASE) won; ours became a copy.
        copy = self.report.parent / 'report.sync-conflict-20261123-133814-UQMO6NK.md'
        os.rename(self.report, copy)
        self.report.write_text(BASE.replace('closing', 'closing (other device)'))
        listed = self.live.open(REL)
        self.assertTrue(copy.exists(), 'opening a report only lists copies')
        self.assertEqual([c['name'] for c in listed['sync_conflicts']], [copy.name])
        self.live._tick()  # the watcher resolves it
        result = self.live.open(REL)
        text = self.report.read_text()
        self.assertIn('intro (board)', text)
        self.assertIn('closing (other device)', text)
        self.assertEqual(result['content'], text)
        self.assertFalse(copy.exists())
        self.assertEqual(result['sync_conflicts'], [])
        self.assertIn('sync_conflict', [e['kind'] for e in self.live.history_page(REL)])

    def test_unknown_conflict_copy_needs_review_then_applies_or_discards(self):
        opened = self.live.open(REL)
        mine = BASE.replace('intro', 'intro (board)')
        saved = self.live.save(REL, opened['revision'], mine, client='a')
        copy = self.report.parent / 'report.sync-conflict-20261123-140000-6GXLO62.md'
        copy.write_text(BASE.replace('closing', 'closing (lost on Abommie)'))
        listed = self.live.open(REL)['sync_conflicts']
        self.assertEqual([c['name'] for c in listed], [copy.name])
        self.assertEqual(listed[0]['device'], '6GXLO62')
        self.assertTrue(copy.exists(), 'unknown copies are never merged silently')
        preview = self.live.sync_conflict(REL, copy.name)
        self.assertFalse(preview['conflicted'])
        self.assertIn('intro (board)', preview['merged'])
        self.assertIn('closing (lost on Abommie)', preview['merged'])
        applied = self.live.resolve_sync_conflict(REL, copy.name, 'apply', base=saved['revision'],
                                                  content=preview['merged'], client='a')
        self.assertTrue(applied['copy_removed'])
        self.assertFalse(copy.exists())
        self.assertEqual(self.report.read_text(), preview['merged'])
        second = self.report.parent / 'report.sync-conflict-20261123-150000-6GXLO62.md'
        second.write_text('stale\n')
        self.live.open(REL)
        discarded = self.live.resolve_sync_conflict(REL, second.name, 'discard')
        self.assertEqual(discarded['status'], 'discarded')
        self.assertFalse(second.exists())
        self.assertIn(revision_of('stale\n'), [e['revision'] for e in self.live.history_page(REL)])
        with self.assertRaises(KeyError):
            self.live.sync_conflict(REL, '../../etc/passwd')

    def test_history_coalesces_typing_and_restores_scoped_revisions(self):
        opened = self.live.open(REL)
        rev = opened['revision']
        for word in ('one', 'two', 'three'):
            rev = self.live.save(REL, rev, BASE + word + '\n', client='tab-1')['revision']
        board = [e for e in self.live.history_page(REL) if e['kind'] == 'board']
        self.assertEqual(len(board), 1)
        self.assertEqual(self.live.revision(REL, opened['revision']), BASE)
        other = 'web_bounty/alpha/web/reports/other.md'
        (self.root / other).write_text('other\n')
        self.live.open(other)
        with self.assertRaises(KeyError):
            self.live.revision(other, opened['revision'])
        restored = self.live.restore(REL, opened['revision'], rev, client='tab-1')
        self.assertEqual(restored['status'], 'saved')
        self.assertEqual(self.report.read_text(), BASE)

    def test_unknown_base_becomes_a_full_conflict(self):
        self.live.open(REL)
        result = self.live.save(REL, '0' * 64, BASE.replace('intro', 'intro (offline)'), client='a')
        self.assertEqual(result['status'], 'conflict')
        self.assertEqual(self.report.read_text(), BASE)

    def test_subscriber_queue_overflow_drops_client(self):
        self.live.open(REL)
        events = self.live.subscribe(REL)
        rev = self.live.open(REL)['revision']
        for i in range(70):
            rev = self.live.save(REL, rev, BASE + f'{i}\n', client=f'c{i}')['revision']
        drained = []
        while True:
            try:
                drained.append(events.get_nowait())
            except queue.Empty:
                break
        self.assertIn(None, drained)


    # -- review round 1 regressions ------------------------------------------
    def test_stale_board_copy_never_brings_back_a_deleted_line(self):
        opened = self.live.open(REL)
        added = self.live.save(REL, opened['revision'], BASE.replace('middle line\n', 'middle line\nADDED\n'), client='a')
        self.live.save(REL, added['revision'], added['content'].replace('ADDED\n', ''), client='b')
        copy = self.report.parent / 'report.sync-conflict-20261124-101010-ABCDEFG.md'
        copy.write_text(added['content'])  # an older Board write turns up as a copy
        self.live.open(REL)
        self.live._tick()
        self.assertNotIn('ADDED', self.report.read_text())
        self.assertFalse(copy.exists(), 'a copy the head already builds on is archived and removed')
        self.assertIn('sync_conflict', [e['kind'] for e in self.live.history_page(REL)])

    def test_copy_turning_up_after_a_later_outside_change_needs_review(self):
        opened = self.live.open(REL)
        added = self.live.save(REL, opened['revision'], BASE.replace('middle line\n', 'middle line\nADDED\n'), client='a')
        self.report.write_text(BASE.replace('closing', 'closing (agent)'))  # an agent deleted ADDED on purpose
        self.live.open(REL)
        time.sleep(2.2)
        copy = self.report.parent / 'report.sync-conflict-20261124-101011-ABCDEFG.md'
        copy.write_text(added['content'])  # created well after that change was seen
        self.live._tick()
        self.assertNotIn('ADDED', self.report.read_text())
        self.assertTrue(copy.exists())
        self.assertEqual([c['name'] for c in self.live.open(REL)['sync_conflicts']], [copy.name])

    def test_open_never_writes_for_a_conflict_copy(self):
        opened = self.live.open(REL)
        mine = self.live.save(REL, opened['revision'], BASE.replace('intro', 'intro (board)'), client='a')
        copy = self.report.parent / 'report.sync-conflict-20261124-101012-ABCDEFG.md'
        os.rename(self.report, copy)
        self.report.write_text(BASE.replace('closing', 'closing (other device)'))
        before = self.report.read_bytes()
        self.live.open(REL)
        self.assertEqual(self.report.read_bytes(), before)
        self.assertEqual(copy.read_text(), mine['content'])

    def test_coalesced_merged_revision_stays_a_merge_base(self):
        h0 = self.live.open(REL)['revision']
        self.report.write_text(BASE.replace('closing', 'closing (agent)'))
        first = self.live.save(REL, h0, BASE.replace('intro', 'intro A'), client='a')
        self.assertEqual(first['status'], 'merged')
        tab_b = self.live.open(REL)
        self.assertEqual(tab_b['revision'], first['revision'])
        self.live.save(REL, first['revision'], first['content'].replace('title', 'title A'), client='a')  # coalesced
        result = self.live.save(REL, tab_b['revision'], tab_b['content'].replace('middle', 'middle B'), client='b')
        self.assertEqual(result['status'], 'merged')
        text = self.report.read_text()
        for expected in ('intro A', 'title A', 'middle B', 'closing (agent)'):
            self.assertIn(expected, text)

    def test_autosaves_keep_only_blobs_that_can_still_be_used(self):
        rev = self.live.open(REL)['revision']
        text = BASE
        for i in range(30):
            text += f'typed {i}\n'
            rev = self.live.save(REL, rev, text, client='a')['revision']
        count = self.live.history.db.execute('SELECT count(*) FROM blobs').fetchone()[0]
        self.assertLessEqual(count, 3, 'one coalesced typing session must not keep a copy per save')
        self.assertEqual(self.live.history.text(REL, rev), text)
        # Periodic pruning forgets bases unused for the retention window but
        # keeps every history entry.
        self.live.history.db.execute('UPDATE bases SET used=0')
        self.live.history.db.execute('UPDATE blobs SET created=0')
        self.live.pruned = -1e9
        self.live._tick()
        self.assertEqual(self.live.history.db.execute('SELECT count(*) FROM bases').fetchone()[0], 0)
        self.assertEqual(self.live.revision(REL, rev), text, 'history entries survive pruning')

    def test_non_utf8_late_write_is_put_back_and_editing_stops(self):
        raw = BASE.replace('closing', 'caf\xe9').encode('latin-1')
        for point in ('before_check', 'before_exchange'):
            with self.subTest(point=point):
                self.report.write_text(BASE)
                live = self.make(evict_seconds=0)
                opened = live.open(REL)
                self.hooks[point] = lambda: self.report.write_bytes(raw)
                with self.assertRaises(NotEditable):
                    live.save(REL, opened['revision'], BASE.replace('intro', 'intro (me)'), client='a')
                self.assertEqual(self.report.read_bytes(), raw)
                with self.assertRaises(NotEditable):
                    live.save(REL, opened['revision'], BASE.replace('intro', 'intro again'), client='a')
                with self.assertRaises(ReportUnavailable):
                    live.open(REL)
                live.close()

    def test_outside_write_right_after_a_save_is_announced(self):
        opened = self.live.open(REL)
        events = self.live.subscribe(REL)
        agent = BASE.replace('closing', 'closing (agent)')
        original = self.live._refresh_identity

        def agent_renames_in_then_refresh(doc):
            # An agent's temp-file-and-rename lands right after the exchange.
            self.live._refresh_identity = original
            temp = self.report.with_name('agent.tmp')
            temp.write_text(agent)
            os.replace(temp, self.report)
            original(doc)
        self.live._refresh_identity = agent_renames_in_then_refresh
        self.live.save(REL, opened['revision'], BASE.replace('intro', 'intro (me)'), client='a')
        while not events.empty():
            events.get_nowait()
        self.live._tick()
        self.assertEqual(events.get_nowait()['revision'], revision_of(agent))

    def test_events_for_a_missing_report_are_refused_and_idle_documents_evicted(self):
        with self.assertRaises(ReportUnavailable):
            self.live.subscribe('web_bounty/alpha/web/reports/nope.md')
        self.assertNotIn('web_bounty/alpha/web/reports/nope.md', self.live.docs)
        live = self.make(evict_seconds=0)
        live.open(REL)
        subscriber = live.subscribe(REL)
        time.sleep(0.01)
        live._tick()
        self.assertIn(REL, live.docs, 'documents with an open editor stay')
        live.unsubscribe(REL, subscriber)
        time.sleep(0.01)
        live._tick()
        self.assertNotIn(REL, live.docs)
        kinds = [e['kind'] for e in live.history_page(REL)]
        live.open(REL)
        self.assertEqual([e['kind'] for e in live.history_page(REL)], kinds, 'reopening does not duplicate history')

if __name__ == '__main__':
    unittest.main()
