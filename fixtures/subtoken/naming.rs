// Convention-equivalence fixture.
//
// Two things live here that the Zed checkout cannot supply cheaply:
//
//   1. PAIRS THAT MEAN THE SAME THING AT A BOUNDARY. Rust is snake_case end to
//      end, so inside a pure Rust tree a naming-convention mismatch never shows
//      up. It shows up at every boundary — serde `rename_all`, JSON keys,
//      string-literal invocations, generated bindings, TS↔Rust FFI, CLI flags —
//      where the caller writes a snake_case symbol in the camelCase spelling its
//      binding uses. Each pair below is exactly that guess. (The guessed
//      spellings are deliberately NOT written anywhere in this file, so "grep
//      finds zero occurrences of the query" is a real statement and not a
//      comment artefact.)
//
//   2. PAIRS THAT ONLY LOOK ALIKE. The `list_user_profile` / `list_user_profiles`
//      and `list_user_id` / `list_user_ids` pairs must never collapse into one
//      subtoken key, or a near-miss would be reported as a hit.
//
// Kept Rust-only on purpose: `parity-check.mjs`'s oracle is GNU grep over
// `--include=*.rs`, so a fixture that mixes languages would have to weaken the
// oracle. Cross-language convention cases are unit-tested in `test.mjs`.

pub trait HttpFetcher {
    fn fetch(&self) -> bool;
}

pub struct UserProfile {
    pub id: u64,
}

pub struct UserProfileIndex {
    pub size: usize,
}

pub fn get_user_by_id(id: u64) -> UserProfile {
    UserProfile { id }
}

pub fn get_user_by_name(name: &str) -> UserProfile {
    let _ = name;
    UserProfile { id: 0 }
}

// Near-identical, must stay distinct.
pub fn list_user_profile() -> usize {
    1
}

pub fn list_user_profiles() -> usize {
    2
}

pub fn list_user_id() -> u64 {
    3
}

pub fn list_user_ids() -> u64 {
    4
}

pub const MAX_RETRY_COUNT: u32 = 3;

pub static DEFAULT_TIMEOUT_MS: u64 = 500;

impl HttpFetcher for UserProfile {
    fn fetch(&self) -> bool {
        true
    }
}

impl UserProfile {
    pub fn display_name(&self) -> &'static str {
        "user"
    }
}
