// The Hex Editor page: the bytes of the file open in the viewer, sixteen to
// a row, as hexadecimal and as text, with a cursor to move and type with.
//
// - The bytes come from the extension a page (64 KiB) at a time, read with
//   their unsaved changes, and only those in view are drawn, so files of
//   any size scroll alike. Past a few million rows, the scroll bar stands
//   for rows rather than pixels.
// - Changes go to the extension one at a time, each with the file's
//   version it was made against; Flareite keeps them, with their undo
//   history, until the user saves (Ctrl+S, which goes to the workbench) or
//   reverts them. Typing overwrites, or inserts with Insert pressed.
// - Each tab keeps its place (`flareite.setState`).

const BYTES_PER_ROW = 16
const PAGE = 64 * 1024
const MAX_PAGES = 64
/** Tallest the scroll area gets; past it, the scroll bar is scaled. */
const MAX_SCROLL = 4_000_000
/** Most bytes copied at once. */
const MAX_COPY = 4 * 1024 * 1024
const HEX = '0123456789ABCDEF'

const grid = document.getElementById('grid')
const columns = document.getElementById('columns')
const scroller = document.getElementById('scroller')
const rowsElement = document.getElementById('rows')
const spacer = document.getElementById('spacer')
const problem = document.getElementById('problem')
const status = document.getElementById('status')
const gotoInput = document.getElementById('goto')
const findInput = document.getElementById('find')
const findHex = document.getElementById('find-hex')
const findCase = document.getElementById('find-case')
const matchesLabel = document.getElementById('matches')
const modeButton = document.getElementById('mode')
const undoButton = document.getElementById('undo')
const inspector = document.getElementById('inspector')
const inspectorToggle = document.getElementById('inspector-toggle')
const endianButton = document.getElementById('endian')
const values = document.getElementById('values')

const saved = flareite.getState() ?? {}

// The file.
let size = 0
let version = -1
let canUndo = false
let loaded = false

// Where the user is.
let cursor = saved.cursor ?? 0
/** The other end of the selection, or `null`. */
let anchor = null
/** `hex` or `text`: the column typed in. */
let column = saved.column === 'text' ? 'text' : 'hex'
let insert = saved.insert === true
/** A byte's first hexadecimal digit, typed: `{ offset, high }`. */
let pending = null
let topRow = saved.topRow ?? 0
let littleEndian = saved.littleEndian !== false
let inspectorShown = saved.inspector !== false

// Pages of bytes: their index to `{ bytes, version }`, most recent last.
const pages = new Map()
/** Pages asked for: index to the request's id. */
const requested = new Map()
let nextId = 1

/** Requests to the extension that change the file, sent one at a time. */
const queue = []
let inFlight = false

// Find.
let matches = []
let matchLength = 0
let matchIndex = -1
/** What `matches` were found for, to search again when it changes. */
let searched = null
let findId = 0

/** A note in the status bar, for a few seconds. */
let note = null
let noteTimer = 0

// ---------------------------------------------------------------- utilities

const hex2 = byte => HEX[byte >> 4] + HEX[byte & 15]

function hexOffset(offset) {
  return offset.toString(16).toUpperCase().padStart(size > 0xffffffff ? 12 : 8, '0')
}

function fileSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

function toBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const encoder = new TextEncoder()

/** Hexadecimal bytes as typed ("4D 5A", "4d5a", "0x4D, 0x5A"), or `null`. */
function parseHex(text) {
  const digits = text.replace(/0x/gi, '').replace(/[\s,;:-]/g, '')
  if (digits.length === 0 || digits.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(digits)) {
    return null
  }
  const bytes = new Uint8Array(digits.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(digits.slice(2 * i, 2 * i + 2), 16)
  }
  return bytes
}

function showNote(text) {
  note = text
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    note = null
    updateStatus()
  }, 4000)
  updateStatus()
}

const saveState = (() => {
  let timer = 0
  return () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      flareite.setState({
        cursor,
        column,
        insert,
        topRow,
        littleEndian,
        inspector: inspectorShown,
      })
    }, 300)
  }
})()

// ------------------------------------------------------------------- bytes

