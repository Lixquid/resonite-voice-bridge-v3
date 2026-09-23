// Minimal logging WebSocket server for trying out the transcriber app.
//
//   npm run ws-server
//   # listens on ws://localhost:9999 (override with PORT)
//
// Prints every text frame it receives, in order, exactly as the app sends it:
// expanding partials, the final sentence, then the `pause` marker.

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 9999);
const wss = new WebSocketServer({ port: PORT });

wss.on('listening', () => {
  console.log(`WebSocket server listening on ws://localhost:${PORT}`);
  console.log('Waiting for transcription frames…\n');
});

wss.on('connection', (socket, req) => {
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`— client connected (${peer})`);

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      console.log(`[binary frame, ${data.length} bytes]`);
      return;
    }
    const text = data.toString();
    if (text === 'pause') {
      console.log(`${new Date().toISOString()}  ⏸ pause`);
    } else {
      console.log(`${new Date().toISOString()}  ${text}`);
    }
  });

  socket.on('close', () => console.log(`— client disconnected (${peer})`));
  socket.on('error', (err) => console.error(`— client error: ${err.message}`));
});