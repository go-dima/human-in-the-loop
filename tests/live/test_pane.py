"""The My tasks pane as a real Claude Code draws it, at narrow and wide widths.

Run with `python3 tests/live/test_pane.py` from the repository's root, with
`claude` and `tmux` on the PATH. Each case seeds tasks an ended session left,
opens /my-tasks in a terminal of the given size and reads the screen back:
every title shows whole, nothing is cut off at the pane's bottom, and the
pane asks for no rows it leaves empty. With RENDERS_DIR set, each screen a
test reads is kept there, and `tests/live/renders.py` lays them out.
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from screen import Claude, pane_body  # noqa: E402

ROOT = os.environ.get('PLUGIN_DIR') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WIDTHS = (36, 48, 64, 100)
# Tall enough that the layout spares the pane every row it asks for.
HEIGHT = 90

INSTRUMENTS = 'Open Instruments from Xcode and record with the Activity Monitor template'
XCODE = 'Run xcodebuild test on your Mac and paste every failure you see here please'
GERMAN = 'Datenbankverbindungseinstellungsüberprüfungsprotokoll im Ordner ablegen'
JAPANESE = 'ステージング環境のデータベース移行を承認してください'
# Longer than a title may be assigned: an older version's, left in the store.
LONG = 'Rotate the deploy key ' + ' '.join(['and check every runner that holds it'] * 3)

TASKS = [
    {'id': 1, 'title': INSTRUMENTS, 'why': 'I need a trace of the launch to see where the 4 seconds go.', 'doneWhen': 'The .trace file is in ~/traces.'},
    {'id': 2, 'title': XCODE, 'why': "I can't run Xcode here.", 'kind': 'answer'},
    {'id': 3, 'title': GERMAN, 'why': 'Die Prüfung braucht es.'},
    {'id': 4, 'title': JAPANESE, 'why': 'The migration drops a column.', 'kind': 'choose', 'options': ['Approve', 'Wait for Monday']},
]

DAY_MS = 86_400_000

# Five tasks a day or more old, as a live session showed them on 0.1.4: the
# other tasks' ages fell into a column one character wide.
OLDER = [
    {'id': 6, 'title': 'Review and merge PR #1591 (alerts read access for release agents)', 'why': 'It documents how anyone, including an agent, reads prod alerts during a release. Merging it is your call.', 'doneWhen': 'PR #1591 is merged or closed.', 'ageMs': DAY_MS},
    {'id': 27, 'title': 'Update Slack Voice to 0.2.0 and retry /slack after a Claude Slack draft', 'why': 'w', 'ageMs': 5 * DAY_MS},
    {'id': 28, 'title': 'Review the Mira in the Fiverr App plan, then share it', 'why': 'w', 'ageMs': 5 * DAY_MS},
    {'id': 35, 'title': 'Review the supply-gaps method doc and draft workbook, then send to Shimon', 'why': 'w', 'ageMs': 5 * DAY_MS},
    {'id': 36, 'title': 'Approve the staging migration', 'why': 'w', 'ageMs': 5 * DAY_MS},
]

SAVED = [
    {'id': 5, 'title': LONG, 'why': 'It leaked.', 'state': 'done', 'update': 'pending'},
]


def flat(text):
    """Text as one line: the pane's wrapping and the frame's padding gone."""
    return re.sub(r'\s+', ' ', text).strip()


def joined(body):
    """The pane's body read as prose: its rows joined, the glyphs and indents gone."""
    return flat(' '.join(re.sub(r'^[☐✓✗]\s', '', row.strip()) for row in body))