/** The byte at `offset`, or `undefined` if its page hasn't come yet. */
function byteAt(offset) {
  const page = pages.get(Math.floor(offset / PAGE))
  return page?.bytes[offset % PAGE]
}

/** Asks for a page, unless it's here for this version or on its way. */
function want(index) {
  if (index * PAGE > size && index > 0) {
    return
  }
  const page = pages.get(index)
  if ((page && page.version === version) || requested.has(index)) {
    return
  }
  const id = nextId++
  requested.set(index, id)
  flareite.postMessage({ type: 'read', id, offset: index * PAGE, length: PAGE })
}

function received(message) {
  const index = Math.floor(message.offset / PAGE)
  if (requested.get(index) !== message.id) {
    return
  }
  requested.delete(index)
  pages.delete(index)
  pages.set(index, { bytes: fromBase64(message.data), version: message.state.version })
  // Forget the pages used least lately.
  for (const old of pages.keys()) {
    if (pages.size <= MAX_PAGES) {
      break
    }
    pages.delete(old)
  }
  applyState(message.state)
  render()
}

/** Takes in how the file stands; a new version makes the pages stale. */
function applyState(state) {
  const changed = state.version !== version
  size = state.size
  version = state.version
  canUndo = state.canUndo
  undoButton.disabled = !canUndo
  if (changed) {
    // Replies on their way are for the old bytes.
    requested.clear()
    if (searched) {
      searched = { ...searched, version: -1 }
    }
  }
  if (!loaded) {
    loaded = true
    cursor = Math.min(cursor, size)
    layout()
    scrollTo(Math.min(topRow, maxTopRow()))
  }
}

/** Bytes from `start` to `end` (exclusive) if their pages are all here. */
function bytesBetween(start, end) {
  const bytes = new Uint8Array(end - start)
  for (let offset = start; offset < end; offset++) {
    const byte = byteAt(offset)
    if (byte === undefined) {
      return null
    }
    bytes[offset - start] = byte
  }
  return bytes
}

// ----------------------------------------------------------------- changes

function pump() {
  if (inFlight || queue.length === 0 || version < 0) {
    return
  }
  const request = queue.shift()
  inFlight = true
  flareite.postMessage(request.type === 'edit' ? { ...request, version } : request)
}

/**
 * Changes the file: `changes` are `{ offset, removed, bytes }`, made in
 * order as one step. Overwritten bytes show at once; the rest come back
 * from the extension.
 */
function change(changes) {
  for (const { offset, removed, bytes } of changes) {
    if (removed === bytes.length) {
      bytes.forEach((byte, i) => {
        const page = pages.get(Math.floor((offset + i) / PAGE))
        if (page) {
          page.bytes[(offset + i) % PAGE] = byte
        }
      })
    }
  }
  queue.push({
    type: 'edit',
    changes: changes.map(({ offset, removed, bytes }) => ({
      offset,
      removed,
      data: toBase64(bytes),
    })),
  })
  pump()
}

/** Puts `bytes` at the cursor: over the selection, or inserted or over what's there. */
function put(bytes) {
  const range = selection()
  if (range) {
    change([{ offset: range.start, removed: range.end - range.start, bytes }])
    moveTo(range.start + bytes.length)
    return
  }
  const removed = insert ? 0 : Math.min(bytes.length, size - cursor)
  change([{ offset: cursor, removed, bytes }])
  moveTo(cursor + bytes.length)
}

/** Ends a half-typed byte: its second digit is the old byte's (or 0). */
function commitPending() {
  if (!pending) {
    return
  }
  const { offset, high } = pending
  pending = null
  const inserting = insert || offset >= size
  const low = inserting ? 0 : (byteAt(offset) ?? 0) & 15
  change([{ offset, removed: inserting ? 0 : 1, bytes: Uint8Array.of((high << 4) | low) }])
}

function typeDigit(digit) {
  const range = selection()
  if (range) {
    // Typed over a selection: it goes, and the byte goes in its place.
    change([{ offset: range.start, removed: range.end - range.start, bytes: new Uint8Array() }])
    cursor = range.start
    anchor = null
  }
  if (pending && pending.offset === cursor) {
    const { offset, high } = pending
    pending = null
    const inserting = insert || offset >= size
    change([{ offset, removed: inserting ? 0 : 1, bytes: Uint8Array.of((high << 4) | digit) }])
    moveTo(offset + 1)
    return
  }
  commitPending()
  pending = { offset: cursor, high: digit }
  render()
}

