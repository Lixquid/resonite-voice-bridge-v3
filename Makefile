# Build toolchain for the Resonite Voice Bridge systray app.
#
# The frontend is built with Vite and then embedded into the Go binary via
# go:embed (see frontend/embed.go). `make build` runs everything in order.

FRONTEND_DIR := frontend
OUTPUT_DIR   := bin
OUTPUT       := $(OUTPUT_DIR)/resonite-voice-bridge

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
	go build -trimpath -o $(OUTPUT) ./systray

clean:
	rm -rf $(OUTPUT_DIR)
