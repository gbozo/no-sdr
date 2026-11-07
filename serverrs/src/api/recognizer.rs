//! Music recognition via AudD (primary) and ACRCloud (fallback).

use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use tracing::{error, info};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecognizeResult {
    pub title: String,
    pub artist: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub album: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub isrc: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub spotify: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub youtube: String,
    #[serde(default, skip_serializing_if = "String::is_empty", rename = "apple")]
    pub apple_url: String,
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub score: i32,
    pub service: String,
}

fn is_zero_i32(v: &i32) -> bool {
    *v == 0
}

#[derive(Debug, Clone, Default)]
pub struct RecognizerConfig {
    pub audd_api_key: String,
    pub acrcloud_host: String,
    pub acrcloud_access_key: String,
    pub acrcloud_access_secret: String,
}

/// Encodes mono/stereo float32 @48 kHz as a 22.05 kHz mono 16-bit WAV.
pub fn encode_wav(pcm: &[f32], channels: usize, sample_rate: u32) -> Vec<u8> {
    let mono: Vec<f32> = if channels == 2 {
        pcm.chunks_exact(2)
            .map(|c| (c[0] + c[1]) * 0.5)
            .collect()
    } else {
        pcm.to_vec()
    };

    let resampled = resample_lanczos(&mono, sample_rate as i32, 22050);
    let data_size = resampled.len() * 2;
    let mut out = Vec::with_capacity(44 + data_size);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&22050u32.to_le_bytes());
    out.extend_from_slice(&(22050u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_size as u32).to_le_bytes());
    for s in resampled {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

fn resample_lanczos(src: &[f32], src_rate: i32, dst_rate: i32) -> Vec<i16> {
    if src_rate == dst_rate {
        return src
            .iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
    }

    const A: i32 = 3;
    let ratio = src_rate as f64 / dst_rate as f64;
    let out_len = (src.len() as f64 / ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    let src_len = src.len() as i64;

    let cutoff_scale = if dst_rate < src_rate {
        dst_rate as f64 / src_rate as f64
    } else {
        1.0
    };

    for i in 0..out_len {
        let center = i as f64 * ratio;
        let k_radius = A as f64 / cutoff_scale;
        let j_start = (center - k_radius).ceil() as i64;
        let j_end = (center + k_radius).floor() as i64;

        let mut acc = 0.0f64;
        let mut wsum = 0.0f64;
        for j in j_start..=j_end {
            if j < 0 || j >= src_len {
                continue;
            }
            let x = (j as f64 - center) * cutoff_scale;
            let w = lanczos(x, A);
            acc += src[j as usize] as f64 * w;
            wsum += w;
        }

        let mut s = if wsum != 0.0 { acc / wsum } else { 0.0 };
        s = s.max(-1.0).min(1.0);
        out.push((s * 32767.0) as i16);
    }
    out
}

fn lanczos(x: f64, a: i32) -> f64 {
    if x == 0.0 {
        return 1.0;
    }
    let fa = a as f64;
    if x <= -fa || x >= fa {
        return 0.0;
    }
    let px = std::f64::consts::PI * x;
    (px.sin() / px) * ((px / fa).sin() / (px / fa))
}

type HmacSha1 = Hmac<Sha1>;

/// Tries AudD then ACRCloud. `Ok(None)` means no match.
pub async fn recognize_wav(
    cfg: &RecognizerConfig,
    wav: &[u8],
) -> anyhow::Result<Option<RecognizeResult>> {
    if cfg.audd_api_key.is_empty() && cfg.acrcloud_host.is_empty() {
        anyhow::bail!(
            "no recognition API configured (set auddApiKey or acrcloud* in config.yaml)"
        );
    }

    let mut last_err: Option<String> = None;

    if !cfg.audd_api_key.is_empty() {
        match recognize_audd(&cfg.audd_api_key, wav).await {
            Ok(Some(mut res)) => {
                res.service = "audd".to_string();
                return Ok(Some(res));
            }
            Ok(None) => {}
            Err(e) => {
                error!(error = %e, "AudD recognition error");
                last_err = Some(format!("AudD: {e}"));
            }
        }
    }

    if !cfg.acrcloud_host.is_empty()
        && !cfg.acrcloud_access_key.is_empty()
        && !cfg.acrcloud_access_secret.is_empty()
    {
        match recognize_acrcloud(
            &cfg.acrcloud_host,
            &cfg.acrcloud_access_key,
            &cfg.acrcloud_access_secret,
            wav,
        )
        .await
        {
            Ok(Some(mut res)) => {
                res.service = "acrcloud".to_string();
                return Ok(Some(res));
            }
            Ok(None) => {}
            Err(e) => {
                error!(error = %e, "ACRCloud recognition error");
                last_err = Some(format!("ACRCloud: {e}"));
            }
        }
    }

    match last_err {
        Some(e) => Err(anyhow::anyhow!(e)),
        None => Ok(None),
    }
}

#[derive(Debug, Deserialize)]
struct AuddResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    result: Option<AuddSong>,
}

#[derive(Debug, Deserialize)]
struct AuddSong {
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    isrc: String,
    #[serde(default, rename = "apple_music")]
    apple_music: Option<AuddApple>,
    #[serde(default)]
    spotify: Option<AuddSpotify>,
}

#[derive(Debug, Deserialize)]
struct AuddApple {
    #[serde(default)]
    url: String,
}

#[derive(Debug, Deserialize)]
struct AuddSpotify {
    #[serde(default)]
    external_urls: AuddExternalUrls,
}

#[derive(Debug, Default, Deserialize)]
struct AuddExternalUrls {
    #[serde(default)]
    spotify: String,
}

async fn recognize_audd(api_key: &str, wav: &[u8]) -> anyhow::Result<Option<RecognizeResult>> {
    let form = reqwest::multipart::Form::new()
        .text("api_token", api_key.to_string())
        .text("return", "apple_music,spotify")
        .part(
            "file",
            reqwest::multipart::Part::bytes(wav.to_vec()).file_name("audio.wav"),
        );

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.audd.io/")
        .multipart(form)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("audd request: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("audd HTTP {}: {}", status.as_u16(), text.trim());
    }

    let ar: AuddResponse = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("audd decode: {e}"))?;
    if ar.status != "success" {
        anyhow::bail!(
            "audd error status: {:?} (result nil: {})",
            ar.status,
            ar.result.is_none()
        );
    }
    let s = match ar.result {
        Some(s) => s,
        None => return Ok(None),
    };

    let mut res = RecognizeResult {
        title: s.title.clone(),
        artist: s.artist.clone(),
        album: s.album,
        label: s.label,
        isrc: s.isrc,
        ..Default::default()
    };
    if let Some(apple) = s.apple_music {
        res.apple_url = apple.url;
    }
    if let Some(spotify) = s.spotify {
        res.spotify = spotify.external_urls.spotify;
    }
    if !res.title.is_empty() {
        res.youtube = format!(
            "https://www.youtube.com/results?search_query={}",
            format!("{} {}", res.artist, res.title).replace(' ', "+")
        );
    }
    info!(title = %res.title, artist = %res.artist, "AudD match");
    Ok(Some(res))
}