function remove(before) {
  if (pending) {
    pending = null
    render()
    return
  }
  const range = selection()
  if (range) {
    change([{ offset: range.start, removed: range.end - range.start, bytes: new Uint8Array() }])
    moveTo(range.start)
    return
  }
  const offset = before ? cursor - 1 : cursor
  if (offset < 0 || offset >= size) {
    return
  }
  change([{ offset, removed: 1, bytes: new Uint8Array() }])
  moveTo(offset)
}

function step(undo) {
  if (pending) {
    pending = null
    render()
    return
  }
  queue.push({ type: undo ? 'undo' : 'redo' })
  pump()
}

// ---------------------------------------------------------------- messages

flareite.onMessage(message => {
  switch (message.type) {
    case 'info':
      applyState(message.state)
      render()
      break
    case 'bytes':
      received(message)
      break
    case 'edited':
      inFlight = false
      applyState(message.state)
      render()
      pump()
      break
    case 'stale':
      // The file changed under the page (an undo from the workbench): the
      // changes typed since go.
      inFlight = false
      queue.length = 0
      applyState(message.state)
      showNote('The file changed, so your last change wasn’t made.')
      render()
      break
    case 'stepped':
      inFlight = false
      applyState(message.state)
      if (message.step) {
        anchor = null
        moveTo(Math.min(message.step.offset, size))
      } else {
        showNote(message.undo ? 'Nothing to undo.' : 'Nothing to redo.')
      }
      render()
      pump()
      break
    case 'found':
      found(message)
      break
    case 'reload':
      // Opened again, or changed other than from here: read it again.
      pending = null
      requested.clear()
      flareite.postMessage({ type: 'info' })
      break
    case 'error':
      if (inFlight) {
        inFlight = false
        queue.length = 0
      }
      if (!loaded) {
        problem.textContent = message.message
        problem.hidden = false
      } else {
        showNote(message.message)
      }
      flareite.postMessage({ type: 'info' })
      break
  }
})

flareite.onFileChanged(() => {
  pending = null
  requested.clear()
  flareite.postMessage({ type: 'info' })
})

// -------------------------------------------------------------- scrolling

const rowHeight = () => parseFloat(getComputedStyle(grid).getPropertyValue('--row')) || 20
const totalRows = () => Math.floor(size / BYTES_PER_ROW) + 1
/** Rows that fit in the tab, whole. */
const fullRows = () => Math.max(1, Math.floor(rowsElement.clientHeight / rowHeight()))
const maxTopRow = () => Math.max(0, totalRows() - fullRows())
/** The spacer's height: the scroll bar's range. */
let range = 0
/** A scroll position set here, which the scroll event shouldn't read back. */
let ownScroll = null

function layout() {
  range = Math.min(maxTopRow() * rowHeight(), MAX_SCROLL)
  spacer.style.height = `${range}px`
  buildRows()
}

function scrollTo(row) {
  topRow = Math.max(0, Math.min(Math.round(row), maxTopRow()))
  const max = maxTopRow()
  const position = max === 0 ? 0 : (topRow / max) * range
  ownScroll = position
  scroller.scrollTop = position
  render()
  saveState()
}

scroller.addEventListener('scroll', () => {
  if (ownScroll !== null && Math.abs(scroller.scrollTop - ownScroll) < 1) {
    ownScroll = null
    return
  }
  ownScroll = null
  const max = maxTopRow()
  topRow = range === 0 ? 0 : Math.round((scroller.scrollTop / range) * max)
  render()
  saveState()
})

// Past MAX_SCROLL a pixel is several rows: the wheel moves by rows instead.
scroller.addEventListener(
  'wheel',
  event => {
    if (event.ctrlKey || range >= maxTopRow() * rowHeight()) {
      return
    }
    event.preventDefault()
    const lines = event.deltaMode === 1 ? event.deltaY : event.deltaY / rowHeight()
    scrollTo(topRow + Math.sign(lines) * Math.max(1, Math.round(Math.abs(lines))))
  },
  { passive: false },
)

