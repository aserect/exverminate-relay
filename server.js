// Exverminate relay — room-code matchmaking over WebSocket.
  // Players create or join a room by 5-letter code; every message is relayed
  // to the others in the same room. All game logic lives in the Godot client.

  const http = require('http');
  const { WebSocketServer } = require('ws');
  const PORT = process.env.PORT || 8080;

  const rooms = new Map();          // code -> Map(clientId -> ws)
  let nextId = 1;

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no confusing chars
  function makeCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    } while (rooms.has(code));
    return code;
  }
  
  function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }

  function relay(code, fromId, obj) {
    const room = rooms.get(code);
    if (!room) return;
    for (const [id, ws] of room) if (id !== fromId) send(ws, obj);
  }
  
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Exverminate relay is running.\n');     // Render health check + browser visits
  });

  const wss = new WebSocketServer({ server });
  
  wss.on('connection', (ws) => {
    ws.id = nextId++;
    ws.code = null;
    send(ws, { t: 'welcome', id: ws.id });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }

      if (msg.t === 'create') {
        const code = makeCode();
        ws.code = code;
        rooms.set(code, new Map([[ws.id, ws]]));
        send(ws, { t: 'created', code, id: ws.id, host: true });

      } else if (msg.t === 'join') {
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { t: 'error', reason: 'No room with that code.' }); return; }
        ws.code = code;
        send(ws, { t: 'joined', code, id: ws.id, peers: [...room.keys()] });
        relay(code, ws.id, { t: 'peer_joined', id: ws.id });
        room.set(ws.id, ws);

      } else if (ws.code) {
        msg.from = ws.id;               // game data: stamp sender, relay to the room
        relay(ws.code, ws.id, msg);
      }
    });
  
    ws.on('close', () => {
      if (ws.code && rooms.has(ws.code)) {
        const room = rooms.get(ws.code);
        room.delete(ws.id);
        relay(ws.code, ws.id, { t: 'peer_left', id: ws.id });
        if (room.size === 0) rooms.delete(ws.code);
      }
    });
  });

  server.listen(PORT, () => console.log('Relay listening on ' + PORT));
