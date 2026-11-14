//! Bookmark loading from config and JSON files.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::Bookmark;

/// Response shape for `GET /api/bookmarks`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicBookmark {
    pub id: String,
    pub name: String,
    pub frequency: i64,
    pub mode: String,
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub bandwidth: i32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub source: String,
    pub implemented: bool,
}

fn is_zero_i32(v: &i32) -> bool {
    *v == 0
}

/// Canonical mode id for a config/bookmark value.
///
/// Admin bookmark files are refreshed from an external source, so they use a
/// mixture of protocol names (`fax`, `sitorb`, `rtty450`) and canonical ids.
/// Normalise them here once, then use the same rules for implementation
/// detection and for the public API.
fn canonical_mode(mode: &str) -> String {
    match mode.trim().to_ascii_lowercase().as_str() {
        "fm" | "wfm" => "wfm",
        "nfm" => "nfm",
        "am" => "am",
        "am-stereo" | "ams" => "am-stereo",
        "sam" => "sam",
        "usb" => "usb",
        "lsb" => "lsb",
        "cw" => "cw",
        "raw" => "raw",
        "fax" | "wefax" => "wefax",
        "sitorb" | "sitor-b" | "sitor" | "navtex" => "navtex",
        "rtty450" | "rtty-450" | "rtty" => "rtty",
        "mode-s" | "modes" | "adsb" => "adsb",
        "ais-sotdma" | "ais" => "ais",
        other => other,
    }
    .to_string()
}

fn implemented_mode(mode: &str) -> bool {
    matches!(
        canonical_mode(mode).as_str(),
        "wfm"
            | "nfm"
            | "am"
            | "am-stereo"
            | "sam"
            | "usb"
            | "lsb"
            | "cw"
            | "raw"
            | "adsb"
            | "acars"
            | "vdl2"
            | "hfdl"
            | "ais"
            | "aprs"
            | "navtex"
            | "ism"
            | "packet"
            | "ft8"
            | "ft4"
            | "ft2"
            | "fst4"
            | "q65"
            | "jt65"
            | "jt9"
            | "wefax"
            | "sstv"
            | "hell"
            | "olivia"
            | "thor"
            | "fsq"
            | "psk31"
            | "rtty"
            | "msk144"
            | "fsk441"
            | "wspr"
            | "pi4"
            | "js8"
            | "dcf77"
            | "als162"
    )
}

fn modulation_to_mode(modulation: &str) -> String {
    canonical_mode(modulation)
}

#[derive(Debug, Deserialize)]
struct FileBookmarkRaw {
    #[serde(default)]
    name: String,
    #[serde(default)]
    frequency: i64,
    #[serde(default)]
    modulation: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    bandwidth: i32,
}

/// Deterministic ID for a file-sourced bookmark.
fn stable_id(file_path: &str, name: &str, frequency: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{file_path}:{name}:{frequency}").as_bytes());
    let digest = hasher.finalize();
    format!("file-{}", hex::encode(&digest[..3]))
}

/// Converts config bookmarks into public bookmarks.
pub fn from_config(bookmarks: &[Bookmark]) -> Vec<PublicBookmark> {
    bookmarks
        .iter()
        .map(|b| PublicBookmark {
            id: b.id.clone(),
            name: b.name.clone(),
            frequency: b.frequency,
            mode: canonical_mode(&b.mode),
            bandwidth: b.bandwidth,
            description: b.description.clone(),
            source: "config".to_string(),
            implemented: implemented_mode(&b.mode),
        })
        .collect()
}

/// Walks `dir` recursively and loads every `.json` bookmark list.
pub fn load_file_bookmarks(dir: &str) -> Vec<PublicBookmark> {
    let mut result = Vec::new();
    walk(Path::new(dir), Path::new(dir), &mut result);
    result
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<PublicBookmark>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut paths: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();

    for path in paths {
        if path.is_dir() {
            walk(root, &path, out);
            continue;
        }
        let is_json = path
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }

        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let raw: Vec<FileBookmarkRaw> = match serde_json::from_slice(&data) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        for r in raw {
            if r.name.is_empty() || r.frequency <= 0 {
                continue;
            }
            let modulation = r.modulation.trim().to_ascii_lowercase();
            let mode = modulation_to_mode(&modulation);
            out.push(PublicBookmark {
                id: stable_id(&rel, &r.name, r.frequency),
                name: r.name,
                frequency: r.frequency,
                implemented: implemented_mode(&mode),
                mode,
                bandwidth: r.bandwidth,
                description: r.description,
                source: "file".to_string(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_json_bookmarks_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("b.json"),
            r#"[{"name":"Test","frequency":1000000,"modulation":"FM","description":"d","bandwidth":200000}]"#,
        )
        .unwrap();

        let bms = load_file_bookmarks(dir.path().to_str().unwrap());
        assert_eq!(bms.len(), 1);
        assert_eq!(bms[0].name, "Test");
        assert_eq!(bms[0].mode, "wfm");
        assert!(bms[0].implemented);
        assert_eq!(bms[0].source, "file");
        assert!(bms[0].id.starts_with("file-"));
    }

    #[test]
    fn config_bookmarks_are_marked_config() {
        let b = Bookmark {
            id: "x".into(),
            name: "n".into(),
            frequency: 1,
            mode: "cw".into(),
            ..Default::default()
        };
        let out = from_config(&[b]);
        assert_eq!(out[0].source, "config");
        assert!(out[0].implemented);
    }

    #[test]
    fn decoder_bookmarks_are_implemented() {
        // Every decoder surfaced by the client, plus common upstream aliases.
        for mode in [
            "adsb", "acars", "vdl2", "hfdl", "ais", "aprs", "navtex", "ism", "packet", "ft8",
            "ft4", "ft2", "fst4", "q65", "jt65", "jt9", "wefax", "sstv", "hell", "olivia",
            "thor", "fsq", "psk31", "rtty", "msk144", "fsk441", "wspr", "pi4", "js8", "dcf77",
            "als162", "fax", "sitorb", "rtty450", "mode-s",
        ] {
            let b = Bookmark {
                id: "x".into(),
                name: "n".into(),
                frequency: 1,
                mode: mode.into(),
                ..Default::default()
            };
            let out = from_config(&[b]);
            assert!(out[0].implemented, "{mode} should be marked implemented");
        }
    }

    #[test]
    fn bookmark_mode_aliases_are_canonicalised() {
        assert_eq!(canonical_mode("fax"), "wefax");
        assert_eq!(canonical_mode("sitorb"), "navtex");
        assert_eq!(canonical_mode("rtty450"), "rtty");
        assert_eq!(canonical_mode("mode-s"), "adsb");
        assert_eq!(canonical_mode("FM"), "wfm");
    }
}
