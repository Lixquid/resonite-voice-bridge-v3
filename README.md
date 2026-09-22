# Resonite Voice Bridge

v3.0.0 · by [Lixquid](https://lixquid.com)

A single-page app that listens to the microphone, transcribes speech **entirely
in the browser** with the [Moonshine](https://github.com/moonshine-ai/moonshine)
WASM model, and streams the text over a WebSocket as it is produced.

## License

This project's own code is licensed under the [MIT License](LICENSE). The
vendored Moonshine WASM binding and the streaming speech models are MIT-licensed
by Useful Sensors, Inc. (dba Moonshine AI) — the full Moonshine repository
license is reproduced in `public/models/LICENSE.moonshine` and summarized in
our [LICENSE](LICENSE).

Everything required to run — the Moonshine WASM binding and all model files —
is served locally. The app works with no connection to the internet (only the
WebSocket relay you point it at needs to be reachable).

## Behavior

For each phrase the model hears, the app sends continually expanding text
frames until the model detects the end of speech, then sends the final
sentence and starts fresh on the next phrase:

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
  model detects the speaker has stopped. A `[speechEnded]` frame is sent after
  it by default; the toggle in the WebSocket section (persisted in
  `localStorage`) turns that off, in which case the pause is only noted in the
  UI log.
- A second toggle (persisted, default off) lowercases sent frames and strips
  all non-alphanumeric characters, keeping spaces as the only whitespace
  (`Hello, how are you?` → `hello how are you`; tabs and newlines are removed,
  space runs collapse to one). It is unicode-aware, so accented letters and
  digits survive, and it never mangles the `[speechEnded]` control frame.
  Partial-frame deduplication compares sanitized values, so `Hello,` followed
  by `Hello` sends once.
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

## Local assets (offline support)

- `public/wasm/dist/` — the Moonshine WASM binding (JS + `moonshine.wasm`),
  copied from the installed `@moonshine-ai/moonshine-wasm` npm package and
  imported at runtime from `/wasm/dist/index.js`. The npm package itself is
  used only for TypeScript declarations at build time. The Moonshine license
  ships alongside it (`public/wasm/dist/LICENSE.moonshine`).
- `public/models/<arch>_streaming/` — the three streaming models (tiny, small,
  medium), each with the canonical files the binding expects
  (`frontend.ort`, `encoder.ort`, `adapter.ort`, `cross_kv.ort`,
  `decoder_kv.ort`, `streaming_config.json`, `tokenizer.bin`). The app loads
  them via `MicTranscriber.modelsFrom()`, which fetches the local URLs into
  memory (cached by the browser Cache API) and feeds the in-memory loader —
  the Moonshine CDN is never contacted.

If the model files are missing, they can be re-fetched once (requires
internet) with:

```sh
node scripts/fetch-models.mjs
```

`scripts/list-model-assets.mjs` prints the file list for each model by asking
the WASM module's manifest helpers.

## Options

- **Model size** — Tiny / Small / Medium streaming models (Small is the
  default). The choice is persisted in `localStorage` and restored on the next
  visit. All three are stored locally in `public/models/`.

## Notes

- The Moonshine binding is imported at runtime rather than bundled: its
  Emscripten layer (`moonshine.mjs` + `moonshine.wasm` + pthread workers) is
  not Vite-friendly.
- No audio ever leaves the browser — only transcribed text is sent to the
  WebSocket.