new ResizeObserver(() => {
  if (loaded) {
    layout()
    scrollTo(topRow)
  }
}).observe(scroller)

/** Scrolls so the cursor's row is in view. */
function reveal() {
  const row = Math.floor(cursor / BYTES_PER_ROW)
  if (row < topRow) {
    scrollTo(row)
  } else if (row >= topRow + fullRows()) {
    scrollTo(row - fullRows() + 1)
  }
}

// ---------------------------------------------------------------- drawing

/** The drawn rows: `{ element, offset, hex: [], text: [] }`. */
let rows = []

function cells(parent, count, className) {
  const container = document.createElement('div')
  container.className = className
  const spans = []
  for (let i = 0; i < count; i++) {
    const span = document.createElement('span')
    container.append(span)
    spans.push(span)
  }
  parent.append(container)
  return spans
}

function buildRows() {
  const count = Math.ceil(rowsElement.clientHeight / rowHeight()) + 1
  if (rows.length === count) {
    return
  }
  rowsElement.textContent = ''
  rows = []
  for (let i = 0; i < count; i++) {
    const element = document.createElement('div')
    element.className = 'row'
    const offset = document.createElement('span')
    offset.className = 'offset'
    element.append(offset)
    const hex = cells(element, BYTES_PER_ROW, 'hex')
    const text = cells(element, BYTES_PER_ROW, 'text')
    rowsElement.append(element)
    rows.push({ element, offset, hex, text })
  }
}

function buildColumns() {
  const offset = document.createElement('span')
  offset.className = 'offset'
  offset.textContent = 'Offset'
  columns.append(offset)
  cells(columns, BYTES_PER_ROW, 'hex').forEach((span, i) => (span.textContent = hex2(i)))
  const text = document.createElement('div')
  text.className = 'text-heading'
  text.textContent = 'Decoded Text'
  columns.append(text)
}

/** The selected bytes' range, `{ start, end }` (end exclusive), or `null`. */
function selection() {
  if (anchor === null || anchor === cursor) {
    return null
  }
  const start = Math.min(anchor, cursor)
  const end = Math.min(Math.max(anchor, cursor) + 1, size)
  return end > start ? { start, end } : null
}

