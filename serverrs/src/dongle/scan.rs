//! Non-invasive device enumeration for the admin page.
//!
//! Every backend's `list`/`enumerate` call is safe to run while another
//! receiver is streaming: it reads descriptors and, for the vendor-library
//! backends, asks the library/service for its device table without opening
//! anything. The result is flattened into one JSON-friendly row shape so the
//! admin UI only needs one scan path.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedDevice {
    /// Source type this row belongs to (`local`, `hackrf`, `sdrplay`, ...).
    pub source: String,
    /// Human-readable device name.
    pub name: String,
    /// Serial to put in `source.serial`; empty when the device has none.
    pub serial: String,
    /// Device index for sources that open by index (RTL-SDR).
    pub index: Option<u32>,
    /// Network address for sources that open over a network (Pluto).
    pub address: Option<String>,
    /// One-line description for the picker.
    pub label: String,
    /// Extra state worth showing, e.g. "firmware will be uploaded".
    pub detail: String,
}

#[allow(dead_code)]
fn row(source: &str, name: String, serial: String, label: String) -> ScannedDevice {
    ScannedDevice {
        source: source.to_string(),
        name,
        serial,
        index: None,
        address: None,
        label,
        detail: String::new(),
    }
}

/// Enumerate devices for one source type, or all known source types when
/// `kind` is `None`.
#[allow(unused_mut)]
pub fn scan_devices(kind: Option<&str>) -> Vec<ScannedDevice> {
    let want = kind.unwrap_or("").trim();
    let all = want.is_empty();
    let _ = all;
    let mut out = Vec::new();

    #[cfg(feature = "rtlsdr")]
    if all || want == "local" {
        for d in crate::dongle::rtlsdr::enumerate_local_devices() {
            let mut r = row(
                "local",
                d.name.clone(),
                d.serial.clone(),
                format!("{}  (index {})", d.name, d.index),
            );
            r.index = Some(d.index.max(0) as u32);
            if !d.available {
                r.detail = "unavailable (driver bound or permission denied)".into();
            }
            out.push(r);
        }
    }

    #[cfg(feature = "hackrf")]
    if all || want == "hackrf" {
        for d in sdroxide_hackrf::list() {
            out.push(row(
                "hackrf",
                d.name.clone(),
                d.serial.clone().unwrap_or_default(),
                d.label(),
            ));
        }
    }

    #[cfg(feature = "airspy")]
    if all || want == "airspy" {
        for d in sdroxide_airspy::list() {
            out.push(row(
                "airspy",
                d.name.clone(),
                d.serial.clone().unwrap_or_default(),
                d.label(),
            ));
        }
    }

    #[cfg(feature = "airspyhf")]
    if all || want == "airspyhf" {
        for d in sdroxide_airspyhf::list() {
            out.push(row(
                "airspyhf",
                d.name.clone(),
                d.serial.clone().unwrap_or_default(),
                d.label(),
            ));
        }
    }

    #[cfg(feature = "hydrasdr")]
    if all || want == "hydrasdr" {
        for d in sdroxide_hydrasdr::list() {
            out.push(row(
                "hydrasdr",
                d.name.clone(),
                d.serial.clone().unwrap_or_default(),
                d.label(),
            ));
        }
    }

    #[cfg(feature = "elad")]
    if all || want == "elad" {
        for d in sdroxide_elad::list() {
            out.push(row(
                "elad",
                d.name.clone(),
                d.serial.clone().unwrap_or_default(),
                d.label(),
            ));
        }
    }

    #[cfg(feature = "rx888")]
    if all || want == "rx888" {
        for d in sdroxide_rx888::list() {
            let mut r = row(
                "rx888",
                d.name.clone(),
                d.serial.clone().unwrap_or_default(),
                d.label(),
            );
            if d.needs_firmware {
                r.detail = "firmware will be uploaded on open".into();
            } else if !d.superspeed {
                r.detail = "USB 2.0 link; use a SuperSpeed port for high rates".into();
            }
            out.push(r);
        }
    }

    #[cfg(feature = "pluto")]
    if all || want == "pluto" {
        for d in sdroxide_pluto::discover_default() {
            let mut r = row(
                "pluto",
                if d.model.is_empty() {
                    "PlutoSDR".to_string()
                } else {
                    d.model.clone()
                },
                d.serial.clone(),
                d.label(),
            );
            r.address = Some(d.ip.clone());
            if !d.firmware.is_empty() {
                r.detail = format!("firmware {}", d.firmware);
            }
            out.push(r);
        }
    }

    #[cfg(feature = "sdrplay")]
    if all || want == "sdrplay" {
        if let Ok(devices) = sdroxide_sdrplay::try_list() {
            for d in devices {
                let mut r = row(
                    "sdrplay",
                    d.model().label().to_string(),
                    d.serial.clone(),
                    d.label(),
                );
                if let Some(warning) = d.identity_warning() {
                    r.detail = warning;
                }
                out.push(r);
            }
        }
    }

    #[cfg(feature = "lime")]
    if all || want == "lime" {
        if let Ok(found) = sdroxide_lime::try_list() {
            for d in found.devices {
                let mut r = row("lime", d.name.clone(), d.serial.clone(), d.label());
                if !d.media.is_empty() {
                    r.detail = d.media;
                }
                out.push(r);
            }
        }
    }

    #[cfg(feature = "fobos")]
    if all || want == "fobos" {
        if let Ok(devices) = sdroxide_fobos::try_list() {
            for d in devices {
                let label = format!("Fobos SDR  (serial {})", d.serial);
                out.push(row("fobos", "Fobos SDR".into(), d.serial.clone(), label));
            }
        }
    }

    out
}
