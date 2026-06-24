// Exverminate relay — room-code matchmaking + PUBLIC room list, over WebSocket.
// Players create or join a room by 5-letter code; every game message is relayed to the
// others in the same room. Public rooms also show up in the in-game browser.
// All game logic lives in the Godot client.

const http = require('http');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'pudlo2024';   // secret for dev broadcasts (change it / set in Render env)

const rooms = new Map();          // code -> Map(clientId -> ws)
const meta  = new Map();          // code -> { public: bool, name: string }   (room info for the list)
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

// the list of public rooms the in-game browser shows
function publicList() {
  const list = [];
  for (const [code, m] of meta) {
    if (!m.public) continue;
    const room = rooms.get(code);
    list.push({ code, name: m.name || 'Game', players: room ? room.size : 0 });
  }
  return list;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Exverminate relay is running.\n');     // Render health check + browser visits
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.id = nextId++;
  ws.code = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });   // client answered our heartbeat → still connected
  send(ws, { t: 'welcome', id: ws.id });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    if (msg.t === 'create') {
      const code = makeCode();
      ws.code = code;
      rooms.set(code, new Map([[ws.id, ws]]));
      meta.set(code, { public: !!msg.public, name: (msg.name || '').toString().slice(0, 32), host: ws.id });
      send(ws, { t: 'created', code, id: ws.id, host: true });

    } else if (msg.t === 'join') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: 'error', reason: 'No room with that code.' }); return; }
      ws.code = code;
      send(ws, { t: 'joined', code, id: ws.id, peers: [...room.keys()] });
      relay(code, ws.id, { t: 'peer_joined', id: ws.id });
      room.set(ws.id, ws);

    } else if (msg.t === 'list') {
      // the in-game "Find a Public Game" browser asks for this
      send(ws, { t: 'list_result', rooms: publicList() });

    } else if (msg.t === 'quickjoin') {
      // jump into the busiest public room, or open a fresh public one if none exist
      const pub = publicList().filter(r => r.players > 0).sort((a, b) => b.players - a.players);
      if (pub.length > 0) {
        const code = pub[0].code;
        const room = rooms.get(code);
        ws.code = code;
        send(ws, { t: 'joined', code, id: ws.id, peers: [...room.keys()] });
        relay(code, ws.id, { t: 'peer_joined', id: ws.id });
        room.set(ws.id, ws);
      } else {
        const code = makeCode();
        ws.code = code;
        rooms.set(code, new Map([[ws.id, ws]]));
        meta.set(code, { public: true, name: 'Quick Game', host: ws.id });
        send(ws, { t: 'created', code, id: ws.id, host: true });
      }

    } else if (msg.t === 'setpublic' && ws.code) {
      // host toggled their room public/private (and set a name) from the client
      const m = meta.get(ws.code);
      if (m) {
        m.public = !!msg.public;
        if (typeof msg.name === 'string') m.name = msg.name.slice(0, 32);
      }

    } else if (msg.t === 'announce') {
      // DEV BROADCAST: only with the secret key — push a banner to EVERY connected player
      if (msg.key === ADMIN_KEY) {
        const payload = {
          t: 'announce',
          name: (msg.name || 'pudlo').toString().slice(0, 24),
          text: (msg.text || '').toString().slice(0, 200),
        };
        for (const c of wss.clients) send(c, payload);
      }

    } else if (ws.code) {
      msg.from = ws.id;               // game data: stamp sender, relay to the room
      relay(ws.code, ws.id, msg);
    }
  });

  ws.on('close', () => {
    if (ws.code && rooms.has(ws.code)) {
      const room = rooms.get(ws.code);
      const m = meta.get(ws.code);
      room.delete(ws.id);
      if (m && m.host === ws.id) {
        // the HOST left → kick everyone else and close the room
        for (const [, c] of room) send(c, { t: 'host_left' });
        room.clear();
        rooms.delete(ws.code);
        meta.delete(ws.code);
      } else {
        relay(ws.code, ws.id, { t: 'peer_left', id: ws.id });
        if (room.size === 0) { rooms.delete(ws.code); meta.delete(ws.code); }   // also forget its public listing
      }
    }
  });
});

// keep-alive heartbeat: ping every 30s and drop only the connections that stop answering.
// This stops idle WebSocket connections from being silently cut (a cause of random
// "disconnected from your room"). Godot clients auto-reply to pings, so they stay alive.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log('Relay listening on ' + PORT));