/** The match `offset` is in: its index, or -1. */
function matchAt(offset) {
  let low = 0
  let high = matches.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (matches[middle] <= offset) {
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return high >= 0 && offset < matches[high] + matchLength ? high : -1
}

let frame = 0

function render() {
  if (!frame) {
    frame = requestAnimationFrame(draw)
  }
}

function draw() {
  frame = 0
  if (!loaded) {
    return
  }
  const range = selection()
  const first = topRow * BYTES_PER_ROW
  // The pages in view, and the next one.
  const last = first + rows.length * BYTES_PER_ROW
  for (let index = Math.floor(first / PAGE); index <= Math.floor(last / PAGE); index++) {
    want(index)
  }
  const cursorRow = Math.floor(cursor / BYTES_PER_ROW)
  rows.forEach((row, i) => {
    const start = (topRow + i) * BYTES_PER_ROW
    if (start > size) {
      row.element.style.visibility = 'hidden'
      return
    }
    row.element.style.visibility = ''
    row.offset.textContent = hexOffset(start)
    row.offset.className = topRow + i === cursorRow ? 'offset current-row' : 'offset'
    for (let j = 0; j < BYTES_PER_ROW; j++) {
      const offset = start + j
      const hexCell = row.hex[j]
      const textCell = row.text[j]
      hexCell.dataset.offset = textCell.dataset.offset = offset
      let hexText = ''
      let textText = ''
      let kind = ''
      if (offset < size) {
        const byte = byteAt(offset)
        if (byte === undefined) {
          hexText = '··'
          textText = '·'
          kind = 'missing'
        } else {
          hexText = hex2(byte)
          if (byte >= 0x20 && byte < 0x7f) {
            textText = String.fromCharCode(byte)
          } else {
            textText = '.'
            kind = byte === 0 ? 'zero' : 'control'
          }
          if (byte === 0) {
            kind = 'zero'
          }
        }
      }
      let classes = kind
      if (pending && pending.offset === offset) {
        const low = offset < size && !insert ? hexText[1] || '0' : '0'
        hexText = HEX[pending.high] + low
        classes += ' pending'
      }
      if (range && offset >= range.start && offset < range.end) {
        classes += ' selected'
      }
      if (matches.length > 0) {
        const at = matchAt(offset)
        if (at >= 0) {
          classes += at === matchIndex ? ' match current' : ' match'
        }
      }
      let hexClasses = classes
      let textClasses = classes
      if (offset === cursor) {
        hexClasses += column === 'hex' ? ' cursor active' : ' cursor'
        textClasses += column === 'text' ? ' cursor active' : ' cursor'
      }
      if (hexCell.textContent !== hexText) {
        hexCell.textContent = hexText
      }
      if (textCell.textContent !== textText) {
        textCell.textContent = textText
      }
      hexCell.className = hexClasses.trim()
      textCell.className = textClasses.trim()
    }
  })
  columns.querySelectorAll('.hex > span').forEach((span, i) => {
    span.classList.toggle('current-column', i === cursor % BYTES_PER_ROW)
  })
  updateStatus()
  updateInspector()
}

function updateStatus() {
  modeButton.textContent = insert ? 'INS' : 'OVR'
  modeButton.title = insert
    ? 'Typing inserts bytes; click or press Insert to overwrite them instead'
    : 'Typing overwrites bytes; click or press Insert to insert them instead'
  if (note) {
    status.textContent = note
    return
  }
  const parts = [`Offset 0x${cursor.toString(16).toUpperCase()} (${cursor})`]
  const range = selection()
  if (range) {
    const count = range.end - range.start
    parts.push(`${count} ${count === 1 ? 'byte' : 'bytes'} selected`)
  }
  parts.push(fileSize(size))
  status.textContent = parts.join(' · ')
  status.title = status.textContent
}

// ---------------------------------------------------------------- inspector

function updateInspector() {
  inspector.hidden = !inspectorShown
  inspectorToggle.setAttribute('aria-pressed', String(inspectorShown))
  endianButton.textContent = littleEndian ? 'LE' : 'BE'
  endianButton.title = littleEndian
    ? 'Numbers are read little-endian (least significant byte first); click for big-endian'
    : 'Numbers are read big-endian (most significant byte first); click for little-endian'
  if (!inspectorShown) {
    return
  }
  const available = Math.max(0, Math.min(8, size - cursor))
  const bytes = bytesBetween(cursor, cursor + available) ?? new Uint8Array()
  const view = new DataView(bytes.buffer)
  const has = count => bytes.length >= count
  const none = '—'
  const integer = (count, read) => (has(count) ? String(read()) : none)
  const float = (count, read) => {
    if (!has(count)) {
      return none
    }
    const value = read()
    return Number.isInteger(value) ? value.toFixed(1) : String(value)
  }
  const entries = [
    ['Binary', has(1) ? bytes[0].toString(2).padStart(8, '0') : none],
    ['Octal', has(1) ? bytes[0].toString(8).padStart(3, '0') : none],
    ['UInt8', integer(1, () => view.getUint8(0))],
    ['Int8', integer(1, () => view.getInt8(0))],
    ['UInt16', integer(2, () => view.getUint16(0, littleEndian))],
    ['Int16', integer(2, () => view.getInt16(0, littleEndian))],
    ['UInt32', integer(4, () => view.getUint32(0, littleEndian))],
    ['Int32', integer(4, () => view.getInt32(0, littleEndian))],
    ['UInt64', integer(8, () => view.getBigUint64(0, littleEndian))],
    ['Int64', integer(8, () => view.getBigInt64(0, littleEndian))],
    ['Float32', float(4, () => view.getFloat32(0, littleEndian))],
    ['Float64', float(8, () => view.getFloat64(0, littleEndian))],
    ['UTF-8', utf8At(bytes)],
    ['UTF-16', has(2) ? codeUnit(view.getUint16(0, littleEndian)) : none],
  ]
  if (values.childElementCount !== entries.length * 2) {
    values.textContent = ''
    for (const [name] of entries) {
      const term = document.createElement('dt')
      term.textContent = name
      values.append(term, document.createElement('dd'))
    }
  }
  entries.forEach(([, value], i) => {
    const definition = values.children[2 * i + 1]
    if (definition.textContent !== value) {
      definition.textContent = value
    }
  })
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function describeCharacter(code) {
  const name = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
  const printable = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)
  return printable ? `${String.fromCodePoint(code)}  ${name}` : name
}

/** The character the UTF-8 sequence at the cursor encodes, if it's one. */
function utf8At(bytes) {
  if (bytes.length === 0) {
    return '—'
  }
  const lead = bytes[0]
  const length = lead < 0x80 ? 1 : lead >> 5 === 6 ? 2 : lead >> 4 === 14 ? 3 : lead >> 3 === 30 ? 4 : 0
  if (length === 0 || bytes.length < length) {
    return 'not a character'
  }
  try {
    return describeCharacter(utf8.decode(bytes.subarray(0, length)).codePointAt(0))
  } catch {
    return 'not a character'
  }
}

function codeUnit(unit) {
  return unit >= 0xd800 && unit < 0xe000
    ? `U+${unit.toString(16).toUpperCase()} (surrogate)`
    : describeCharacter(unit)
}

// ------------------------------------------------------------------ moving

/** Moves the cursor, ending any half-typed byte, and keeps it in view. */
function moveTo(offset, extend = false) {
  if (pending && pending.offset !== offset) {
    commitPending()
  }
  const next = Math.max(0, Math.min(offset, size))
  // The next match is looked for from here.
  matchIndex = -1
  if (extend) {
    anchor ??= cursor
  } else {
    anchor = null
  }
  cursor = next
  reveal()
  render()
  saveState()
}

grid.addEventListener('keydown', event => {
  if (!loaded) {
    return
  }
  const mod = event.ctrlKey || event.metaKey
  const handled = () => event.preventDefault()
  const shift = event.shiftKey
  if (mod && !event.altKey) {
    switch (event.key.toLowerCase()) {
      case 'z':
        handled()
        step(!shift)
        return
      case 'y':
        handled()
        step(false)
        return
      case 'a':
        handled()
        commitPending()
        anchor = 0
        cursor = Math.max(0, size - 1)
        render()
        return
      case 'g':
        handled()
        gotoInput.focus()
        gotoInput.select()
        return
      case 'f':
        handled()
        findInput.focus()
        findInput.select()
        return
      case 'home':
        handled()
        moveTo(0, shift)
        return
      case 'end':
        handled()
        moveTo(size, shift)
        return
    }
    // Others go to the workbench: Ctrl+S saves.
    return
  }
  switch (event.key) {
    case 'ArrowLeft':
      handled()
      moveTo(cursor - 1, shift)
      return
    case 'ArrowRight':
      handled()
      moveTo(cursor + 1, shift)
      return
    case 'ArrowUp':
      handled()
      moveTo(cursor - BYTES_PER_ROW, shift)
      return
    case 'ArrowDown':
      handled()
      moveTo(cursor + BYTES_PER_ROW, shift)
      return
    case 'PageUp':
      handled()
      moveTo(cursor - fullRows() * BYTES_PER_ROW, shift)
      return
    case 'PageDown':
      handled()
      moveTo(cursor + fullRows() * BYTES_PER_ROW, shift)
      return
    case 'Home':
      handled()
      moveTo(cursor - (cursor % BYTES_PER_ROW), shift)
      return
    case 'End':
      handled()
      moveTo(cursor - (cursor % BYTES_PER_ROW) + BYTES_PER_ROW - 1, shift)
      return
    case 'Tab':
      handled()
      commitPending()
      column = column === 'hex' ? 'text' : 'hex'
      render()
      saveState()
      return
    case 'Insert':
      handled()
      commitPending()
      insert = !insert
      render()
      saveState()
      return
    case 'Backspace':
      handled()
      remove(true)
      return
    case 'Delete':
      handled()
      remove(false)
      return
    case 'Escape':
      if (pending || anchor !== null) {
        handled()
        pending = null
        anchor = null
        render()
      }
      return
    case 'F3':
      handled()
      nextMatch(shift ? -1 : 1)
      return
  }
  if (event.altKey || event.key.length !== 1) {
    return
  }
  if (column === 'hex') {
    const digit = HEX.indexOf(event.key.toUpperCase())
    if (digit >= 0) {
      handled()
      typeDigit(digit)
    }
    return
  }
  handled()
  put(encoder.encode(event.key))
})

/** The byte offset and column of the cell under a pointer event, if any. */
function cellAt(event) {
  const target = document.elementFromPoint(event.clientX, event.clientY)
  const offset = target?.dataset?.offset
  if (offset === undefined || !rowsElement.contains(target)) {
    return null
  }
  return {
    offset: Number(offset),
    column: target.parentElement.classList.contains('text') ? 'text' : 'hex',
  }
}

let dragging = false

rowsElement.addEventListener('mousedown', event => {
  if (event.button !== 0) {
    return
  }
  const cell = cellAt(event)
  if (!cell || cell.offset > size) {
    return
  }
  event.preventDefault()
  grid.focus()
  column = cell.column
  const from = anchor ?? cursor
  moveTo(cell.offset)
  if (event.shiftKey) {
    anchor = from
    render()
  } else {
    anchor = cell.offset
  }
  dragging = true
})

window.addEventListener('mousemove', event => {
  if (!dragging) {
    return
  }
  const cell = cellAt(event)
  if (cell && cell.offset <= size && cell.offset !== cursor) {
    const from = anchor
    cursor = cell.offset
    anchor = from
    render()
  }
})

window.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false
    if (anchor === cursor) {
      anchor = null
    }
    render()
    saveState()
  }
})

