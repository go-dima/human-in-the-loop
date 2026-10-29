"""Draws the My tasks pane in a real Claude Code, in tmux, and prints the screen.

The test kit checks the tree the plugin returns, never how a terminal lays it
out. This runs the real engine instead: a throwaway config folder, the store
seeded with tasks an ended session left, `/my-tasks`, and `tmux capture-pane`
at the width asked for. No model is called, so a dummy API key does.
"""

import hashlib
import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

KEY = 'render-check-not-a-real-key'


def run(*args, check=True, **kw):
    return subprocess.run(args, check=check, capture_output=True, text=True, **kw)


def capture(session, escapes=False):
    """The screen as text; with `escapes`, its colors and styles kept as the terminal's escape codes."""
    return run('tmux', 'capture-pane', '-p', *(['-e'] if escapes else []), '-t', session).stdout


# Set, every screen a test reads is kept there too, for a person to look over.
RENDERS = os.environ.get('RENDERS_DIR')
kept = 0


def keep(styled, name):
    """Saves a screen read with its escapes under RENDERS_DIR, numbered in the order the tests read them."""
    global kept

    if not RENDERS:
        return

    kept += 1
    os.makedirs(RENDERS, exist_ok=True)
    # Only what a file name and the artifact's upload both take.
    safe = re.sub(r'[^A-Za-z0-9._-]+', '_', name)
    with open(os.path.join(RENDERS, f'{kept:03d}-{safe}.ansi'), 'w') as f:
        f.write(styled)


# What `capture-pane -e` adds to the text: colors and styles, and any other CSI or OSC sequence.
ESCAPES = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def snapshot(session, name=None):
    """The screen as text, read once and kept as `name` when given, colors and all: what is kept is what a test reads."""
    styled = capture(session, escapes=True)
    if name is not None:
        keep(styled, name)
    # As the plain capture reads it: that trims the spaces ending a row,
    # styled ones too.
    return '\n'.join(line.rstrip(' ') for line in ESCAPES.sub('', styled).split('\n'))


def wait_for(session, predicate, timeout=30.0):
    end = time.time() + timeout
    screen = ''
    while time.time() < end:
        screen = capture(session)
        if predicate(screen):
            return screen
        time.sleep(0.25)
    raise TimeoutError(f'timed out; the screen was:\n{screen}')


