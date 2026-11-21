//! Bookmark loading from config and JSON files.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::Bookmark;

/// Synthetic region id for the shared bookmark files in the bookmarks root.
pub const GLOBAL_REGION: &str = "global";

/// One selectable bookmark region/country folder, for the admin UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkRegion {
    pub id: String,
    pub label: String,
    pub files: usize,
    pub bookmarks: usize,
}

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
///
/// `regions` is the server's configured selection. `None` includes everything;
/// `Some` includes the shared root-level files only when it contains
/// [`GLOBAL_REGION`], plus any top-level folder listed in the selection.
pub fn load_file_bookmarks(dir: &str, regions: Option<&[String]>) -> Vec<PublicBookmark> {
    let mut result = Vec::new();
    walk(Path::new(dir), Path::new(dir), regions, &mut result);
    result
}

/// Lists the top-level bookmark folders plus the shared root-level files.
pub fn scan_regions(dir: &str) -> Vec<BookmarkRegion> {
    let root = Path::new(dir);
    let mut out = Vec::new();

    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    let mut paths: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();

    let (mut global_files, mut global_bookmarks) = (0usize, 0usize);
    for path in &paths {
        if path.is_file() && is_json(path) {
            let (files, bookmarks) = count_file(path);
            global_files += files;
            global_bookmarks += bookmarks;
        }
    }
    if global_files > 0 {
        out.push(BookmarkRegion {
            id: GLOBAL_REGION.to_string(),
            label: region_label(GLOBAL_REGION),
            files: global_files,
            bookmarks: global_bookmarks,
        });
    }

    for path in &paths {
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let mut files = 0usize;
        let mut bookmarks = 0usize;
        count_tree(path, &mut files, &mut bookmarks);
        if files == 0 {
            continue;
        }
        out.push(BookmarkRegion {
            label: region_label(&id),
            id,
            files,
            bookmarks,
        });
    }

    // Shared files first, then ITU regions, then country folders.
    out.sort_by_key(|r| match r.id.as_str() {
        GLOBAL_REGION => (0, String::new()),
        "r1" => (1, String::new()),
        "r2" => (2, String::new()),
        "r3" => (3, String::new()),
        _ => (4, r.id.clone()),
    });
    out
}

/// Human-readable label for a bookmark region folder.
pub fn region_label(id: &str) -> String {
    match id {
        GLOBAL_REGION => "Shared / global".to_string(),
        "r1" => "ITU Region 1 — Europe, Africa, Middle East".to_string(),
        "r2" => "ITU Region 2 — Americas".to_string(),
        "r3" => "ITU Region 3 — Asia-Pacific".to_string(),
        "br" => "Brazil".to_string(),
        "cn" => "China".to_string(),
        "de" => "Germany".to_string(),
        "no" => "Norway".to_string(),
        "se" => "Sweden".to_string(),
        "us" => "United States".to_string(),
        other => other.to_ascii_uppercase(),
    }
}

fn is_json(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

/// Counts JSON files and bookmarks in a single file.
fn count_file(path: &Path) -> (usize, usize) {
    let Ok(data) = std::fs::read(path) else {
        return (0, 0);
    };
    let Ok(raw) = serde_json::from_slice::<Vec<FileBookmarkRaw>>(&data) else {
        return (0, 0);
    };
    (1, raw.iter().filter(|r| !r.name.is_empty() && r.frequency > 0).count())
}

/// Counts JSON files and bookmarks recursively below `dir`.
fn count_tree(dir: &Path, files: &mut usize, bookmarks: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            count_tree(&path, files, bookmarks);
        } else if is_json(&path) {
            let (f, b) = count_file(&path);
            *files += f;
            *bookmarks += b;
        }
    }
}

/// Returns the top-level bookmark group a path belongs to.
fn group_id(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut components = rel.components();
    match components.next() {
        Some(std::path::Component::Normal(first)) if components.next().is_some() => {
            first.to_string_lossy().to_string()
        }
        _ => GLOBAL_REGION.to_string(),
    }
}

fn walk(
    root: &Path,
    dir: &Path,
    regions: Option<&[String]>,
    out: &mut Vec<PublicBookmark>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut paths: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();

    for path in paths {
        if path.is_dir() {
            walk(root, &path, regions, out);
            continue;
        }
        if !is_json(&path) {
            continue;
        }

        let relative = group_id(root, &path);
        if let Some(selected) = regions {
            if !selected.iter().any(|r| r == &relative) {
                continue;
            }
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

        let bms = load_file_bookmarks(dir.path().to_str().unwrap(), None);
        assert_eq!(bms.len(), 1);
        assert_eq!(bms[0].name, "Test");
        assert_eq!(bms[0].mode, "wfm");
        assert!(bms[0].implemented);
        assert_eq!(bms[0].source, "file");
        assert!(bms[0].id.starts_with("file-"));
    }

    #[test]
    fn region_selection_filters_folders_and_global_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("r1")).unwrap();
        std::fs::create_dir_all(root.join("us")).unwrap();
        std::fs::write(
            root.join("shared.json"),
            r#"[{"name":"Shared","frequency":1000000,"modulation":"FM"}]"#,
        )
        .unwrap();
        std::fs::write(
            root.join("r1").join("a.json"),
            r#"[{"name":"Region","frequency":2000000,"modulation":"NFM"}]"#,
        )
        .unwrap();
        std::fs::write(
            root.join("us").join("b.json"),
            r#"[{"name":"Country","frequency":3000000,"modulation":"NFM"}]"#,
        )
        .unwrap();

        let all = load_file_bookmarks(root.to_str().unwrap(), None);
        assert_eq!(all.len(), 3);

        let only_region = load_file_bookmarks(
            root.to_str().unwrap(),
            Some(&["r1".to_string()]),
        );
        assert_eq!(only_region.len(), 1);
        assert_eq!(only_region[0].name, "Region");

        let global_and_country = load_file_bookmarks(
            root.to_str().unwrap(),
            Some(&[GLOBAL_REGION.to_string(), "us".to_string()]),
        );
        let mut names: Vec<_> = global_and_country.iter().map(|b| b.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["Country", "Shared"]);

        let none = load_file_bookmarks(root.to_str().unwrap(), Some(&[]));
        assert!(none.is_empty());
    }

    #[test]
    fn scan_regions_lists_global_and_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("r1")).unwrap();
        std::fs::create_dir_all(root.join("us")).unwrap();
        std::fs::write(
            root.join("shared.json"),
            r#"[{"name":"Shared","frequency":1000000,"modulation":"FM"}]"#,
        )
        .unwrap();
        std::fs::write(
            root.join("r1").join("a.json"),
            r#"[{"name":"Region","frequency":2000000,"modulation":"NFM"}]"#,
        )
        .unwrap();

        let regions = scan_regions(root.to_str().unwrap());
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].id, GLOBAL_REGION);
        assert_eq!(regions[0].bookmarks, 1);
        assert_eq!(regions[1].id, "r1");
        assert_eq!(regions[1].bookmarks, 1);
        assert_eq!(regions[1].label, region_label("r1"));
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
