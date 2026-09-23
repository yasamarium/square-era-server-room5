// server.js - Square Era Dedicated Multiplayer Room Server
// Room 5: Anarchy Wilds (SURVIVAL)
// Live MQTT Activity Bridge & Automatic Database Persistence
// Strictly Zero Unicode Emojis

const http = require('http');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const PORT = process.env.PORT || 8080;
const ROOM_ID = 5;
const ROOM_NAME = 'Anarchy Wilds';
const ROOM_MODE = 'survival';
const START_TIME = Date.now();
const TOPIC = `square-era-v2/room-${ROOM_ID}`;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const WORLD_FILE = path.join(DATA_DIR, 'world.json');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');

// In-Memory Room State
let worldModifications = new Map();
let activePlayers = new Map();
let chatHistory = [];
let pendingDiskSave = false;

// Load initial world if available
try {
  if (fs.existsSync(WORLD_FILE)) {
    const wData = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
    if (wData && Array.isArray(wData.modifications)) {
      wData.modifications.forEach(([k, v]) => worldModifications.set(k, v));
      console.log(`[Room ${ROOM_ID}] Restored ${worldModifications.size} block modifications from storage.`);
    }
  }
} catch (e) {
  console.warn(`[Room ${ROOM_ID}] Initial world load notice:`, e.message);
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
    pendingDiskSave = false;
  } catch (e) {
    console.error(`[Room ${ROOM_ID}] Snapshot write error:`, e.message);
  }
}

// Periodic 15s disk flush if modifications were made
setInterval(() => {
  if (pendingDiskSave) saveSnapshotToDisk();
}, 15000);

// Cleanup inactive players after 45 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of activePlayers.entries()) {
    if (now - p.lastSeen > 45000) {
      activePlayers.delete(id);
    }
  }
}, 10000);

// =========================================================================
// Live MQTT Bridge - Captures all player activities directly
// =========================================================================
const BROKERS = ['mqtt://broker.emqx.io:1883', 'mqtt://broker.hivemq.com:1883'];
let currentBrokerIdx = 0;
let mqttClient = null;

function connectMqtt() {
  const brokerUrl = BROKERS[currentBrokerIdx];
  const clientId = `square_server_room_${ROOM_ID}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[Room ${ROOM_ID}] Connecting to MQTT broker: ${brokerUrl}...`);

  mqttClient = mqtt.connect(brokerUrl, {
    clientId: clientId,
    clean: true,
    connectTimeout: 8000,
    keepalive: 30
  });

  mqttClient.on('connect', () => {
    console.log(`[Room ${ROOM_ID}] Connected to MQTT broker! Subscribing to ${TOPIC}...`);
    mqttClient.subscribe(TOPIC, err => {
      if (!err) {
        console.log(`[Room ${ROOM_ID}] Successfully subscribed to room topic ${TOPIC}!`);
      }
    });
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const packet = JSON.parse(message.toString());
      if (!packet || packet.roomId !== ROOM_ID) return;

      // 1. Block change activity
      if (packet.type === 'block_change') {
        const key = packet.key || `${packet.x},${packet.y},${packet.z}`;
        if (key && packet.block !== undefined) {
          worldModifications.set(key, packet.block);
          pendingDiskSave = true;
          console.log(`[Room ${ROOM_ID}] Recorded block change ${key} -> ${packet.block} (Total: ${worldModifications.size})`);
        }
      }

      // 2. Explosion activity
      else if (packet.type === 'explosion') {
        const ex = Math.round(packet.ex);
        const ey = Math.round(packet.ey);
        const ez = Math.round(packet.ez);
        const radius = Math.min(8, Math.round(packet.radius || 3.5));
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
              if (dx * dx + dy * dy + dz * dz <= radius * radius) {
                worldModifications.set(`${ex + dx},${ey + dy},${ez + dz}`, 0);
              }
            }
          }
        }
        pendingDiskSave = true;
        console.log(`[Room ${ROOM_ID}] Recorded explosion at [${ex}, ${ey}, ${ez}] radius ${radius}. Total: ${worldModifications.size}`);
      }

      // 3. Player state / join activity
      else if (packet.type === 'player_state' || packet.type === 'player_join') {
        const id = packet.id || packet.senderId;
        if (id) {
          activePlayers.set(id, {
            id: id,
            name: packet.name || 'Player',
            x: packet.x || 0,
            y: packet.y || 0,
            z: packet.z || 0,
            lastSeen: Date.now()
          });
        }
      }

      // 4. In-room chat activity
      else if (packet.type === 'chat') {
        if (packet.text) {
          chatHistory.push({
            sender: packet.sender || 'Player',
            text: String(packet.text).slice(0, 160),
            time: new Date().toISOString()
          });
          pendingDiskSave = true;
        }
      }

      // 5. Live room synchronization request from newly connected player
      else if (packet.type === 'request_room_sync') {
        if (worldModifications.size > 0) {
          const responsePacket = {
            type: 'room_sync_response',
            roomId: ROOM_ID,
            senderId: 'server_daemon',
            modifications: Array.from(worldModifications.entries()),
            chat: chatHistory.slice(-20)
          };
          mqttClient.publish(TOPIC, JSON.stringify(responsePacket));
          console.log(`[Room ${ROOM_ID}] Dispatched live room sync with ${worldModifications.size} modifications to peer.`);
        }
      }
    } catch (e) {
      // Ignore packet parse errors
    }
  });

  mqttClient.on('error', err => {
    console.warn(`[Room ${ROOM_ID}] MQTT error:`, err.message);
  });

  mqttClient.on('close', () => {
    console.log(`[Room ${ROOM_ID}] MQTT connection closed, reconnecting in 5s...`);
  });
}

connectMqtt();

// =========================================================================
// Lightweight HTTP Health & Sync Endpoint
// =========================================================================
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

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[Room ${ROOM_ID}: ${ROOM_NAME}] Dedicated Server daemon listening on port ${PORT}`);
});

function gracefulShutdown() {
  console.log(`[Room ${ROOM_ID}] Graceful shutdown requested. Writing final world snapshot before restart...`);
  saveSnapshotToDisk();
  if (mqttClient) {
    try { mqttClient.end(true); } catch (e) {}
  }
  server.close(() => {
    console.log(`[Room ${ROOM_ID}] Server closed cleanly. Data prepared for database commit.`);
    process.exit(0);
  });
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
