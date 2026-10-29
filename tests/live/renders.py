"""Lays out the screens the live tests kept, for a person to look over.

Run as `python3 tests/live/renders.py RENDERS_DIR` after `test_pane.py` ran
with RENDERS_DIR set. Writes RENDERS_DIR/index.html, each screen in the
terminal's colors, and prints them as Markdown text for a CI run's summary.
"""

import html
import os
import re
import sys

FOREGROUND = '#d4d4d4'
BACKGROUND = '#1e1e1e'
# The 16 colors of a dark terminal theme: normal, then bright.
BASIC = [
    '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]
CUBE = [0, 95, 135, 175, 215, 255]

SGR = re.compile(r'\x1b\[([0-9;:]*)m')
# Every other escape: cursor and mode sequences, and OSC strings such as hyperlinks.
OTHER = re.compile(r'\x1b(?:\[[0-9;:?<=>]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])')


def color(n):
    """One of the 256 palette colors, as CSS."""
    if n < 16:
        return BASIC[n]

    if n < 232:
        n -= 16
        return '#%02x%02x%02x' % (CUBE[n // 36], CUBE[n // 6 % 6], CUBE[n % 6])

    gray = 8 + 10 * (n - 232)
    return '#%02x%02x%02x' % (gray, gray, gray)


def extended(codes):
    """The color a 38 or 48 code names (`5;n` or `2;r;g;b`), and the codes after it."""
    if codes[:1] == ['5'] and len(codes) >= 2:
        return color(int(codes[1] or 0) % 256), codes[2:]

    if codes[:1] == ['2'] and len(codes) >= 4:
        r, g, b = (int(c or 0) % 256 for c in codes[1:4])
        return '#%02x%02x%02x' % (r, g, b), codes[4:]

    return None, []


def apply(style, params):
    """`style` after one SGR sequence's parameters."""
    codes = re.split('[;:]', params) if params else ['0']

    while codes:
        code, codes = codes[0], codes[1:]
        n = int(code) if code.isdigit() else 0

        if n == 0:
            style.clear()
        elif n in (1, 2, 3, 4, 7, 9):
            style[{1: 'bold', 2: 'dim', 3: 'italic', 4: 'underline', 7: 'inverse', 9: 'strike'}[n]] = True
        elif n == 22:
            style.pop('bold', None)
            style.pop('dim', None)
        elif n in (23, 24, 27, 29):
            style.pop({23: 'italic', 24: 'underline', 27: 'inverse', 29: 'strike'}[n], None)
        elif 30 <= n <= 37 or 90 <= n <= 97:
            style['fg'] = BASIC[n - 30 if n < 90 else n - 82]
        elif 40 <= n <= 47 or 100 <= n <= 107:
            style['bg'] = BASIC[n - 40 if n < 100 else n - 92]
        elif n in (38, 48):
            value, codes = extended(codes)
            if value is not None:
                style['fg' if n == 38 else 'bg'] = value
        elif n == 39:
            style.pop('fg', None)
        elif n == 49:
            style.pop('bg', None)


def css(style):
    fg, bg = style.get('fg', FOREGROUND), style.get('bg')

    if style.get('inverse'):
        fg, bg = bg or BACKGROUND, fg

    rules = [] if fg == FOREGROUND else [f'color:{fg}']
    rules += [] if bg is None else [f'background:{bg}']
    rules += ['font-weight:bold'] if style.get('bold') else []
    rules += ['opacity:.6'] if style.get('dim') else []
    rules += ['font-style:italic'] if style.get('italic') else []
    lines = [name for key, name in (('underline', 'underline'), ('strike', 'line-through')) if style.get(key)]
    rules += [f'text-decoration:{" ".join(lines)}'] if lines else []
    return ';'.join(rules)


def rows(screen):
    """The screen's rows, the empty ones around it gone and each run of them inside one row."""
    kept = []
    for line in screen.split('\n'):
        if text_of(line).strip() or (kept and text_of(kept[-1]).strip()):
            kept.append(line)
    while kept and not text_of(kept[-1]).strip():
        kept.pop()
    return kept


def text_of(line):
    return OTHER.sub('', SGR.sub('', line))


def to_html(screen):
    """The screen as HTML: its text escaped, each styled run a span."""
    out, style = [], {}

    for line in rows(screen):
        pos = 0
        for match in SGR.finditer(line):
            out.append(span(line[pos : match.start()], style))
            apply(style, match.group(1))
            pos = match.end()
        out.append(span(line[pos:], style))
        out.append('\n')

    return ''.join(out)


def span(text, style):
    text = html.escape(OTHER.sub('', text))
    rules = css(style)
    return f'<span style="{rules}">{text}</span>' if text and rules else text


def plain(screen):
    """The screen as text, its escapes gone."""
    return '\n'.join(text_of(line).rstrip() for line in rows(screen))


def main(folder):
    names = sorted(name for name in os.listdir(folder) if name.endswith('.ansi')) if os.path.isdir(folder) else []

    if not names:
        print('No renders: the live tests kept no screen.')
        return

    screens = []
    for name in names:
        with open(os.path.join(folder, name)) as f:
            screens.append((name[: -len('.ansi')], f.read()))

    sections = ''.join(
        f'<section><h2>{html.escape(name)}</h2><pre>{to_html(screen)}</pre></section>\n' for name, screen in screens
    )
    with open(os.path.join(folder, 'index.html'), 'w') as f:
        f.write(
            '<!doctype html><meta charset="utf-8"><title>Live test renders</title>\n'
            '<style>body{background:#111;color:#ccc;font:14px system-ui;margin:24px}'
            'h2{font-size:14px;font-weight:600;margin:28px 0 8px}'
            f'pre{{background:{BACKGROUND};color:{FOREGROUND};display:inline-block;margin:0;padding:12px 16px;'
            'font:13px/1.2 ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace}</style>\n'
            f'<h1>Live test renders</h1>\n{sections}'
        )

    # Four backticks: a fence no screen's text closes.
    print('## Renders of the live tests\n')
    print(f'{len(screens)} screens, as each test read them. The `renders` artifact has them in color (index.html).\n')
    for name, screen in screens:
        print(f'<details><summary>{html.escape(name)}</summary>\n\n````text\n{plain(screen)}\n````\n\n</details>\n')


if __name__ == '__main__':
    main(sys.argv[1])