// ------------------------------------------------- copying and pasting

function selectedOrCursor() {
  return selection() ?? (cursor < size ? { start: cursor, end: cursor + 1 } : null)
}

/** Copies the selection (or the byte at the cursor), and with `cut`, removes it. */
function copy(event, cut) {
  if (document.activeElement !== grid) {
    return
  }
  event.preventDefault()
  const range = selectedOrCursor()
  if (!range) {
    return
  }
  if (range.end - range.start > MAX_COPY) {
    showNote(`At most ${fileSize(MAX_COPY)} can be copied at once.`)
    return
  }
  const bytes = bytesBetween(range.start, range.end)
  if (!bytes) {
    // Its pages come in the background; copying again then works.
    for (let index = Math.floor(range.start / PAGE); index <= Math.floor(range.end / PAGE); index++) {
      want(index)
    }
    showNote('Still reading the selection; copy again in a moment.')
    return
  }
  // Hexadecimal from the hexadecimal column ("DE AD BE EF"), text from the text column.
  const text =
    column === 'hex' ? Array.from(bytes, hex2).join(' ') : new TextDecoder('utf-8').decode(bytes)
  event.clipboardData.setData('text/plain', text)
  if (cut) {
    commitPending()
    change([{ offset: range.start, removed: range.end - range.start, bytes: new Uint8Array() }])
    moveTo(range.start)
  }
}

