//! Base64 (RFC 4648, with padding), how bytes travel to and from the page
//! in its JSON messages: a third bigger than the bytes, where hexadecimal
//! would double them.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
  let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for chunk in bytes.chunks(3) {
    let b = [
      chunk[0],
      chunk.get(1).copied().unwrap_or(0),
      chunk.get(2).copied().unwrap_or(0),
    ];
    let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
    for i in 0..4 {
      if i <= chunk.len() {
        text.push(char::from(ALPHABET[(n >> (18 - 6 * i)) as usize & 63]));
      } else {
        text.push('=');
      }
    }
  }
  text
}

fn value(c: u8) -> Option<u32> {
  Some(u32::from(match c {
    b'A'..=b'Z' => c - b'A',
    b'a'..=b'z' => c - b'a' + 26,
    b'0'..=b'9' => c - b'0' + 52,
    b'+' => 62,
    b'/' => 63,
    _ => return None,
  }))
}

/// Decodes base64, with or without padding; `None` if it isn't.
pub fn decode(text: &str) -> Option<Vec<u8>> {
  let text = text.trim_end_matches('=').as_bytes();
  if text.len() % 4 == 1 {
    return None;
  }
  let mut bytes = Vec::with_capacity(text.len() * 3 / 4);
  for chunk in text.chunks(4) {
    let mut n = 0;
    for (i, &c) in chunk.iter().enumerate() {
      n |= value(c)? << (18 - 6 * i);
    }
    let count = chunk.len() - 1;
    for i in 0..count {
      bytes.push((n >> (16 - 8 * i)) as u8);
    }
  }
  Some(bytes)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn round_trips_every_length() {
    for (bytes, text) in [
      (&b""[..], ""),
      (b"f", "Zg=="),
      (b"fo", "Zm8="),
      (b"foo", "Zm9v"),
      (b"foob", "Zm9vYg=="),
      (&[0xFF, 0x00, 0xFE], "/wD+"),
    ] {
      assert_eq!(encode(bytes), text);
      assert_eq!(decode(text).as_deref(), Some(bytes));
    }
    assert_eq!(decode("Zm9vYg").as_deref(), Some(&b"foob"[..]));
    assert_eq!(decode("Zm9v!"), None);
    assert_eq!(decode("Z"), None);
  }
}
