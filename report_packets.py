"""One main report per finding packet.

A finding packet is a folder directly under a lane's ``reports/`` named
``<FID>`` or ``<FID>-<slug>`` (``_PACKET_DIR``). Agents leave several Markdown
files in it: the current report (``<target-domain>-<vuln-type>-<FID>.md``),
older ``SUBMISSION.md`` / ``REPORT.md`` versions, PoC notes, judge receipts,
``_archive/`` copies and so on. Only the packet's *main* report is a report in
the Board's lists; every other Markdown file in the packet is a *packet file*
of that main report: absent from the Reports list, picker, counts, Recent and
search report hits, but still opened and edited through its own route.

One helper shared by ``app.reports()`` (``/api/data``, ``/api/lane-reports``)
and ``search_index.SearchIndex`` (``/api/search``, ``/api/recent-reports``), as
``report_evidence`` is, so both indexes always agree. It decides from paths,
lstat times and the ledger only, never from file content, so packet files are
never read for the search budget. Evidence (``report_evidence.is_evidence``)
is excluded by the caller before this runs and stays exactly as it was.

Main report, from the packet's top-level non-evidence ``.md`` files
(case-insensitive throughout):

1. vuln-type report: stem ``<prefix>-<FID>`` with the folder's FID, no ``.`` in
   the stem, at least 3 hyphen-separated tokens in the prefix and a first token
   that is not a sidecar word (``SIDECAR_WORDS``);
2. ``SUBMISSION.md``;
3. ``SUBMISSION-<FID>.md``;
4. old FID reports: ``REPORT.md``, ``<FID>-REPORT.md``, ``REPORT-<FID>.md``,
   ``<FID>.md``;
5. fallback: any other top-level candidate.

Within a tier a file named by a finding's ``report_path`` wins, then the newest
mtime, then the name. ``report_path`` never moves a file to an earlier tier.
"""
import re

from report_evidence import reports_relative

PACKET_DIR = re.compile(r'^([A-Za-z][0-9]{2,})(?:-.*)?$')
LEGACY_NAME = re.compile(r'^([A-Za-z][0-9]{2,}) - .+\.md$', re.IGNORECASE)
SIDECAR_WORDS = frozenset({'submission', 'evidence', 'report', 'judge', 'poc', 'notes', 'finding', 'readme', 'draft'})
TIER_NAMES = {1: 'vuln_type', 2: 'submission', 3: 'submission_fid', 4: 'fid_report', 5: 'fallback'}
GROUPS = ('files', 'archive', 'older')


def packet_folder(rel):
    """The packet folder of a reports-relative path, or None (top-level files are in no packet)."""
    parts = rel.split('/')
    return parts[0] if len(parts) > 1 and PACKET_DIR.match(parts[0]) else None


def folder_fid(folder):
    found = PACKET_DIR.match(folder or '')
    return found.group(1) if found else None


def is_meta(rel):
    """True for a file under a packet's ``_meta/`` folder (bookkeeping, hidden like navigation)."""
    parts = rel.split('/')
    return len(parts) >= 3 and PACKET_DIR.match(parts[0]) is not None and '_meta' in parts[1:-1]


def counts_for_time(rel):
    """True when a file inside a packet moves the packet's time: regular files
    except dot names, ``*.tmp`` and anything under ``_meta/``."""
    parts = rel.split('/')
    if len(parts) < 2:
        return False
    return (not any(p.startswith('.') for p in parts[1:]) and not parts[-1].lower().endswith('.tmp')
            and '_meta' not in parts[1:-1])


def tier(name, fid):
    """Main-report tier (1 best .. 5 fallback) of a top-level packet file name, or None if not a candidate."""
    if not name.lower().endswith('.md') or name.startswith('.'):
        return None
    stem = name[:-3].lower()
    fid = fid.lower()
    if '.' not in stem and stem.endswith('-' + fid):
        tokens = [t for t in stem[:-len(fid) - 1].split('-') if t]
        if len(tokens) >= 3 and tokens[0] not in SIDECAR_WORDS:
            return 1
    if stem == 'submission':
        return 2
    if stem == 'submission-' + fid:
        return 3
    if stem in ('report', fid + '-report', 'report-' + fid, fid):
        return 4
    return 5


class Packets:
    """The packet plan of one lane.

    ``mains``: ``{main rel: {'packet', 'fid', 'tier', 'modified', 'updated_file',
    'evidence', 'owner_fids', 'finding'}}``. ``files``: ``{rel: {'packet', 'main',
    'group'}}`` for every packet file (and adopted legacy copy). A path in
    neither is unaffected (flat reports, ``_meta`` files, files of packets
    without a main report, unrelated reports).
    """

    def __init__(self):
        self.mains = {}
        self.files = {}

    def main_for(self, rel):
        """The listed report for a path: its main when it is a packet file, else itself."""
        info = self.files.get(rel)
        return info['main'] if info else rel


