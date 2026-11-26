"""Evidence files are artifacts of a finding, not reports.

One classifier shared by ``app.reports()`` (``/api/data``, ``/api/lane-reports``)
and ``search_index.SearchIndex`` (``/api/search``, ``/api/recent-reports``), so
both indexes always agree, in the same way ``report_publisher.generated_navigation``
is shared for navigation pages.

A ``.md`` file under a lane's ``reports/`` is *evidence* when no finding's
``report_path`` names it and either its basename is ``EVIDENCE.md``
(case-insensitive) or some finding's ``evidence_path`` names it. A file that a
``report_path`` names stays a report even when it is called ``EVIDENCE.md``.

The decision needs only the path and the ledger, never the file content, so
callers skip evidence before reading it.
"""
import posixpath
from pathlib import Path

EVIDENCE_NAME = 'evidence.md'


def reports_relative(recorded, lane):
    """Map a ledger-recorded path to a path relative to ``<lane>/reports/``, or None.

    Relative paths are lane-relative (``reports/...``). Absolute paths match
    under this lane's own ``reports/`` folder, else by their last
    ``/<family>/<program>/<lane>/reports/`` segment, so ledgers written on
    another host (another mount point) still resolve, as
    ``report_artifacts.recorded_relative`` does.
    """
    if not isinstance(recorded, str) or not recorded.strip() or '\0' in recorded or '\n' in recorded:
        return None
    value = recorded.strip()
    lane = Path(lane)
    if value.startswith('/'):
        base = posixpath.normpath(lane.as_posix() + '/reports')
        normal = posixpath.normpath(value)
        if normal.startswith(base + '/'):
            rest = normal[len(base) + 1:]
        else:
            marker = f'/{lane.parent.parent.name}/{lane.parent.name}/{lane.name}/reports/'
            index = value.rfind(marker)
            if index < 0:
                return None
            rest = value[index + len(marker):]
    else:
        normal = posixpath.normpath(value)
        if not normal.startswith('reports/'):
            return None
        rest = normal[len('reports/'):]
    rest = posixpath.normpath(rest) if rest else ''
    if not rest or rest == '.' or rest.startswith('../') or rest == '..' or rest.startswith('/'):
        return None
    return rest


def recorded_paths(findings, lane):
    """(report_paths, evidence_paths): sets of reports-relative paths named by the ledger."""
    report_paths, evidence_paths = set(), set()
    for finding in findings or []:
        if not isinstance(finding, dict):
            continue
        for field, into in (('report_path', report_paths), ('evidence_path', evidence_paths)):
            relative = reports_relative(finding.get(field), lane)
            if relative:
                into.add(relative)
    return report_paths, evidence_paths


def is_evidence(relative, report_paths, evidence_paths):
    """True when ``reports/<relative>`` is a finding's evidence artifact, not a report."""
    if relative in report_paths:
        return False
    return posixpath.basename(relative).lower() == EVIDENCE_NAME or relative in evidence_paths
