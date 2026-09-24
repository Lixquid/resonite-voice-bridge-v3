# Build toolchain for the Resonite Voice Bridge systray app.
#
# The frontend is built with Vite and then embedded into the Go binary via
# go:embed (see frontend/embed.go). `make build` runs everything in order.

FRONTEND_DIR := frontend
OUTPUT_DIR   := bin
OUTPUT       := $(OUTPUT_DIR)/resonite-voice-bridge
SYSTRAY_DIR  := systray

# Windows resources (application icon) are compiled into the executable via
# rsrc-generated COFF object files. Files named *_windows_<arch>.syso in the
# package directory are picked up automatically by `go build` on matching
# GOOS/GOARCH, and ignored otherwise, so non-Windows builds are unaffected.
RSRC := rsrc
SYSO_ARCHES := amd64 386 arm64
SYSO_FILES := $(addprefix $(SYSTRAY_DIR)/rsrc_windows_,$(addsuffix .syso,$(SYSO_ARCHES)))
# Compute the embedded application version: the tag naming HEAD when present
# (e.g. "v1.2.3"), otherwise the short commit ID; "-dirty" is appended when
# there are uncommitted changes. Injected with -ldflags -X (see
# systray/version.go). Falls back to Go's VCS stamping when git is absent.
VERSION := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
ifneq ($(shell git tag --points-at HEAD 2>/dev/null | grep -E '^v' | head -1),)
VERSION := $(shell git tag --points-at HEAD 2>/dev/null | grep -E '^v' | head -1)
endif
ifneq ($(shell git status --porcelain 2>/dev/null),)
VERSION := $(VERSION)-dirty
endif
GO_LDFLAGS := -s -w -X main.version=$(VERSION)

# On Windows, link as a GUI application (-H=windowsgui) so that launching the
# binary does not open a console window: the app lives in the system tray and
# has no use for a visible terminal.
#
# Check the *target* OS (GOOS), not the host: `GOOS=windows make` on Linux
# produces a Windows binary that needs windowsgui too. `OS=Windows_NT` is only
# set natively on Windows, so use it as a fallback when GOOS isn't overridden.
GOOS_TARGET := $(shell go env GOOS 2>/dev/null)
ifneq ($(GOOS),)
GOOS_TARGET := $(GOOS)
endif
ifeq ($(GOOS_TARGET),windows)
GO_LDFLAGS += -H=windowsgui
OUTPUT := $(OUTPUT).exe
endif
.PHONY: all build frontend frontend-install resources vet test clean

all: build

vet:
	go vet ./...

test:
	go test ./...

# Install the frontend's npm dependencies (skipped if already present).
frontend-install:
	cd $(FRONTEND_DIR) && npm ci --no-audit --no-fund

# Build the frontend into frontend/dist (this is what gets embedded).
frontend: frontend-install
	cd $(FRONTEND_DIR) && npm run build

# Compile systray/icon.ico into Windows resource objects (one per GOARCH) so
# the built .exe carries the application icon in Explorer, the taskbar, and
# shortcuts. Requires the rsrc tool: `go install github.com/akavel/rsrc@latest`.
resources: $(SYSO_FILES)

$(SYSTRAY_DIR)/rsrc_windows_%.syso: $(SYSTRAY_DIR)/icon.ico | $(RSRC)
	$(RSRC) -arch $* -ico $< -o $@

$(RSRC):
	go install github.com/akavel/rsrc@latest

# Build the full application: frontend first (its output is embedded),
# then the Go binary. The Windows resources are only needed for .exe builds.
build: frontend $(if $(findstring windows,$(GOOS_TARGET)),resources)
	@echo "==> Embedding version: $(VERSION)"
	go build -trimpath -ldflags "$(GO_LDFLAGS)" -o $(OUTPUT) ./systray

clean:
	rm -rf $(OUTPUT_DIR) $(SYSO_FILES)
