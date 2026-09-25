package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
)

// settings holds the user preferences that must survive application
// restarts. They are stored as JSON in the per-user configuration
// directory (see settingsPath), so no elevated rights are needed.
type settings struct {
	// AutoStart is true when the web interface should be opened in the
	// browser automatically every time the application starts.
	AutoStart bool `json:"autoStartWebInterface"`
}

// settingsPath returns the location of the settings file:
// <UserConfigDir>/resonite-voice-bridge/settings.json (e.g.
// ~/.config/resonite-voice-bridge/settings.json on Linux,
// %APPDATA%\resonite-voice-bridge\settings.json on Windows).
func settingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "resonite-voice-bridge", "settings.json"), nil
}

// loadSettings reads the settings file, falling back to the zero settings
// (everything off) when the file does not exist or cannot be parsed. A
// broken file is never fatal: the user simply gets the defaults, and the
// file is immediately rewritten with them, so the on-disk state always
// matches what the menu shows before the user toggles anything.
func loadSettings(path string) settings {
	var s settings
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	if err := json.Unmarshal(data, &s); err != nil {
		log.Printf("Ignoring unreadable settings file %s: %v", path, err)
		s = settings{}
		if err := saveSettings(path, s); err != nil {
			log.Printf("Resetting settings file %s: %v", path, err)
		}
	}
	return s
}

// saveSettings writes the settings atomically: it first creates the
// destination directory (it may not exist yet on first use) and then writes
// to a temporary file in the same directory before renaming it into place,
// so an interrupted write cannot leave a truncated file behind.
func saveSettings(path string, s settings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
