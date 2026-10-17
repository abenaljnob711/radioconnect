
"use strict";

/* ==========================================
   Radio Connect Server - v4.4
   Wave approval + authorized LiveKit access
   ========================================== */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

let AccessToken = null;
try {
  AccessToken = require("livekit-server-sdk").AccessToken;
} catch (e) {
  console.error("LiveKit SDK load error:", e.message);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8
});

const PORT = process.env.PORT || 3000;
const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const DATA_FILE = path.join(__dirname, "rooms.json");

const deviceSockets = Object.create(null);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

let db = {
  devices: {},
  waves: {},
  waveRequests: {},
  conversations: {},
  messages: {}
};

function now() {
  return Date.now();
}

function generateRadCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "Q";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateWaveId() {
  return generateRadCode();
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "G";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateConversationId(devA, devB) {
  return "conv_" + crypto.createHash("md5")
    .update([devA, devB].sort().join("_"))
    .digest("hex").substring(0, 16);
}

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      db.devices = parsed.devices || {};
      db.waves = parsed.waves || {};
      db.waveRequests = parsed.waveRequests || {};
      db.conversations = parsed.conversations || {};
      db.messages = parsed.messages || {};
    }
  } catch (e) {
    console.error("خطأ في تحميل قاعدة البيانات:", e.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("خطأ في حفظ قاعدة البيانات:", e.message);
  }
}

function getWave(waveId) {
  return waveId ? db.waves[waveId] : null;
}

function isWaveOwner(wave, deviceId) {
  return !!(wave && deviceId && wave.ownerDevice === deviceId);
}

function isWaveMember(wave, deviceId) {
  return !!(wave && deviceId && wave.members && wave.members[deviceId]);
}

function canAccessWave(wave, deviceId) {
  return isWaveOwner(wave, deviceId) || isWaveMember(wave, deviceId);
}

function publicMembers(wave) {
  return Object.values(wave.members || {}).map(m => ({
    id: m.id,
    name: m.name,
    isOwner: !!m.isOwner,
    online: !!(wave.onlineNow && wave.onlineNow[m.id])
  }));
}

function emitMembers(waveId) {
  const wave = getWave(waveId);
  if (!wave) return;
  io.to("wave_" + waveId).emit("wave_members_updated", {
    members: publicMembers(wave)
  });
}

loadDb();

/* ==========================================
   Routes
   ========================================== */

app.get("/", (req, res) => {
  const file = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  res.json({ status: "ok", name: "Radio Connect Server", version: "4.4" });
});

app.get("/status", (req, res) => {
  res.json({
    status: "ok",
    name: "Radio Connect Server",
    version: "4.4",
    livekit: LIVEKIT_URL ? "configured" : "not configured",
    uptime: process.uptime(),
    waves: Object.keys(db.waves).length,
    devices: Object.keys(db.devices).length
  });
});
