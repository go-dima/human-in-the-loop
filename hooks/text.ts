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

/** Wide in a terminal: East Asian wide and fullwidth forms, and emoji. */
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

/** The terminal cells `text` takes: two for a wide character, none for a combining mark. */
export function cellsOf(text: string): number {
  let cells = 0

  for (const char of text) {
    cells += /\p{M}/u.test(char) ? 0 : WIDE.test(char) ? 2 : 1
  }

  return cells
}

/**
 * The rows `text` takes in `columns` cells, wrapped as the terminal's `Text`
 * with `wrap="wrap"` wraps it: at spaces, the space kept at the end of the
 * row, and a word longer than a row broken where the row ends.
 */
export function wrapRows(text: string, columns: number): string[] {
  const width = Math.max(1, Math.floor(columns))
  const rows = ['']

  text.split(' ').forEach((word, i) => {
    if (i > 0) {
      if (cellsOf(rows.at(-1)!) >= width) {
        rows.push('')
      }

      rows[rows.length - 1] += ' '
    }

    const length = cellsOf(word)
    const used = cellsOf(rows.at(-1)!)

    if (length > width) {
      // A word wider than a row starts on this one when that breaks it no more often.
      const breaksHere = 1 + Math.floor((length - (width - used) - 1) / width)
      const breaksNext = Math.floor((length - 1) / width)

      if (breaksNext < breaksHere) {
        rows.push('')
      }

      for (const char of word) {
        if (cellsOf(rows.at(-1)!) + cellsOf(char) > width) {
          rows.push('')
        }

        rows[rows.length - 1] += char
      }

      return
    }

    if (used + length > width && used > 0 && length > 0) {
      rows.push('')
    }

    rows[rows.length - 1] += word
  })

  return rows
}

/** How many rows `text` wraps to in `columns` cells. */
export function rowsOf(text: string, columns: number): number {
  return wrapRows(text, columns).length
}
