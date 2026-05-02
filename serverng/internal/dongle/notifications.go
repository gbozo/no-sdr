package dongle

import (
	"encoding/json"

	"github.com/gbozo/no-sdr/serverng/internal/config"
	"github.com/gbozo/no-sdr/serverng/internal/ws"
)

// ConfigEvent types sent to clients via META messages.
const (
	// EventDongleAdded is sent when a new dongle is added to the config.
	EventDongleAdded = "dongle_added"
	// EventDongleUpdated is sent when a dongle's configuration changes.
	EventDongleUpdated = "dongle_updated"
	// EventDongleRemoved is sent when a dongle is removed from the config.
	EventDongleRemoved = "dongle_removed"
	// EventDongleStarted is sent when a dongle starts streaming.
	EventDongleStarted = "dongle_started"
	// EventDongleStopped is sent when a dongle stops streaming.
	EventDongleStopped = "dongle_stopped"
	// EventDongleError is sent when a dongle fails (with retry info).
	EventDongleError = "dongle_error"
	// EventProfileAdded is sent when a profile is added to a dongle.
	EventProfileAdded = "profile_added"
	// EventProfileUpdated is sent when a profile is modified.
	EventProfileUpdated = "profile_updated"
	// EventProfileRemoved is sent when a profile is deleted.
	EventProfileRemoved = "profile_removed"
	// EventProfilesReordered is sent when profiles are reordered.
	EventProfilesReordered = "profiles_reordered"
	// EventServerConfigUpdated is sent when server settings change.
	EventServerConfigUpdated = "server_config_updated"
	// EventConfigSaved is sent when config is persisted to YAML.
	EventConfigSaved = "config_saved"
	// EventStateSync is a full state push on connect or major change.
	EventStateSync = "state_sync"
)

// ConfigNotification is a generic config change notification sent as META.
type ConfigNotification struct {
	Type     string `json:"type"`
	DongleID string `json:"dongleId,omitempty"`

	// Config version for optimistic concurrency tracking
	Version uint64 `json:"version,omitempty"`

	// For dongle events: the full dongle state (public view)
	Dongle *DongleInfo `json:"dongle,omitempty"`

	// For profile events
	ProfileID string              `json:"profileId,omitempty"`
	Profile   *config.DongleProfile `json:"profile,omitempty"`
	Profiles  []config.DongleProfile `json:"profiles,omitempty"`

	// For state sync: all dongles + profiles
	Dongles []DongleInfo `json:"dongles,omitempty"`

	// For server config events
	Server *ServerConfigInfo `json:"server,omitempty"`

	// For error events
	Error string `json:"error,omitempty"`

	// Dongle lifecycle state
	State *DongleState `json:"state,omitempty"`
}

// DongleInfo is the public view of a dongle for client notifications.
type DongleInfo struct {
	ID         string               `json:"id"`
	Name       string               `json:"name"`
	Enabled    bool                 `json:"enabled"`
	SourceType string               `json:"sourceType"`
	SampleRate int                  `json:"sampleRate"`
	Profiles   []config.DongleProfile `json:"profiles"`
	State      DongleState          `json:"state"`
	ActiveProfile string            `json:"activeProfile,omitempty"`
}

// ServerConfigInfo is the public view of server config for client notifications.
type ServerConfigInfo struct {
	Callsign    string `json:"callsign"`
	Description string `json:"description"`
	Location    string `json:"location"`
	DemoMode    bool   `json:"demoMode"`
}

// packConfigNotification serializes a ConfigNotification as a binary META message.
func packConfigNotification(n *ConfigNotification) []byte {
	jsonBytes, _ := json.Marshal(n)
	buf := make([]byte, 1+len(jsonBytes))
	buf[0] = ws.MsgMeta
	copy(buf[1:], jsonBytes)
	return buf
}

