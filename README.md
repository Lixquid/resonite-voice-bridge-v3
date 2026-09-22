# Moonshine → WebSocket Transcriber

A single-page app that listens to the microphone, transcribes speech **entirely
in the browser** with the [Moonshine](https://github.com/moonshine-ai/moonshine)
WASM model, and streams the text over a WebSocket as it is produced.

## Behavior

For each phrase the model hears, the app sends continually expanding text
frames until the model detects the end of speech, then sends the final
sentence, a `pause` marker, and starts fresh on the next phrase:

```
Hello
Hello how
Hello how are
Hello how are you?   ← final frame (onLine callback)
⏸ pause              ← log-only end-of-speech marker, not sent
Are
Are you
Are you well?
⏸ pause
```

- Partials come from `MicTranscriber.onText` (deduplicated — a frame is only
  sent when the sentence actually grows).
- The final frame comes from `MicTranscriber.onLine`, which fires when the
  model detects the speaker has stopped. The end of speech is noted in the UI
  log only — nothing is sent for it.
- The WebSocket defaults to `ws://localhost:9999` (editable in the UI). Frames
  are queued while the socket is down and flushed once it connects, so
  transcription never stalls on the connection.
- The app connects at startup and retries every 10 seconds until the user
  explicitly presses Disconnect (typing a new URL and pressing Enter also
  re-engages auto-reconnect).

## Running

```sh
npm install
npm run dev         # SPA on http://localhost:8080 (sends COOP/COEP headers)
npm run ws-server   # logging server on ws://localhost:9999 to watch the frames
```

Open http://localhost:8080 — it connects to the relay immediately (retrying
every 10 s until it is up) — then press the mic and talk. Every frame the app
sends appears in the "Sent frames" panel and on the ws-server's stdout.

The threaded WASM build needs `SharedArrayBuffer`, so the dev server sets
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on every response (same approach
as the Moonshine examples' `serve.mjs`).

## Options

- **Model size** — Tiny / Small / Medium streaming models (Small is the
  default). Models are downloaded once from the Moonshine CDN and cached in
  Cache Storage.
- **WebSocket URL** — type a new URL and press Enter (or Connect).
- `?local=1` — load the binding from `/wasm/dist` instead of the jsDelivr CDN
  (for a locally built `@moonshine-ai/moonshine-wasm`).

## Notes

- The Moonshine binding is imported at runtime rather than bundled: its
  Emscripten layer (`moonshine.mjs` + `moonshine.wasm` + pthread workers) is
  not Vite-friendly. The npm package is installed for TypeScript declarations
  only.
- No audio ever leaves the browser — only transcribed text is sent to the
  WebSocket.