document.addEventListener('copy', event => copy(event, false))
document.addEventListener('cut', event => copy(event, true))

document.addEventListener('paste', event => {
  if (document.activeElement !== grid) {
    return
  }
  event.preventDefault()
  const text = event.clipboardData.getData('text/plain')
  if (!text) {
    return
  }
  commitPending()
  // Hexadecimal in the hexadecimal column; otherwise the text's UTF-8.
  const bytes = (column === 'hex' && parseHex(text)) || encoder.encode(text)
  put(bytes)
})

// ------------------------------------------------------------------ go to

gotoInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    grid.focus()
    return
  }
  if (event.key !== 'Enter') {
    return
  }
  event.preventDefault()
  const text = gotoInput.value.trim().replace(/_/g, '')
  const hexadecimal = /^0x[0-9a-f]+$/i.test(text) || /^[0-9a-f]+h$/i.test(text)
  const digits = text.replace(/^0x/i, '').replace(/h$/i, '')
  const offset = hexadecimal ? parseInt(digits, 16) : /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isFinite(offset)) {
    showNote('Type an offset in decimal (1024) or hexadecimal (0x400).')
    return
  }
  moveTo(offset)
  grid.focus()
})

// -------------------------------------------------------------------- find

function query() {
  const text = findInput.value
  const hexadecimal = findHex.getAttribute('aria-pressed') === 'true'
  if (!text) {
    return null
  }
  const bytes = hexadecimal ? parseHex(text) : encoder.encode(text)
  if (!bytes) {
    return { problem: 'Type bytes in hexadecimal, such as 4D 5A.' }
  }
  const ignoreCase = !hexadecimal && findCase.getAttribute('aria-pressed') !== 'true'
  return { bytes, ignoreCase, key: `${toBase64(bytes)}/${ignoreCase}` }
}