class Pane(unittest.TestCase):
    def draw(self, tasks, columns, keys=()):
        claude = Claude(ROOT)
        try:
            claude.seed(tasks)
            name = '-'.join([self._testMethodName, str(columns), *keys])
            screen = claude.pane(columns, HEIGHT, keys, name=name)
        finally:
            claude.close()
        body = pane_body(screen)
        context = f'at {columns} columns the pane drew:\n' + '\n'.join(body)
        return body, context

    def assert_fits(self, body, context):
        # The foot is the last row, a blank one above it: none cut off below
        # it, and none asked for and left empty.
        self.assertIn('Hide', body[-1], context)
        self.assertEqual(body[-2].strip(), '', context)
        self.assertNotEqual(body[-3].strip(), '', 'a row asked for and left empty\n' + context)

    def test_titles_wrap_whole_and_the_pane_fits_them(self):
        # As many tasks as fit the pane's 18 rows at each width.
        for columns, tasks in ((36, TASKS[:2]), (48, TASKS[:1] + TASKS[2:]), (64, TASKS), (100, TASKS)):
            with self.subTest(columns=columns):
                body, context = self.draw(tasks, columns)
                text = joined(body)

                self.assert_fits(body, context)
                self.assertIn(f'#1 {INSTRUMENTS} 3m · from an earlier session', text, context)
                self.assertIn('d: Done', text, context)
                self.assertIn('x: Reject…', text, context)

                if XCODE in [task['title'] for task in tasks]:
                    self.assertIn(f'#2 {XCODE} 3m · from an earlier session', text, context)

                if GERMAN in [task['title'] for task in tasks]:
                    # A word longer than the row breaks where the row ends, nothing lost.
                    self.assertIn(f'#3{GERMAN}3m·fromanearliersession'.replace(' ', ''), text.replace(' ', ''), context)
                    self.assertIn(f'#4{JAPANESE}3m·fromanearliersession', text.replace(' ', ''), context)

    def test_five_older_tasks_show_each_title_and_age_whole(self):
        body, context = self.draw(OLDER, 66)
        text = joined(body)

        self.assert_fits(body, context)
        self.assertIn(f"#6 {OLDER[0]['title']} 1d · from an earlier session", text, context)
        for task in OLDER[1:]:
            self.assertIn(f"#{task['id']} {task['title']} 5d · from an earlier session", text, context)

    def test_a_pane_taller_than_its_rows_scrolls_and_squeezes_nothing(self):
        body, context = self.draw(TASKS, 36)

        self.assertEqual(len(body), 18, context)
        # The rows in view are whole: none pressed into another.
        self.assertIn(f'#2 {XCODE} 3m · from an earlier session', joined(body), context)

    def test_the_age_never_wraps_into_a_column_of_its_own(self):
        for columns in WIDTHS:
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[:1], columns)
                rows = [row for row in body if row.strip() != '']
                # Each row of the title starts at the title's indent: the age flows after it.
                title_rows = rows[1 : 1 + next(i for i, row in enumerate(rows[1:]) if 'I need a trace' in row)]
                for row in title_rows[1:]:
                    self.assertTrue(row.startswith('  ') and not row.startswith('   '), 'a title row out of line\n' + context)
                self.assertIn('3m · from an earlier session', joined(title_rows), context)

    def test_saved_responses_and_titles_past_80_characters_show_whole(self):
        for columns in (48, 64):
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[1:2] + SAVED, columns)
                # Send now sits beside the title's first row.
                text = joined(body).replace(' s: Send now', '')

                self.assert_fits(body, context)
                self.assertIn(f'#5 {LONG} · not sent yet', text, context)
                self.assertIn('s: Send now', body[next(i for i, row in enumerate(body) if '#5' in row)], context)

    def test_an_open_answer_field_fits(self):
        for columns in (36, 64):
            with self.subTest(columns=columns):
                body, context = self.draw(TASKS[1:2], columns, keys=('r',))
                text = joined(body)

                self.assert_fits(body, context)
                self.assertIn('Answer ›', text, context)
                self.assertIn('Cancel', text, context)


class TranscriptRow(unittest.TestCase):
    def test_the_label_stays_whole_and_the_title_wraps_after_it(self):
        for columns in (40, 64):
            with self.subTest(columns=columns):
                claude = Claude(ROOT)
                try:
                    tool_input = {'title': XCODE, 'why': "I can't run Xcode here.", 'kind': 'answer'}
                    screen = claude.transcript(columns, 40, tool_input, name=f'{self._testMethodName}-{columns}')
                finally:
                    claude.close()
                lines = screen.split('\n')
                start = next(i for i, line in enumerate(lines) if '☐' in line)
                row = flat(' '.join(lines[start : start + 4]).split('───')[0])

                self.assertIn('☐ Assigned you a task: ', lines[start], screen)
                self.assertIn(f'☐ Assigned you a task: {XCODE}', row, screen)


if __name__ == '__main__':
    unittest.main(verbosity=2)