// NotifyDongleAdded broadcasts that a dongle was added.
func (m *Manager) NotifyDongleAdded(dcfg *config.DongleConfig) {
	info := m.buildDongleInfo(dcfg)
	msg := packConfigNotification(&ConfigNotification{
		Type:     EventDongleAdded,
		DongleID: dcfg.ID,
		Dongle:   &info,
		Version:  m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyDongleUpdated broadcasts that a dongle was modified.
func (m *Manager) NotifyDongleUpdated(dcfg *config.DongleConfig) {
	info := m.buildDongleInfo(dcfg)
	msg := packConfigNotification(&ConfigNotification{
		Type:     EventDongleUpdated,
		DongleID: dcfg.ID,
		Dongle:   &info,
		Version:  m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyDongleRemoved broadcasts that a dongle was removed.
func (m *Manager) NotifyDongleRemoved(dongleID string) {
	msg := packConfigNotification(&ConfigNotification{
		Type:     EventDongleRemoved,
		DongleID: dongleID,
		Version:  m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyDongleStarted broadcasts that a dongle is now streaming.
func (m *Manager) NotifyDongleStarted(dongleID string) {
	state := m.GetDongleState(dongleID)
	msg := packConfigNotification(&ConfigNotification{
		Type:     EventDongleStarted,
		DongleID: dongleID,
		State:    &state,
		Version:  m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyDongleStopped broadcasts that a dongle stopped.
func (m *Manager) NotifyDongleStopped(dongleID string) {
	state := m.GetDongleState(dongleID)
	msg := packConfigNotification(&ConfigNotification{
		Type:     EventDongleStopped,
		DongleID: dongleID,
		State:    &state,
		Version:  m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyDongleError broadcasts that a dongle encountered an error.
func (m *Manager) NotifyDongleError(dongleID string, err error) {
	state := m.GetDongleState(dongleID)
	msg := packConfigNotification(&ConfigNotification{
		Type:     EventDongleError,
		DongleID: dongleID,
		Error:    err.Error(),
		State:    &state,
		Version:  m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyProfileAdded broadcasts that a profile was added to a dongle.
func (m *Manager) NotifyProfileAdded(dongleID string, profile *config.DongleProfile) {
	msg := packConfigNotification(&ConfigNotification{
		Type:      EventProfileAdded,
		DongleID:  dongleID,
		ProfileID: profile.ID,
		Profile:   profile,
		Version:   m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyProfileUpdated broadcasts that a profile was modified.
func (m *Manager) NotifyProfileUpdated(dongleID string, profile *config.DongleProfile) {
	msg := packConfigNotification(&ConfigNotification{
		Type:      EventProfileUpdated,
		DongleID:  dongleID,
		ProfileID: profile.ID,
		Profile:   profile,
		Version:   m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyProfileRemoved broadcasts that a profile was removed.
func (m *Manager) NotifyProfileRemoved(dongleID string, profileID string) {
	msg := packConfigNotification(&ConfigNotification{
		Type:      EventProfileRemoved,
		DongleID:  dongleID,
		ProfileID: profileID,
		Version:   m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyProfilesReordered broadcasts new profile order for a dongle.
func (m *Manager) NotifyProfilesReordered(dongleID string, profiles []config.DongleProfile) {
	msg := packConfigNotification(&ConfigNotification{
		Type:     EventProfilesReordered,
		DongleID: dongleID,
		Profiles: profiles,
		Version:  m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyServerConfigUpdated broadcasts server config changes.
func (m *Manager) NotifyServerConfigUpdated() {
	msg := packConfigNotification(&ConfigNotification{
		Type: EventServerConfigUpdated,
		Server: &ServerConfigInfo{
			Callsign:    m.cfg.Server.Callsign,
			Description: m.cfg.Server.Description,
			Location:    m.cfg.Server.Location,
			DemoMode:    m.cfg.Server.DemoMode,
		},
		Version: m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// NotifyConfigSaved broadcasts that config was persisted to disk.
func (m *Manager) NotifyConfigSaved() {
	msg := packConfigNotification(&ConfigNotification{
		Type:    EventConfigSaved,
		Version: m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// SendStateSync sends the full dongle/profile state to a specific client.
// Used on initial connect or after major config changes.
func (m *Manager) SendStateSync(clientID string) {
	dongles := m.buildAllDongleInfos()
	msg := packConfigNotification(&ConfigNotification{
		Type:    EventStateSync,
		Dongles: dongles,
		Server: &ServerConfigInfo{
			Callsign:    m.cfg.Server.Callsign,
			Description: m.cfg.Server.Description,
			Location:    m.cfg.Server.Location,
			DemoMode:    m.cfg.Server.DemoMode,
		},
		Version: m.currentVersion(),
	})
	m.wsMgr.SendTo(clientID, msg)
}

// BroadcastStateSync sends the full state to all connected clients.
// Used after major config changes (save, bulk edit).
func (m *Manager) BroadcastStateSync() {
	dongles := m.buildAllDongleInfos()
	msg := packConfigNotification(&ConfigNotification{
		Type:    EventStateSync,
		Dongles: dongles,
		Server: &ServerConfigInfo{
			Callsign:    m.cfg.Server.Callsign,
			Description: m.cfg.Server.Description,
			Location:    m.cfg.Server.Location,
			DemoMode:    m.cfg.Server.DemoMode,
		},
		Version: m.currentVersion(),
	})
	m.wsMgr.BroadcastAll(msg)
}

// buildDongleInfo creates a DongleInfo from a DongleConfig.
func (m *Manager) buildDongleInfo(dcfg *config.DongleConfig) DongleInfo {
	state := m.GetDongleState(dcfg.ID)

	activeProfile := ""
	m.mu.Lock()
	if ad, ok := m.dongles[dcfg.ID]; ok {
		if ad.profile != nil {
			activeProfile = ad.profile.ID
		}
	}
	m.mu.Unlock()

	return DongleInfo{
		ID:            dcfg.ID,
		Name:          dcfg.Name,
		Enabled:       dcfg.Enabled,
		SourceType:    dcfg.Source.Type,
		SampleRate:    dcfg.SampleRate,
		Profiles:      dcfg.Profiles,
		State:         state,
		ActiveProfile: activeProfile,
	}
}

// buildAllDongleInfos creates DongleInfo for all configured dongles.
func (m *Manager) buildAllDongleInfos() []DongleInfo {
	infos := make([]DongleInfo, 0, len(m.cfg.Dongles))
	for i := range m.cfg.Dongles {
		infos = append(infos, m.buildDongleInfo(&m.cfg.Dongles[i]))
	}
	return infos
}
