// Package api provides music recognition via AudD (primary) and ACRCloud (fallback).
package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// RecognizeResult holds the best match returned by a recognition service.
type RecognizeResult struct {
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album,omitempty"`
	Label    string `json:"label,omitempty"`
	ISRC     string `json:"isrc,omitempty"`
	Spotify  string `json:"spotify,omitempty"`  // Spotify track URL
	YouTube  string `json:"youtube,omitempty"`  // YouTube search URL
	AppleURL string `json:"apple,omitempty"`
	Score    int    `json:"score,omitempty"` // confidence 0-100 (ACRCloud) or absent
	Service  string `json:"service"`         // "audd" | "acrcloud"
}

// RecognizerConfig holds API credentials for both services.
type RecognizerConfig struct {
	AuddAPIKey           string
	ACRCloudHost         string // e.g. "identify-eu-west-1.acrcloud.com"
	ACRCloudAccessKey    string
	ACRCloudAccessSecret string
}

// Recognize identifies a music track from decoded PCM audio.
// pcm is mono or stereo Float32 at 48kHz.
// channels is 1 (mono) or 2 (stereo).
// It tries AudD first, then ACRCloud as fallback.
// Returns an error only if both services fail; a nil result with nil error means no match.
func Recognize(cfg RecognizerConfig, pcm []float32, channels int) (*RecognizeResult, error) {
	wav := encodeWAV(pcm, channels, 48000)

	// Primary: AudD
	if cfg.AuddAPIKey != "" {
		res, err := recognizeAudD(cfg.AuddAPIKey, wav)
		if err == nil && res != nil {
			res.Service = "audd"
			return res, nil
		}
	}

	// Fallback: ACRCloud
	if cfg.ACRCloudHost != "" && cfg.ACRCloudAccessKey != "" && cfg.ACRCloudAccessSecret != "" {
		res, err := recognizeACRCloud(cfg.ACRCloudHost, cfg.ACRCloudAccessKey, cfg.ACRCloudAccessSecret, wav)
		if err == nil && res != nil {
			res.Service = "acrcloud"
			return res, nil
		}
	}

	// Both failed or returned no match
	if cfg.AuddAPIKey == "" && cfg.ACRCloudHost == "" {
		return nil, fmt.Errorf("no recognition API configured (set auddApiKey or acrcloud* in config.yaml)")
	}
	return nil, nil // no match found
}

// ---- WAV encoder (Float32 → Int16 mono WAV) ----

func encodeWAV(pcm []float32, channels, sampleRate int) []byte {
	// Downsample to mono if stereo (average L+R)
	mono := pcm
	if channels == 2 {
		mono = make([]float32, len(pcm)/2)
		for i := range mono {
			mono[i] = (pcm[i*2] + pcm[i*2+1]) * 0.5
		}
	}

	// Resample 48kHz → 22050Hz (recognition APIs work fine at 22kHz, ~halves file size)
	const targetRate = 22050
	ratio := float64(sampleRate) / float64(targetRate)
	outLen := int(float64(len(mono)) / ratio)
	resampled := make([]int16, outLen)
	for i := range resampled {
		srcIdx := float64(i) * ratio
		lo := int(srcIdx)
		hi := lo + 1
		if hi >= len(mono) {
			hi = len(mono) - 1
		}
		frac := float32(srcIdx - float64(lo))
		s := mono[lo]*(1-frac) + mono[hi]*frac
		// Clamp and scale to Int16
		s = float32(math.Max(-1.0, math.Min(1.0, float64(s))))
		resampled[i] = int16(s * 32767.0)
	}

	// Build WAV: RIFF header + PCM data
	dataSize := len(resampled) * 2
	buf := new(bytes.Buffer)
	writeWAVHeader(buf, 1, targetRate, dataSize)
	for _, s := range resampled {
		binary.Write(buf, binary.LittleEndian, s)
	}
	return buf.Bytes()
}

func writeWAVHeader(w io.Writer, channels, sampleRate, dataSize int) {
	byteRate := sampleRate * channels * 2
	blockAlign := channels * 2

	write := func(v any) { binary.Write(w, binary.LittleEndian, v) }
	w.Write([]byte("RIFF"))
	write(uint32(36 + dataSize))
	w.Write([]byte("WAVEfmt "))
	write(uint32(16))       // chunk size
	write(uint16(1))        // PCM
	write(uint16(channels)) // channels
	write(uint32(sampleRate))
	write(uint32(byteRate))
	write(uint16(blockAlign))
	write(uint16(16)) // bits per sample
	w.Write([]byte("data"))
	write(uint32(dataSize))
}

// ---- AudD ----

type auddResponse struct {
	Status string    `json:"status"`
	Result *auddSong `json:"result"`
}

type auddSong struct {
	Title  string          `json:"title"`
	Artist string          `json:"artist"`
	Album  string          `json:"album"`
	Label  string          `json:"label"`
	ISRC   string          `json:"isrc"`
	Apple  *auddApple      `json:"apple_music"`
	Spotify *auddSpotify   `json:"spotify"`
}