class Claude:
    """One Claude Code in a tmux window of its own, in a folder of its own."""

    def __init__(self, plugin_dir, claude='claude'):
        self.plugin_dir = os.path.abspath(plugin_dir)
        self.claude = shutil.which(claude) or claude
        self.home = tempfile.mkdtemp(prefix='hitl-screen-')
        self.config = os.path.join(self.home, 'config')
        self.project = os.path.join(self.home, 'project')
        os.makedirs(self.config)
        os.makedirs(self.project)
        with open(os.path.join(self.config, '.claude.json'), 'w') as f:
            json.dump(
                {
                    'hasCompletedOnboarding': True,
                    'theme': 'dark',
                    'customApiKeyResponses': {'approved': [KEY[-20:]], 'rejected': []},
                    'projects': {self.project: {'hasTrustDialogAccepted': True}},
                },
                f,
            )
        self.session = f'hitl-{os.getpid()}-{int(time.time() * 1000) % 100000}'

    def env(self):
        keep = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL') if k in os.environ}
        return {
            **keep,
            'HOME': self.home,
            'TERM': 'xterm-256color',
            'LANG': os.environ.get('LANG') or 'C.UTF-8',
            'CLAUDE_CONFIG_DIR': self.config,
            'ANTHROPIC_API_KEY': KEY,
        }

    def start(self, columns, rows, *args):
        command = ' '.join(
            [
                'exec env -i',
                *[f"{k}='{v}'" for k, v in self.env().items()],
                f"'{self.claude}' --plugin-dir '{self.plugin_dir}'",
                *args,
            ]
        )
        run('tmux', '-u', 'new-session', '-d', '-s', self.session, '-x', str(columns), '-y', str(rows), '-c', self.project, command)
        screen = wait_for(self.session, lambda s: any(line.startswith('❯') for line in s.split('\n')))
        # The prompt draws before it reads keys: type once it echoes them.
        return screen

    def type(self, text):
        deadline = time.time() + 20
        while time.time() < deadline:
            run('tmux', 'send-keys', '-t', self.session, '-l', text)
            try:
                wait_for(self.session, lambda s: text in s.split('❯')[-1], timeout=2)
                return
            except TimeoutError:
                run('tmux', 'send-keys', '-t', self.session, 'C-u')
        raise TimeoutError(f'the prompt never showed {text!r}:\n{capture(self.session)}')

    def command(self, text):
        self.type(text)
        time.sleep(0.3)
        run('tmux', 'send-keys', '-t', self.session, 'Enter')

    def stop(self):
        pid = run('tmux', 'display-message', '-p', '-t', self.session, '#{pane_pid}', check=False).stdout.strip()
        run('tmux', 'kill-session', '-t', self.session, check=False)
        # Claude Code writes the store as it ends: wait it out before the folder goes.
        deadline = time.time() + 15
        while pid.isdigit() and time.time() < deadline:
            try:
                os.kill(int(pid), 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)

    def store_file(self):
        """The plugin's store, as the engine names it for a plugin loaded with --plugin-dir."""
        digest = hashlib.sha256(b'human-in-the-loop@inline').hexdigest()[:12]
        return os.path.join(self.config, 'plugins', 'store', f'human-in-the-loop_inline-{digest}.json')

    def seed(self, tasks):
        """Leaves `tasks` in the store as an ended session's, for the next one to take on."""
        now_ms = int(time.time() * 1000)
        slot = {
            'tasks': [
                {
                    'state': 'open',
                    'update': 'none',
                    'kind': 'do',
                    'sessionId': 'earlier',
                    'createdMs': now_ms - task.get('ageMs', 180_000),
                    'updatedMs': now_ms - task.get('ageMs', 180_000),
                    **{k: v for k, v in task.items() if k != 'ageMs'},
                }
                for task in tasks
            ],
            'seenMs': now_ms - 600_000,
            'endedMs': now_ms - 600_000,
            'nextId': max(task['id'] for task in tasks) + 1,
        }
        # keysOf keys a root this long by a hash: the seed would sit where no session reads.
        assert len(f'tasks:{self.project}#session:') + 64 <= 256, f'{self.project} is too long a path for the seeded key'
        path = self.store_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # The ended session's slot, under its own key; no session runs yet to write over it.
        with open(path, 'w') as f:
            json.dump({f'tasks:{self.project}#session:earlier': slot}, f)

    def pane(self, columns, rows, keys=(), name=None):
        """The screen with the pane opened by /my-tasks, after `keys`; kept as `name` when given."""
        self.start(columns, rows)
        # The session takes the tasks on as it starts; the status line counts
        # them once it has. /my-tasks typed before that finds none.
        try:
            wait_for(self.session, lambda s: 'human-in-the-loop: ☐' in s or 'human-in-the-loop: ✓' in s)
        except TimeoutError as error:
            # The engine names the store's file; the seed goes where store_file() says it does.
            raise RuntimeError(
                f'the session took on none of the tasks seeded in {self.store_file()}: '
                'if the engine names a --plugin-dir store otherwise now, store_file() must follow'
            ) from error
        self.command('/my-tasks')
        wait_for(self.session, has_pane)
        if keys:
            # The pane takes the keys when the prompt lets it; else ctrl+x tab hands them over.
            try:
                wait_for(self.session, lambda s: 'Esc: back to the prompt' in s, timeout=3)
            except TimeoutError:
                run('tmux', 'send-keys', '-t', self.session, 'C-x', 'Tab')
                wait_for(self.session, lambda s: 'Esc: back to the prompt' in s, timeout=10)
        for key in keys:
            run('tmux', 'send-keys', '-t', self.session, key)
            time.sleep(0.5)
        # Keys that close the pane and open it again leave it to come back.
        wait_for(self.session, has_pane)
        time.sleep(1.0)
        return snapshot(self.session, name)

    def transcript(self, columns, rows, tool_input, name=None):
        """The screen of a session resumed from a transcript where Claude called assign_task; kept as `name` when given."""
        session = str(uuid.uuid4())
        folder = os.path.join(self.config, 'projects', re.sub(r'[^A-Za-z0-9]', '-', self.project))
        os.makedirs(folder, exist_ok=True)
        prompt, call, result = (str(uuid.uuid4()) for _ in range(3))
        base = {'isSidechain': False, 'userType': 'external', 'cwd': self.project, 'sessionId': session, 'timestamp': '2026-10-13T12:00:00.000Z'}
        message = {
            'id': 'msg_render_check',
            'type': 'message',
            'role': 'assistant',
            'model': 'claude-opus-5-5',
            'content': [{'type': 'tool_use', 'id': 'toolu_render_check', 'name': 'mcp__human-in-the-loop__assign_task', 'input': tool_input}],
            'stop_reason': 'tool_use',
            'usage': {'input_tokens': 1, 'output_tokens': 1},
        }
        rows_of = [
            {**base, 'parentUuid': None, 'type': 'user', 'uuid': prompt, 'message': {'role': 'user', 'content': 'fix the login bug'}},
            {**base, 'parentUuid': prompt, 'type': 'assistant', 'uuid': call, 'message': message},
            {
                **base,
                'parentUuid': call,
                'type': 'user',
                'uuid': result,
                'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'toolu_render_check', 'content': 'Assigned task #1'}]},
            },
        ]
        with open(os.path.join(folder, f'{session}.jsonl'), 'w') as f:
            f.write(''.join(json.dumps(row) + '\n' for row in rows_of))
        self.start(columns, rows, '--resume', session)
        wait_for(self.session, lambda s: '☐' in s)
        time.sleep(1.0)
        return snapshot(self.session, name)

    def close(self):
        self.stop()
        shutil.rmtree(self.home, ignore_errors=True)


