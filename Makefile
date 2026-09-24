# Build toolchain for the Resonite Voice Bridge systray app.
#
# The frontend is built with Vite and then embedded into the Go binary via
# go:embed (see frontend/embed.go). `make build` runs everything in order.

FRONTEND_DIR := frontend
OUTPUT_DIR   := bin
OUTPUT       := $(OUTPUT_DIR)/resonite-voice-bridge
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

.PHONY: all build frontend frontend-install clean

all: build

# Install the frontend's npm dependencies (skipped if already present).
frontend-install:
	cd $(FRONTEND_DIR) && npm ci --no-audit --no-fund

# Build the frontend into frontend/dist (this is what gets embedded).
frontend: frontend-install
	cd $(FRONTEND_DIR) && npm run build

# Build the full application: frontend first (its output is embedded),
# then the Go binary.
build: frontend
	@echo "==> Embedding version: $(VERSION)"
	go build -trimpath -ldflags "$(GO_LDFLAGS)" -o $(OUTPUT) ./systray

clean:
	rm -rf $(OUTPUT_DIR)
