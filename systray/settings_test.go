package main

import (
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
}