#[derive(Debug, Deserialize)]
struct AcrResponse {
    #[serde(default)]
    status: AcrStatus,
    #[serde(default)]
    metadata: Option<AcrMeta>,
}

#[derive(Debug, Default, Deserialize)]
struct AcrStatus {
    #[serde(default)]
    code: i32,
    #[serde(default)]
    msg: String,
}

#[derive(Debug, Deserialize)]
struct AcrMeta {
    #[serde(default)]
    music: Vec<AcrSong>,
}

#[derive(Debug, Deserialize)]
struct AcrSong {
    #[serde(default)]
    title: String,
    #[serde(default)]
    artists: Vec<AcrArtist>,
    #[serde(default)]
    album: AcrAlbum,
    #[serde(default)]
    label: String,
    #[serde(default)]
    score: i32,
    #[serde(default)]
    external_ids: AcrExternalIds,
    #[serde(default)]
    external_metadata: AcrExtMeta,
}

#[derive(Debug, Default, Deserialize)]
struct AcrArtist {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct AcrAlbum {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct AcrExternalIds {
    #[serde(default)]
    isrc: String,
}

#[derive(Debug, Default, Deserialize)]
struct AcrExtMeta {
    #[serde(default)]
    spotify: AcrSpotify,
}

#[derive(Debug, Default, Deserialize)]
struct AcrSpotify {
    #[serde(default)]
    track: AcrTrack,
}

#[derive(Debug, Default, Deserialize)]
struct AcrTrack {
    #[serde(default)]
    id: String,
}

async fn recognize_acrcloud(
    host: &str,
    access_key: &str,
    access_secret: &str,
    wav: &[u8],
) -> anyhow::Result<Option<RecognizeResult>> {
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let sig_str = format!("POST\n/v1/identify\n{access_key}\naudio\n1\n{timestamp}");
    let mut mac = HmacSha1::new_from_slice(access_secret.as_bytes())?;
    mac.update(sig_str.as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

    let form = reqwest::multipart::Form::new()
        .text("access_key", access_key.to_string())
        .text("data_type", "audio")
        .text("signature_version", "1")
        .text("signature", signature)
        .text("sample_bytes", wav.len().to_string())
        .text("timestamp", timestamp)
        .part(
            "sample",
            reqwest::multipart::Part::bytes(wav.to_vec()).file_name("audio.wav"),
        );

    let url = format!("https://{host}/v1/identify");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("acrcloud request: {e}"))?;

    let ar: AcrResponse = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("acrcloud decode: {e}"))?;

    if ar.status.code != 0 {
        anyhow::bail!("acrcloud status {}: {}", ar.status.code, ar.status.msg);
    }
    let music = match ar.metadata {
        Some(m) => m.music,
        None => return Ok(None),
    };
    let s = match music.into_iter().next() {
        Some(s) => s,
        None => return Ok(None),
    };

    let artist = s.artists.first().map(|a| a.name.clone()).unwrap_or_default();
    let mut res = RecognizeResult {
        title: s.title.clone(),
        artist: artist.clone(),
        album: s.album.name,
        label: s.label,
        isrc: s.external_ids.isrc,
        score: s.score,
        ..Default::default()
    };
    if !s.external_metadata.spotify.track.id.is_empty() {
        res.spotify = format!(
            "https://open.spotify.com/track/{}",
            s.external_metadata.spotify.track.id
        );
    }
    if !res.title.is_empty() {
        res.youtube = format!(
            "https://www.youtube.com/results?search_query={}",
            format!("{} {}", artist, res.title).replace(' ', "+")
        );
    }
    info!(title = %res.title, artist = %res.artist, "ACRCloud match");
    Ok(Some(res))
}
