//! Hex Editor for Flareite: an editable webview viewer that shows any
//! file's bytes, as hexadecimal and as text, and changes them.
//!
//! The page (`media/editor.html`) draws the bytes and handles the keys and
//! the mouse. It asks this code for what it needs with messages (JSON, a
//! `type` each), which come as `webview-message` events, and gets answers
//! back the same way:
//!
//! - `info` → the file's state (`size`, `version`, `dirty`, `canUndo`,
//!   `canRedo`).
//! - `read` (`id`, `offset`, `length`) → `bytes`: the bytes there (base64),
//!   and the state. Reads see the unsaved changes.
//! - `edit` (`version`, `changes`: `offset`, `removed`, base64 `data`) →
//!   `edited` with the new state, or `stale` if the file changed since the
//!   page's version (an undo from the workbench): the page reads it again.
//! - `undo` and `redo` → `stepped`: where the change was, for the cursor.
//! - `find` (`id`, base64 `query`, `ignoreCase`) → `found`: every match's
//!   offset, up to 10,000.
//!
//! Flareite keeps the changes (API 2.2 editable viewers) until the user
//! saves or reverts them. When the bytes change other than by the page
//! (Undo from the Edit menu, Revert File, the file changing on disk), a
//! `viewer-opened` event comes, and the page is told to `reload`.

mod base64;
mod search;

use flareite_extension_api::events::Event;
use flareite_extension_api::types::{Activation, ApiError, ViewedFile, Webview, WebviewMessage};
use flareite_extension_api::viewers::{self, ByteChange, ViewedFileState};
use flareite_extension_api::{Extension, register, webviews};
use serde::{Deserialize, Serialize};

/// Most bytes one `read` returns.
const MAX_READ: u32 = 1024 * 1024;

/// A message from the page.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Request {
  Info,
  Read {
    id: u64,
    offset: u64,
    length: u32,
  },
  Edit {
    version: u64,
    changes: Vec<ChangeRequest>,
  },
  Undo,
  Redo,
  #[serde(rename_all = "camelCase")]
  Find {
    id: u64,
    query: String,
    ignore_case: bool,
  },
}

#[derive(Debug, Deserialize, PartialEq)]
struct ChangeRequest {
  offset: u64,
  removed: u64,
  /// The bytes put there, in base64.
  data: String,
}

/// How the file stands, for the page.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct State {
  size: u64,
  version: u64,
  dirty: bool,
  can_undo: bool,
  can_redo: bool,
}

impl From<ViewedFileState> for State {
  fn from(state: ViewedFileState) -> Self {
    State {
      size: state.size,
      version: state.version,
      dirty: state.dirty,
      can_undo: state.can_undo,
      can_redo: state.can_redo,
    }
  }
}

#[derive(Debug, Serialize, PartialEq)]
struct Step {
  offset: u64,
  length: u64,
}

/// A message to the page.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Reply {
  Info {
    state: State,
  },
  Bytes {
    id: u64,
    offset: u64,
    data: String,
    state: State,
  },
  Edited {
    state: State,
  },
  Stale {
    state: State,
  },
  Stepped {
    undo: bool,
    step: Option<Step>,
    state: State,
  },
  Found {
    id: u64,
    matches: Vec<u64>,
    truncated: bool,
  },
  Error {
    message: String,
  },
  Reload,
}

fn describe(error: ApiError) -> String {
  match error {
    ApiError::InvalidArgument(message)
    | ApiError::TooLarge(message)
    | ApiError::InvalidRange(message) => message,
    ApiError::StaleVersion(version) => format!("the file changed (now version {version})"),
    ApiError::PermissionDenied(_) | ApiError::UnknownDocument => "the file can't be read".into(),
  }
}

fn state(file: &ViewedFile) -> Result<State, String> {
  viewers::viewed_file_status(&file.viewer, &file.path)
    .map(State::from)
    .map_err(describe)
}

