import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("cleanup", Path(__file__).parents[1] / "modules/apps/seedbox-cleanup.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def torrent():
    return {"label": "sonarr", "private": True, "state": "Seeding", "is_finished": True,
            "progress": 100, "save_path": c.REMOTE + "/sonarr", "seeding_time": 7 * c.DAY,
            "files": [{"path": "Season/one.mkv", "size": 4}, {"path": "Season/two.mkv", "size": 4}],
            "file_progress": [1, 1], "file_priorities": [1, 1],
            "trackers": [{"url": "https://tracker.torrentleech.org/example/announce"}]}


def table(ratio="0.4", seed_time="6 days 2 hours", hnr="No", tid="123"):
    headers = ["Name", "Size", "Sna", "Dld", "Uld", "Rto", "Ann", "Co", "Act.", "S.T.", "HnR", "Cl."]
    cells = [f'<a href="/torrent/{tid}">Example</a>', "8", "1", "8", "4", ratio, "100", "Yes", "Yes", seed_time, hnr, "Deluge"]
    return '<table id="profile-snatchListTable"><tr>' + ''.join('<th>' + h + '</th>' for h in headers) + '</tr><tr>' + ''.join('<td>' + v + '</td>' for v in cells) + '</tr></table>'


class CleanupSafety(unittest.TestCase):
    def test_seven_active_days_not_six_or_high_ratio(self):
        c.torrent_gate(torrent(), 6)
        t = torrent(); t['seeding_time'] = 7 * c.DAY - 1; t['ratio'] = 100
        with self.assertRaises(c.Hold): c.torrent_gate(t, 6)

    def test_partial_paused_unknown_tracker_and_wrong_path_retained(self):
        for delta in [{"file_priorities": [1, 0]}, {"file_progress": [1, .9]}, {"state": "Paused"},
                      {"private": False}, {"label": "manual"}, {"save_path": "/other"},
                      {"trackers": [{"url": "https://evil.example/announce"}]}]:
            with self.subTest(delta=delta), self.assertRaises(c.Hold):
                c.torrent_gate(torrent() | delta, 6)

    def test_tracker_time_or_ratio_but_never_unknown_evidence(self):
        c.tracker_clearance(table(), "123", 6)
        c.tracker_clearance(table(ratio="1.1", seed_time="0 days"), "123", 6)
        for page in [table(seed_time="5 days"), table(seed_time="999999"), table(hnr="Yes"),
                     table(hnr=""), table(tid="456"), table().replace("Rto", "Changed")]:
            with self.subTest(page=page), self.assertRaises(c.Hold): c.tracker_clearance(page, "123", 6)

    def test_tracker_login_and_class_are_required(self):
        page = '<a href="/user/account/logout">Logout</a><td>Class</td><td>Extreme User</td><span class="profile-ratio-details">52.873</span>'
        self.assertEqual(c.tracker_account(page), ("Extreme User", 52.873))
        for bad in [page.replace("Extreme User", "Unknown"), page.replace("52.873", "NaN"), "login"]:
            with self.assertRaises((c.Hold, ValueError)): c.tracker_account(bad)

    def test_grab_receipt_requires_exact_tracker_and_unique_id(self):
        event = {"eventType": "grabbed", "data": {"nzbInfoUrl": "https://www.torrentleech.org/torrent/123"}}
        self.assertEqual(c.tracker_id([event]), "123")
        with self.assertRaises(c.Hold): c.tracker_id([])
        second = copy.deepcopy(event); second['data']['nzbInfoUrl'] = 'https://www.torrentleech.org/torrent/456'
        with self.assertRaises(c.Hold): c.tracker_id([event, second])

    def test_pack_requires_every_import_and_matching_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); inbox = root / 'sources/seedbox/deluge/sonarr/Season'; library = root / 'library/tv/Series'
            inbox.mkdir(parents=True); library.mkdir(parents=True)
            history = []
            for name in ['one.mkv', 'two.mkv']:
                (inbox/name).write_bytes(b'data'); (library/name).write_bytes(b'data')
                history.append({'eventType': 'downloadFolderImported', 'data': {
                    'droppedPath': '/media/sources/seedbox/deluge/sonarr/Season/' + name,
                    'importedPath': '/media/library/tv/Series/' + name}})
            self.assertEqual(c.import_proof(torrent(), history, 'sonarr', root), 2)
            with self.assertRaises(c.Hold): c.import_proof(torrent(), history[:1], 'sonarr', root)
            (library/'two.mkv').write_bytes(b'evil')
            with self.assertRaises(c.Hold): c.import_proof(torrent(), history, 'sonarr', root)
            (library/'two.mkv').unlink()
            with self.assertRaises(c.Hold): c.import_proof(torrent(), history, 'sonarr', root)

    def test_archive_and_traversal_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); inbox = root / 'sources/seedbox/deluge/sonarr'; inbox.mkdir(parents=True)
            (inbox/'movie.rar').write_bytes(b'data')
            t = torrent(); t['files'] = [{'path': 'movie.rar', 'size': 4}]
            with self.assertRaises(c.Hold): c.import_proof(t, [], 'sonarr', root)
            for path in ['../escape.mkv', '/absolute.mkv']:
                with self.assertRaises(c.Hold): c.safe_path(inbox, path)
            (inbox/'linked').symlink_to(root)
            with self.assertRaises(c.Hold): c.safe_path(inbox, 'linked/file.mkv')


if __name__ == '__main__':
    unittest.main()
