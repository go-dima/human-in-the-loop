"""Draws the My tasks pane in a real Claude Code, in tmux, and prints the screen.

The test kit checks the tree the plugin returns, never how a terminal lays it
out. This runs the real engine instead: a throwaway config folder, the store
seeded with tasks an ended session left, `/my-tasks`, and `tmux capture-pane`
at the width asked for. No model is called, so a dummy API key does.
"""

import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

KEY = 'sk-ant-api00-render-check-not-a-real-key'


def run(*args, check=True, **kw):
    return subprocess.run(args, check=check, capture_output=True, text=True, **kw)


def capture(session):
    return run('tmux', 'capture-pane', '-p', '-t', session).stdout


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
        # Claude Code writes the store as it ends: wait it out, or it writes over the seed.
        deadline = time.time() + 15
        while pid.isdigit() and time.time() < deadline:
            try:
                os.kill(int(pid), 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)

    def store_file(self):
        folder = os.path.join(self.config, 'plugins', 'store')
        for name in os.listdir(folder) if os.path.isdir(folder) else []:
            if name.startswith('human-in-the-loop'):
                return os.path.join(folder, name)
        return None

    def seed(self, tasks):
        """Leaves `tasks` in the store as an ended session's, for the next one to take on."""
        # The store's file is named by the engine: one session makes it.
        self.start(80, 30)
        self.command('/my-tasks')
        deadline = time.time() + 15
        while self.store_file() is None and time.time() < deadline:
            time.sleep(0.25)
        self.stop()
        path = self.store_file()
        if path is None:
            raise RuntimeError('the plugin made no store; did it load?')
        now_ms = int(time.time() * 1000)
        slot = {
            'tasks': [
                {'state': 'open', 'update': 'none', 'kind': 'do', 'sessionId': 'earlier', 'createdMs': now_ms - 180_000, 'updatedMs': now_ms - 180_000, **task}
                for task in tasks
            ],
            'seenMs': now_ms - 600_000,
            'endedMs': now_ms - 600_000,
        }
        next_id = max(task['id'] for task in tasks) + 1
        seeded = {f'tasks:{self.project}': {'nextId': next_id, 'sessions': {'earlier': slot}, 'taken': {}}}
        # Write it until it stays: a session ending late may write its own over it.
        for _ in range(20):
            with open(path, 'w') as f:
                json.dump(seeded, f)
            time.sleep(0.5)
            with open(path) as f:
                if json.load(f) == seeded:
                    return
        raise RuntimeError('the seeded store kept being written over')

    def pane(self, columns, rows, keys=()):
        """The screen with the pane opened by /my-tasks, after `keys`."""
        self.start(columns, rows)
        self.command('/my-tasks')
        screen = wait_for(self.session, lambda s: '╰' in s and 'for you' in s)
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
        time.sleep(1.0)
        return capture(self.session)

    def transcript(self, columns, rows, tool_input):
        """The screen of a session resumed from a transcript where Claude called assign_task."""
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
        return capture(self.session)

    def close(self):
        self.stop()
        shutil.rmtree(self.home, ignore_errors=True)


def pane_body(screen):
    """The rows inside the pane's frame, frame and padding stripped, in order."""
    lines = screen.split('\n')
    top = next(i for i, line in enumerate(lines) if line.lstrip().startswith('╭'))
    bottom = next(i for i, line in enumerate(lines) if i > top and line.lstrip().startswith('╰'))
    return [line.strip()[1:-1].rstrip()[1:] if line.strip().startswith('│') else line for line in lines[top + 1 : bottom]]


if __name__ == '__main__':
    tasks = json.load(open(sys.argv[2]))
    columns = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    claude = Claude(sys.argv[1])
    try:
        claude.seed(tasks)
        print(claude.pane(columns, int(sys.argv[4]) if len(sys.argv) > 4 else 50))
    finally:
        claude.close()