def has_pane(screen):
    """Whether the pane is drawn whole, around its head or a task, which lead with ☐ or ✓ as the status line does not: framed above the prompt, or docked beside the transcript."""
    try:
        return any(row.startswith(('☐', '✓')) for row in pane_body(screen))
    except StopIteration:
        return False


def placement(screen):
    """Where the pane is drawn: `inline`, framed above the prompt, or `dock`, beside the transcript."""
    return 'inline' if frame_top(screen.split('\n')) is not None else 'dock'


def frame_top(lines):
    """The row a framed pane starts on: its frame's top, with the close mark. A toast's frame has none."""
    return next((i for i, line in enumerate(lines) if line.lstrip().startswith('╭') and '✕' in line), None)


def pane_body(screen):
    """The pane's rows in order, its frame and padding stripped."""
    lines = screen.split('\n')
    top = frame_top(lines)
    if top is None:
        return dock_body(lines)
    bottom = next(i for i, line in enumerate(lines) if i > top and line.lstrip().startswith('╰'))
    return [line.strip()[1:-1].rstrip()[1:] if line.strip().startswith('│') else line for line in lines[top + 1 : bottom]]


def dock_body(lines):
    """The rows right of the rule a docked pane draws down the screen's height, its close mark's row gone."""
    columns = [{i for i, c in enumerate(line) if c == '│'} for line in lines]
    rule = max(set().union(*columns), key=lambda i: sum(i in found for found in columns), default=None)
    if rule is None or sum(rule in found for found in columns) < len(lines) // 2:
        raise StopIteration
    return [line[rule + 1 :].rstrip() for line in lines if len(line) > rule and line[rule] == '│'][1:]


if __name__ == '__main__':
    tasks = json.load(open(sys.argv[2]))
    columns = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    claude = Claude(sys.argv[1])
    try:
        claude.seed(tasks)
        print(claude.pane(columns, int(sys.argv[4]) if len(sys.argv) > 4 else 50))
    finally:
        claude.close()