/// Answers one of the page's requests.
fn answer(file: &ViewedFile, request: Request) -> Result<Reply, String> {
  let (viewer, path) = (file.viewer.as_str(), file.path.as_str());
  Ok(match request {
    Request::Info => Reply::Info {
      state: state(file)?,
    },
    Request::Read { id, offset, length } => {
      let read =
        viewers::read_viewed_file(viewer, path, offset, length.min(MAX_READ)).map_err(describe)?;
      Reply::Bytes {
        id,
        offset,
        data: base64::encode(&read.bytes),
        state: state(file)?,
      }
    }
    Request::Edit { version, changes } => {
      let changes = changes
        .into_iter()
        .map(|change| {
          Ok(ByteChange {
            offset: change.offset,
            removed: change.removed,
            inserted: base64::decode(&change.data)
              .ok_or("the page sent bytes that aren't base64")?,
          })
        })
        .collect::<Result<Vec<_>, String>>()?;
      match viewers::edit_viewed_file(viewer, path, version, &changes) {
        Ok(after) => Reply::Edited {
          state: after.into(),
        },
        Err(ApiError::StaleVersion(_)) => Reply::Stale {
          state: state(file)?,
        },
        Err(error) => return Err(describe(error)),
      }
    }
    Request::Undo | Request::Redo => {
      let undo = request == Request::Undo;
      let stepped = if undo {
        viewers::undo_viewed_file(viewer, path)
      } else {
        viewers::redo_viewed_file(viewer, path)
      }
      .map_err(describe)?;
      Reply::Stepped {
        undo,
        step: stepped.as_ref().map(|step| Step {
          offset: step.offset,
          length: step.length,
        }),
        state: match stepped {
          Some(step) => step.state.into(),
          None => state(file)?,
        },
      }
    }
    Request::Find {
      id,
      query,
      ignore_case,
    } => {
      let pattern = base64::decode(&query).ok_or("the page sent a query that isn't base64")?;
      let size = state(file)?.size;
      let finder = search::Finder::new(pattern, ignore_case);
      let (matches, truncated) = finder.find_all(size, |offset, length| {
        viewers::read_viewed_file(viewer, path, offset, length as u32)
          .map(|read| read.bytes)
          .map_err(describe)
      })?;
      Reply::Found {
        id,
        matches,
        truncated,
      }
    }
  })
}

fn post(webview: &Webview, reply: &Reply) -> Result<(), String> {
  let json = serde_json::to_string(reply).map_err(|error| error.to_string())?;
  // False when the tab closed meanwhile: nothing to do.
  webviews::post_message(webview, &json).map_err(describe)?;
  Ok(())
}

fn handle_message(message: &WebviewMessage) -> Result<(), String> {
  let Webview::Viewer(file) = &message.source else {
    return Ok(());
  };
  let reply = match serde_json::from_str::<Request>(&message.data) {
    Ok(request) => answer(file, request).unwrap_or_else(|message| Reply::Error { message }),
    Err(error) => Reply::Error {
      message: format!("the page sent a message the extension doesn't understand: {error}"),
    },
  };
  post(&message.source, &reply)
}

struct HexEditor;

impl Extension for HexEditor {
  fn activate(_: Activation) -> Result<Self, String> {
    Ok(HexEditor)
  }

  fn handle_event(&mut self, event: Event) -> Result<(), String> {
    match event {
      Event::WebviewMessage(message) => handle_message(&message),
      // Opened, or its bytes changed other than by the page: the page
      // reads them again (it asks for them itself when it loads).
      Event::ViewerOpened(file) => post(&Webview::Viewer(file), &Reply::Reload),
      _ => Ok(()),
    }
  }
}

register!(HexEditor);

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_the_pages_requests() {
    let request: Request = serde_json::from_str(
      r#"{"type":"edit","version":3,"changes":[{"offset":1,"removed":0,"data":"/w=="}]}"#,
    )
    .unwrap();
    assert_eq!(
      request,
      Request::Edit {
        version: 3,
        changes: vec![ChangeRequest {
          offset: 1,
          removed: 0,
          data: "/w==".into()
        }]
      }
    );
    let request: Request =
      serde_json::from_str(r#"{"type":"find","id":2,"query":"YQ==","ignoreCase":true}"#).unwrap();
    assert_eq!(
      request,
      Request::Find {
        id: 2,
        query: "YQ==".into(),
        ignore_case: true
      }
    );
    assert!(serde_json::from_str::<Request>(r#"{"type":"save"}"#).is_err());
  }

  #[test]
  fn answers_in_the_pages_terms() {
    let reply = Reply::Stepped {
      undo: true,
      step: Some(Step {
        offset: 4,
        length: 1,
      }),
      state: State {
        size: 10,
        version: 2,
        dirty: false,
        can_undo: false,
        can_redo: true,
      },
    };
    assert_eq!(
      serde_json::to_string(&reply).unwrap(),
      r#"{"type":"stepped","undo":true,"step":{"offset":4,"length":1},"state":{"size":10,"version":2,"dirty":false,"canUndo":false,"canRedo":true}}"#
    );
    assert_eq!(
      serde_json::to_string(&Reply::Reload).unwrap(),
      r#"{"type":"reload"}"#
    );
  }
}