def plan(md_files, findings, lane, other_files=(), evidence_files=(), is_navigation=None):
    """Build the lane's packet plan.

    ``md_files``: ``(rel, mtime)`` of every non-evidence ``.md`` file under
    ``reports/`` (any depth). ``evidence_files``: ``(rel, mtime)`` of evidence
    ``.md`` files. ``other_files``: ``(rel, mtime)`` of other regular files
    (only those inside a packet matter, for the packet time). ``findings``:
    the lane ledger (or None). ``is_navigation(rel)``: optional; asked only for
    fallback-tier candidates (rare), so a generated navigation page is never a
    main. Asked only when a packet has no tier 1-4 candidate; a navigation page
        found that way is left as it is today (neither main nor packet file).
    """
    result = Packets()
    md = dict(md_files)
    other_files, evidence_files = list(other_files), list(evidence_files)
    # Ledger report paths (case-insensitive) and their owners.
    registered = {}
    fids_seen = {}
    for f in findings or []:
        if not isinstance(f, dict):
            continue
        fid = f.get('fid')
        if isinstance(fid, str) and fid:
            fids_seen.setdefault(fid.upper(), []).append(fid)
        relative = reports_relative(f.get('report_path'), lane)
        if relative and fid:
            registered.setdefault(relative.lower(), []).append(str(fid))
    unique = {key: v[0] for key, v in fids_seen.items() if len(v) == 1}

    folders = {}
    for rel in md:
        folder = packet_folder(rel)
        if folder:
            folders.setdefault(folder, []).append(rel)
    times = {}
    for rel, mtime in list(md.items()) + list(other_files) + list(evidence_files):
        folder = packet_folder(rel)
        if folder and mtime is not None and counts_for_time(rel):
            times.setdefault(folder, []).append((mtime, rel))
    evidence_by_folder = {}
    for rel, _ in evidence_files:
        folder = packet_folder(rel)
        if folder:
            evidence_by_folder.setdefault(folder, []).append(rel)

    for folder, rels in folders.items():
        fid = folder_fid(folder)
        # A file the ledger registers only to findings with another FID is that
        # finding's report, not part of this packet: it stays listed as today,
        # never becomes main or a packet file, and lends no owner or time here.
        foreign = {rel.lower() for rel in rels
                   if registered.get(rel.lower()) and all(o.upper() != (fid or '').upper() for o in registered[rel.lower()])}
        rels = [rel for rel in rels if rel.lower() not in foreign]
        navigation = set()
        candidates = []
        for rel in rels:
            parts = rel.split('/')
            if len(parts) != 2:
                continue
            rank = tier(parts[1], fid)
            if rank is None:
                continue
            mtime = md[rel] if md[rel] is not None else float('-inf')
            candidates.append((rank, rel.lower() not in registered, -mtime, rel.lower(), rel))
        if candidates and is_navigation is not None and min(c[0] for c in candidates) == 5:
            # Only fallback candidates left (rare): read them so a generated
            # navigation page never becomes the main report.
            navigation = {c[-1] for c in candidates if is_navigation(c[-1])}
            candidates = [c for c in candidates if c[-1] not in navigation]
        if not candidates:
            continue
        candidates.sort()
        main = candidates[0][-1]
        prefix = folder.lower() + '/'
        in_packet = {}
        for path, owners in registered.items():
            if path.startswith(prefix) and path not in foreign:
                for owner in owners:
                    in_packet.setdefault(owner, set()).add(path)
        owner_fids = sorted(in_packet, key=lambda x: (x.upper(), x))
        newest = max((t for t in times.get(folder, []) if t[1].lower() not in foreign),
                     default=None, key=lambda t: (t[0], t[1]))
        main_time = md[main]
        modified = main_time
        updated = None
        if newest is not None and (main_time is None or newest[0] > main_time):
            modified, updated = newest[0], newest[1][len(folder) + 1:]
        result.mains[main] = {'packet': folder, 'fid': fid, 'tier': TIER_NAMES[candidates[0][0]],
                              'modified': modified, 'updated_file': updated,
                              'evidence': sorted(evidence_by_folder.get(folder, [])),
                              'owner_fids': owner_fids,
                              'finding': _packet_finding(main, in_packet, unique, fid)}
        for rel in rels:
            if rel == main or is_meta(rel) or rel in navigation:
                continue
            parts = rel.split('/')
            group = 'archive' if any(p.startswith('_') for p in parts[1:-1]) else 'files'
            result.files[rel] = {'packet': folder, 'main': main, 'group': group}

    # Legacy generated copies "<FID> - <title>.md" outside packets join the
    # packet of the finding they map to (the packet holding its report_path,
    # else the only packet folder with that FID).
    mains_by_folder = {info['packet']: rel for rel, info in result.mains.items()}
    all_folders = sorted({packet_folder(r) for r, _ in list(md.items()) + list(other_files) + list(evidence_files)} - {None})
    known = {name.lower(): name for name in all_folders}
    for rel in md:
        if packet_folder(rel):
            continue
        found = LEGACY_NAME.match(rel.rsplit('/', 1)[-1])
        if not found or found.group(1).upper() not in unique:
            continue
        fid = unique[found.group(1).upper()]
        owners = set(registered.get(rel.lower(), []))
        if owners and owners != {fid}:
            continue
        holding = None
        for f in findings or []:
            if isinstance(f, dict) and f.get('fid') == fid:
                relative = reports_relative(f.get('report_path'), lane)
                if relative and packet_folder(relative) and (folder_fid(packet_folder(relative)) or '').upper() == fid.upper():
                    holding = known.get(packet_folder(relative).lower(), holding)
        if holding is not None:
            folder = holding
        else:
            same = [name for name in all_folders if folder_fid(name).upper() == fid.upper()]
            folder = same[0] if len(same) == 1 else None
        main = mains_by_folder.get(folder) if folder else None
        if main:
            result.files[rel] = {'packet': folder, 'main': main, 'group': 'older'}
    return result


def _packet_finding(main, in_packet, unique, fid):
    """(fid, match) for a packet's Recent row: the finding whose report_path lies
    in the packet (the main's own owner when several do), else the packet FID."""
    candidates = [owner for owner in in_packet if unique.get(owner.upper()) == owner]
    if len(candidates) > 1:
        candidates = [owner for owner in candidates if main.lower() in in_packet[owner]]
    if len(candidates) == 1:
        return candidates[0], 'report_path'
    if fid.upper() in unique:
        return unique[fid.upper()], 'packet'
    return None, None
