//! Finding bytes in a file, read a chunk at a time.

/// Most matches one search returns.
pub const MAX_MATCHES: usize = 10_000;

/// Bytes read at once.
pub const CHUNK: usize = 4 * 1024 * 1024;

/// Where `pattern` is found, matched as bytes or, with `ignore_case`, with
/// ASCII letters in either case.
pub struct Finder {
  pattern: Vec<u8>,
  ignore_case: bool,
}

impl Finder {
  pub fn new(pattern: Vec<u8>, ignore_case: bool) -> Self {
    let pattern = if ignore_case {
      pattern.to_ascii_lowercase()
    } else {
      pattern
    };
    Finder {
      pattern,
      ignore_case,
    }
  }

  fn same(&self, byte: u8, wanted: u8) -> bool {
    if self.ignore_case {
      byte.to_ascii_lowercase() == wanted
    } else {
      byte == wanted
    }
  }

  /// Every match starting in the file, reading it with `read(offset,
  /// length)`, up to [`MAX_MATCHES`]. Also says whether there were more.
  pub fn find_all(
    &self,
    size: u64,
    mut read: impl FnMut(u64, usize) -> Result<Vec<u8>, String>,
  ) -> Result<(Vec<u64>, bool), String> {
    let mut matches = Vec::new();
    let length = self.pattern.len();
    if length == 0 || length as u64 > size {
      return Ok((matches, false));
    }
    let mut offset = 0u64;
    while offset < size {
      // Each chunk overlaps the next by the pattern's length, less one, so
      // matches across their boundary are found once.
      let chunk = read(offset, CHUNK + length - 1)?;
      if chunk.len() < length {
        break;
      }
      let first = self.pattern[0];
      for start in 0..=(chunk.len() - length).min(CHUNK - 1) {
        if self.same(chunk[start], first)
          && chunk[start + 1..start + length]
            .iter()
            .zip(&self.pattern[1..])
            .all(|(&byte, &wanted)| self.same(byte, wanted))
        {
          if matches.len() == MAX_MATCHES {
            return Ok((matches, true));
          }
          matches.push(offset + start as u64);
        }
      }
      offset += CHUNK as u64;
    }
    Ok((matches, false))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn find(haystack: &[u8], pattern: &[u8], ignore_case: bool) -> Vec<u64> {
    Finder::new(pattern.to_vec(), ignore_case)
      .find_all(haystack.len() as u64, |offset, length| {
        let start = offset as usize;
        Ok(haystack[start..(start + length).min(haystack.len())].to_vec())
      })
      .unwrap()
      .0
  }

  #[test]
  fn finds_bytes_and_text_in_either_case() {
    assert_eq!(find(b"abcabc", b"bc", false), [1, 4]);
    assert_eq!(find(b"aaaa", b"aa", false), [0, 1, 2]);
    assert_eq!(find(b"Hello HELLO", b"hello", true), [0, 6]);
    assert_eq!(find(b"Hello HELLO", b"hello", false), [] as [u64; 0]);
    assert_eq!(find(&[0, 0xFF, 0xFE], &[0xFF, 0xFE], true), [1]);
    assert_eq!(find(b"ab", b"abc", false), [] as [u64; 0]);
    assert_eq!(find(b"ab", b"", false), [] as [u64; 0]);
  }

  #[test]
  fn finds_matches_across_chunks_once() {
    let mut haystack = vec![0u8; CHUNK + 10];
    haystack[CHUNK - 1] = 7;
    haystack[CHUNK] = 8;
    haystack[CHUNK + 5] = 7;
    haystack[CHUNK + 6] = 8;
    assert_eq!(
      find(&haystack, &[7, 8], false),
      [CHUNK as u64 - 1, CHUNK as u64 + 5]
    );
  }
}