function search(direction) {
  const wanted = query()
  if (!wanted) {
    matches = []
    matchesLabel.textContent = ''
    render()
    return
  }
  if (wanted.problem) {
    matchesLabel.textContent = ''
    showNote(wanted.problem)
    return
  }
  if (searched && searched.key === wanted.key && searched.version === version) {
    nextMatch(direction)
    return
  }
  findId += 1
  searched = { key: wanted.key, version, direction, id: findId, length: wanted.bytes.length }
  matchesLabel.textContent = '…'
  flareite.postMessage({
    type: 'find',
    id: findId,
    query: toBase64(wanted.bytes),
    ignoreCase: wanted.ignoreCase,
  })
}

function found(message) {
  if (!searched || message.id !== searched.id) {
    return
  }
  matches = message.matches
  matchLength = searched.length
  matchIndex = -1
  if (matches.length === 0) {
    matchesLabel.textContent = 'No results'
    render()
    return
  }
  matchesLabel.dataset.truncated = String(message.truncated)
  nextMatch(searched.direction)
}

/** Selects the next match after the current one (or the cursor), or the one before. */
function nextMatch(direction) {
  if (matches.length === 0) {
    search(direction)
    return
  }
  const count = matches.length
  let index
  if (matchIndex >= 0) {
    index = (matchIndex + direction + count) % count
  } else if (direction > 0) {
    index = Math.max(0, matches.findIndex(start => start >= cursor))
  } else {
    const after = matches.findIndex(start => start >= cursor)
    index = ((after === -1 ? count : after) - 1 + count) % count
  }
  select(index)
}

function select(index) {
  matchIndex = index
  const start = matches[index]
  commitPending()
  anchor = start
  cursor = start + matchLength - 1
  reveal()
  const more = matchesLabel.dataset.truncated === 'true' ? '+' : ''
  matchesLabel.textContent = `${index + 1} of ${matches.length}${more}`
  render()
}

findInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === 'F3') {
    event.preventDefault()
    search(event.shiftKey ? -1 : 1)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    grid.focus()
  }
})

findInput.addEventListener('input', () => {
  matches = []
  searched = null
  matchesLabel.textContent = ''
  render()
})

for (const toggle of [findHex, findCase]) {
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'))
    findInput.placeholder =
      findHex.getAttribute('aria-pressed') === 'true' ? 'Find bytes (4D 5A)' : 'Find text'
    findCase.disabled = findHex.getAttribute('aria-pressed') === 'true'
    matches = []
    searched = null
    matchesLabel.textContent = ''
    render()
  })
}

document.getElementById('find-next').addEventListener('click', () => search(1))
document.getElementById('find-previous').addEventListener('click', () => search(-1))

// --------------------------------------------------------- toolbar toggles

modeButton.addEventListener('click', () => {
  commitPending()
  insert = !insert
  render()
  saveState()
  grid.focus()
})

undoButton.addEventListener('click', () => {
  step(true)
  grid.focus()
})

inspectorToggle.addEventListener('click', () => {
  inspectorShown = !inspectorShown
  render()
  saveState()
})

endianButton.addEventListener('click', () => {
  littleEndian = !littleEndian
  render()
  saveState()
})

// ------------------------------------------------------------------- start

buildColumns()
updateInspector()
flareite.postMessage({ type: 'info' })
grid.focus()
