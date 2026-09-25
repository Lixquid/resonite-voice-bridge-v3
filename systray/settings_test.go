package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSettingsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")

	// A missing file must yield the defaults.
	if got := loadSettings(path); got.AutoStart {
		t.Errorf("loadSettings on missing file: AutoStart = true, want false")
	}

	// Saving and loading again must reproduce the written value.
	if err := saveSettings(path, settings{AutoStart: true}); err != nil {
		t.Fatalf("saveSettings: %v", err)
	}
	got := loadSettings(path)
	if !got.AutoStart {
		t.Errorf("loadSettings after save: AutoStart = false, want true")
	}

	// A second save with a different value must overwrite, not append.
	if err := saveSettings(path, settings{AutoStart: false}); err != nil {
		t.Fatalf("saveSettings: %v", err)
	}
	if got := loadSettings(path); got.AutoStart {
		t.Errorf("loadSettings after overwrite: AutoStart = true, want false")
	}
}

func TestLoadSettingsBrokenFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	// A corrupted file must fall back to the defaults, not panic or fail.
	if got := loadSettings(path); got.AutoStart {
		t.Errorf("loadSettings on broken file: AutoStart = true, want false")
	}
	// The defaults must also be written back, so what is on disk matches
	// what the UI shows before the user toggles anything.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile after reset: %v", err)
	}
	var got settings
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("reset file is not valid JSON (%v): %q", err, data)
	}
	if got.AutoStart {
		t.Errorf("reset file: AutoStart = true, want false")
	}
}
