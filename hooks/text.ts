/** Collapses runs of whitespace, newlines included, to single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Cuts `text` to `max` characters, marking the cut with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * A label safe to draw: control, format and line-separator characters out
 * (the engine refuses a drawing holding one), whitespace collapsed, and cut
 * to `max`. Titles and reasons are text the model or the user wrote.
 */
export function printable(text: string, max: number): string {
  const spaced = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\p{Cf}/gu, '')

  return clip(oneLine(spaced), max)
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** `#3, #5`: task numbers as a toast or a notice names them. */
export function numbersOf(ids: readonly number[]): string {
  return ids.map(id => `#${id}`).join(', ')
}

/** `now`, `4m`, `3h`, `2d`: how long ago, at a glance. */
export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)

  if (minutes < 1) {
    return 'now'
  }

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** `840 B`, `2.3 KB`. */
export function sizeOf(chars: number): string {
  return chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(1)} KB`
}

/**
 * Wide in a terminal: East Asian wide and fullwidth forms, and emoji drawn
 * as emoji by default (`⌚`, `✅`, `🀄`; `☀` asks for it with U+FE0F). A
 * flag's two letters take a cell each.
 */
const WIDE =
  /[\u1100-\u115F\u2329\u232A\u2630-\u2637\u268A-\u268F\u2E80-\u303E\u3041-\u3247\u3250-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6B\uFF00-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{16FE3}\u{16FF0}-\u{16FF6}\u{17000}-\u{18DFF}\u{1AFF0}-\u{1B2FF}\u{1D300}-\u{1D376}\u{1F200}-\u{1F2FF}\u{20000}-\u{3FFFD}]|(?!\p{Regional_Indicator})\p{Emoji_Presentation}/u

/** Drawn in no cell of its own: a mark or format character, a Hangul vowel or final joining its syllable. */
const JOINING = /[\p{M}\p{Cf}\u1160-\u11FF\uD7B0-\uD7FF]/u

/**
 * The terminal cells `text` takes, as the engine counts them: two for a
 * wide character, none for a mark on the one before, and two for an emoji
 * however it is built (`☀️`, `1️⃣`, `1⃣`, `👍🏽`, `👩‍💻`, `❤‍🔥`).
 */
export function cellsOf(text: string): number {
  let cells = 0
  // The character the ones after it may join, and the cells they take together.
  let base = ''
  let width = 0
  let previous = ''

  for (const char of text) {
    if (char === '\uFE0F' && width === 1 && /\p{Emoji}/u.test(base) && !/[0-9#*]/.test(base)) {
      // A digit, `#` and `*` widen only in a keycap.
      width = 2
    } else if (char === '\u20E3') {
      // A keycap, whatever it encloses.
      width = 2
    } else if (char === '\u200D' && width === 1 && /\p{Extended_Pictographic}/u.test(base) && !/[©®]/.test(base)) {
      // An emoji drawn as text joining another draws as an emoji (`❤‍🔥`); the engine leaves `©` and `®`, the two below U+0100, as text.
      width = 2
    } else if (/\p{Emoji_Modifier}/u.test(char) && /\p{Emoji_Modifier_Base}/u.test(previous)) {
      width = 2
    } else if (previous === '\u200D' && width === 2 && /\p{Extended_Pictographic}/u.test(base) && /\p{Extended_Pictographic}/u.test(char)) {
      // Joined by U+200D, emoji draw as one.
    } else if (!JOINING.test(char)) {
      cells += width
      base = char
      width = WIDE.test(char) ? 2 : 1
    }

    previous = char
  }

  return cells + width
}

/** Splits text into what the terminal draws as one: a character with its marks, joiners and modifiers. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The rows `text` takes in `columns` cells, wrapped as the terminal's `Text`
 * with `wrap="wrap"` wraps it: at spaces, the space kept at the end of the
 * row, and a word longer than a row broken where the row ends, between the
 * characters it draws.
 */
export function wrapRows(text: string, columns: number): string[] {
  const width = Math.max(1, Math.floor(columns))
  const rows = ['']
  // The cells the last row takes.
  let used = 0

  const breakRow = () => {
    rows.push('')
    used = 0
  }

  const add = (piece: string, cells: number) => {
    rows[rows.length - 1] += piece
    used += cells
  }

  text.split(' ').forEach((word, i) => {
    if (i > 0) {
      if (used >= width) {
        breakRow()
      }

      add(' ', 1)
    }

    const length = cellsOf(word)

    if (length > width) {
      // A word wider than a row starts on this one when that breaks it no more often.
      const breaksHere = 1 + Math.floor((length - (width - used) - 1) / width)
      const breaksNext = Math.floor((length - 1) / width)

      if (breaksNext < breaksHere) {
        breakRow()
      }

      for (const { segment } of GRAPHEMES.segment(word)) {
        const cells = cellsOf(segment)

        // One wider than the row, after a full one, leaves a row empty between them.
        if (used === width && cells > width) {
          breakRow()
        }

        // One that doesn't fit breaks the row, an empty one too: the engine
        // draws one wider than any row under an empty row.
        if (used + cells > width) {
          breakRow()
        }

        add(segment, cells)
      }

      return
    }

    if (used + length > width && used > 0 && length > 0) {
      breakRow()
    }

    add(word, length)
  })

  return rows
}

/** How many rows `text` wraps to in `columns` cells. */
export function rowsOf(text: string, columns: number): number {
  return wrapRows(text, columns).length
}
