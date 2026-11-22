# Hex Editor

Shows any file's bytes, sixteen to a row, as hexadecimal and as text, and changes them.

Open a file in it with **View: Reopen Editor With…** and **Hex Editor**, or with **Open in Hex
Editor** in the tab a binary file opens in. Text files still open as text.

## Reading

- **Scroll** through files of any size: the bytes are read a page at a time as they come into
  view.
- **Go to an offset** (Ctrl+G): decimal (`1024`) or hexadecimal (`0x400`, or `400h`).
- **Find** (Ctrl+F) text, matching case or not, or bytes in hexadecimal (`0x`, then `4D 5A`).
  Enter and F3 go to the next match, Shift+Enter and Shift+F3 to the one before.
- **The data inspector**, beside the bytes, reads the bytes at the cursor as binary, octal,
  8-, 16-, 32-, and 64-bit integers (signed and unsigned), 32- and 64-bit floats, and UTF-8 and
  UTF-16 characters, little-endian or big-endian (the **LE** button).
- **The status bar** of the page shows the cursor's offset, how many bytes are selected, and the
  file's size.

## Changing

- **Type** hexadecimal digits in the hexadecimal column (two to a byte), or text in the text
  column; Tab switches between them. Typing overwrites bytes; **Insert** (or the **OVR** button)
  inserts them instead. Typing at the end adds to the file.
- **Delete** and **Backspace** remove the selection, or the byte at or before the cursor.
- **Select** with Shift and the arrow keys, or by dragging; Ctrl+A selects everything.
- **Copy** (Ctrl+C) copies the selection as hexadecimal (`DE AD BE EF`) from the hexadecimal
  column, or as text from the text column. **Paste** (Ctrl+V) takes hexadecimal in the
  hexadecimal column, and text otherwise.
- **Undo** (Ctrl+Z) and **Redo** (Ctrl+Y or Ctrl+Shift+Z) undo and redo each change.

Changes are kept by Flareite until you save them, as a document's are: the tab shows they're
unsaved, **File: Save** (Ctrl+S) and **Save All** write the file, **File: Revert File** drops
them, and closing the tab or Flareite asks first. Files up to 256 MiB can be changed.

## How it works

The page (`media/editor.html`, `editor.js`, `editor.css`) draws the rows in view and asks the
extension's code (`src/lib.rs`) for bytes with messages; the code reads them with
`viewers::read-viewed-file` and sends them back in base64. Changes go the other way, as
`viewers::edit-viewed-file` calls, each with the file's version so a stale one is refused. Search
runs in the code (`src/search.rs`), a few megabytes at a time. It needs Flareite with extension
API 2.2 (editable viewers).
