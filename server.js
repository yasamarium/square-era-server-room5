// server.js - Square Era Dedicated Multiplayer Room Server
// Room 5: Anarchy Wilds (SURVIVAL)
// Strictly Zero Unicode Emojis

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOM_ID = 5;
const ROOM_NAME = 'Anarchy Wilds';
const ROOM_MODE = 'survival';
const START_TIME = Date.now();

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const WORLD_FILE = path.join(DATA_DIR, 'world.json');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');

// In-Memory Room State
let worldModifications = new Map();
let activePlayers = new Map();
let chatHistory = [];

// Load initial world if available
try {
  if (fs.existsSync(WORLD_FILE)) {
    const wData = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
    if (wData && Array.isArray(wData.modifications)) {
      wData.modifications.forEach(([k, v]) => worldModifications.set(k, v));
      console.log(`[Room ${ROOM_ID}] Loaded ${worldModifications.size} block modifications from storage.`);
    }
  }
} catch (e) {
  console.warn(`[Room ${ROOM_ID}] Could not parse initial world file:`, e.message);
}

function saveSnapshotToDisk() {
  try {
    const payload = {
      room: ROOM_ID,
      name: ROOM_NAME,
      mode: ROOM_MODE,
      seed: 42 + ROOM_ID * 100,
      last_sync: new Date().toISOString(),
      total_modifications: worldModifications.size,
      modifications: Array.from(worldModifications.entries())
    };
    fs.writeFileSync(WORLD_FILE, JSON.stringify(payload, null, 2), 'utf8');

    const playerList = Array.from(activePlayers.values());
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(playerList, null, 2), 'utf8');

    fs.writeFileSync(CHAT_FILE, JSON.stringify(chatHistory.slice(-100), null, 2), 'utf8');
  } catch (e) {
    console.error(`[Room ${ROOM_ID}] Snapshot write error:`, e.message);
  }
}

// Periodic 30s disk snapshot
setInterval(saveSnapshotToDisk, 30000);

// Cleanup inactive players after 40 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of activePlayers.entries()) {
    if (now - p.lastSeen > 40000) {
      activePlayers.delete(id);
      console.log(`[Room ${ROOM_ID}] Player ${p.name || id} timed out.`);
    }
  }
}, 10000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health' || url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'online',
      room: ROOM_ID,
      name: ROOM_NAME,
      mode: ROOM_MODE,
      uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
      active_players: activePlayers.size,
      modifications_count: worldModifications.size
    }));
  }

  if (url.pathname === '/sync' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      room: ROOM_ID,
      name: ROOM_NAME,
      mode: ROOM_MODE,
      players: Array.from(activePlayers.values()),
      modifications: Array.from(worldModifications.entries()),
      chat: chatHistory.slice(-30)
    }));
  }

  if (url.pathname === '/heartbeat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data && data.id) {
          activePlayers.set(data.id, {
            id: data.id,
            name: data.name || 'Player',
            x: data.x || 0,
            y: data.y || 0,
            z: data.z || 0,
            yaw: data.yaw || 0,
            pitch: data.pitch || 0,
            slot: data.slot || 0,
            isFlying: !!data.isFlying,
            isSprinting: !!data.isSprinting,
            lastSeen: Date.now()
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: activePlayers.size }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  if (url.pathname === '/block' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data && data.key && data.block !== undefined) {
          worldModifications.set(data.key, data.block);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, total: worldModifications.size }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  if (url.pathname === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data && data.text) {
          chatHistory.push({
            sender: data.sender || 'Player',
            text: String(data.text).slice(0, 160),
            time: new Date().toISOString()
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[Room ${ROOM_ID}: ${ROOM_NAME}] Dedicated Server running on port ${PORT}`);
});

function gracefulShutdown() {
  console.log(`[Room ${ROOM_ID}] Graceful shutdown requested. Writing final world snapshot...`);
  saveSnapshotToDisk();
  server.close(() => {
    console.log(`[Room ${ROOM_ID}] Server closed cleanly.`);
    process.exit(0);
  });
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
