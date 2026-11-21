//! Feature-independent IP geolocation result.
//!
//! The `geoip` feature owns the MMDB reader and updater; this small type is
//! always compiled so `ClientState`, `UserLocation` and the admin client view
//! can carry a lookup result even in dependency-free builds (where it is
//! always `None`).

use serde::{Deserialize, Serialize};

/// One IP's location. Public clients receive only the country/region fields
/// through `UserLocation`; administrators get the full record.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoInfo {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub country_code: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub country: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub region: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub region_code: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub city: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub continent: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub continent_code: String,
}

impl GeoInfo {
    /// True when the database returned only an empty record.
    pub fn is_empty(&self) -> bool {
        self.country_code.is_empty()
            && self.country.is_empty()
            && self.region.is_empty()
            && self.region_code.is_empty()
            && self.city.is_empty()
            && self.continent.is_empty()
            && self.continent_code.is_empty()
            && self.latitude.is_none()
            && self.longitude.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_payload_is_detected() {
        assert!(GeoInfo::default().is_empty());
        let info = GeoInfo {
            country_code: "GR".into(),
            ..GeoInfo::default()
        };
        assert!(!info.is_empty());
    }

    #[test]
    fn serializes_as_camel_case() {
        let value = serde_json::to_value(GeoInfo {
            country_code: "GR".into(),
            country: "Greece".into(),
            region: "Attica".into(),
            region_code: "A".into(),
            city: "Athens".into(),
            latitude: Some(37.98),
            longitude: Some(23.72),
            continent: "Europe".into(),
            continent_code: "EU".into(),
        })
        .unwrap();
        assert_eq!(value["countryCode"], "GR");
        assert_eq!(value["regionCode"], "A");
        assert_eq!(value["latitude"], 37.98);
    }
}