type auddApple  struct { URL string `json:"url"` }
type auddSpotify struct { ExternalURLs struct { Spotify string `json:"spotify"` } `json:"external_urls"` }

func recognizeAudD(apiKey string, wav []byte) (*RecognizeResult, error) {
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	w.WriteField("api_token", apiKey)
	w.WriteField("return", "apple_music,spotify")

	part, err := w.CreateFormFile("file", "audio.wav")
	if err != nil {
		return nil, err
	}
	part.Write(wav)
	w.Close()

	resp, err := http.Post("https://api.audd.io/", w.FormDataContentType(), body)
	if err != nil {
		return nil, fmt.Errorf("audd request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("audd HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var ar auddResponse
	if err := json.NewDecoder(resp.Body).Decode(&ar); err != nil {
		return nil, fmt.Errorf("audd decode: %w", err)
	}
	if ar.Status != "success" {
		return nil, fmt.Errorf("audd error status: %q (result nil: %v)", ar.Status, ar.Result == nil)
	}
	if ar.Result == nil {
		return nil, nil // success but no match
	}
	s := ar.Result
	res := &RecognizeResult{
		Title:  s.Title,
		Artist: s.Artist,
		Album:  s.Album,
		Label:  s.Label,
		ISRC:   s.ISRC,
	}
	if s.Apple != nil {
		res.AppleURL = s.Apple.URL
	}
	if s.Spotify != nil {
		res.Spotify = s.Spotify.ExternalURLs.Spotify
	}
	if res.Title != "" {
		res.YouTube = "https://www.youtube.com/results?search_query=" +
			strings.ReplaceAll(res.Artist+" "+res.Title, " ", "+")
	}
	return res, nil
}

// ---- ACRCloud ----

type acrResponse struct {
	Status  acrStatus   `json:"status"`
	Metadata *acrMeta   `json:"metadata"`
}

type acrStatus struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
}

type acrMeta struct {
	Music []acrSong `json:"music"`
}

type acrSong struct {
	Title       string            `json:"title"`
	Artists     []acrArtist       `json:"artists"`
	Album       acrAlbum          `json:"album"`
	Label       string            `json:"label"`
	Score       int               `json:"score"`
	ExternalIDs acrExternalIDs    `json:"external_ids"`
	ExternalMetadata acrExtMeta   `json:"external_metadata"`
}

type acrArtist struct { Name string `json:"name"` }
type acrAlbum  struct { Name string `json:"name"` }
type acrExternalIDs struct { ISRC string `json:"isrc"` }
type acrExtMeta struct {
	Spotify struct { Track struct { ID string `json:"id"` } `json:"track"` } `json:"spotify"`
}

func recognizeACRCloud(host, accessKey, accessSecret string, wav []byte) (*RecognizeResult, error) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	// HMAC-SHA1 signature
	sigStr := fmt.Sprintf("POST\n/v1/identify\n%s\naudio\n1\n%s", accessKey, timestamp)
	mac := hmac.New(sha1.New, []byte(accessSecret))
	mac.Write([]byte(sigStr))
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	w.WriteField("access_key", accessKey)
	w.WriteField("data_type", "audio")
	w.WriteField("signature_version", "1")
	w.WriteField("signature", sig)
	w.WriteField("sample_bytes", strconv.Itoa(len(wav)))
	w.WriteField("timestamp", timestamp)

	part, err := w.CreateFormFile("sample", "audio.wav")
	if err != nil {
		return nil, err
	}
	part.Write(wav)
	w.Close()

	url := fmt.Sprintf("https://%s/v1/identify", host)
	resp, err := http.Post(url, w.FormDataContentType(), body)
	if err != nil {
		return nil, fmt.Errorf("acrcloud request: %w", err)
	}
	defer resp.Body.Close()

	var ar acrResponse
	if err := json.NewDecoder(resp.Body).Decode(&ar); err != nil {
		return nil, fmt.Errorf("acrcloud decode: %w", err)
	}
	if ar.Status.Code != 0 {
		return nil, fmt.Errorf("acrcloud status %d: %s", ar.Status.Code, ar.Status.Msg)
	}
	if ar.Metadata == nil || len(ar.Metadata.Music) == 0 {
		return nil, nil // success but no match
	}
	s := ar.Metadata.Music[0]
	artist := ""
	if len(s.Artists) > 0 {
		artist = s.Artists[0].Name
	}
	res := &RecognizeResult{
		Title:  s.Title,
		Artist: artist,
		Album:  s.Album.Name,
		Label:  s.Label,
		ISRC:   s.ExternalIDs.ISRC,
		Score:  s.Score,
	}
	if id := s.ExternalMetadata.Spotify.Track.ID; id != "" {
		res.Spotify = "https://open.spotify.com/track/" + id
	}
	if res.Title != "" {
		res.YouTube = "https://www.youtube.com/results?search_query=" +
			strings.ReplaceAll(artist+" "+res.Title, " ", "+")
	}
	return res, nil
}
