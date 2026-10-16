
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
/* ==========================================
   Users
   ========================================== */

app.post("/api/users/register", (req, res) => {
  try {
    const { deviceId, userName } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "deviceId مطلوب" });

    if (!db.devices[deviceId]) {
      db.devices[deviceId] = {
        id: deviceId,
        name: userName || "مستخدم",
        radCode: generateRadCode(),
        waveId: null,
        conversations: [],
        createdAt: now()
      };
      saveDb();
    } else {
      if (userName) db.devices[deviceId].name = userName;
      if (!db.devices[deviceId].radCode ||
          db.devices[deviceId].radCode.startsWith("RAD-")) {
        db.devices[deviceId].radCode = generateRadCode();
      }
      saveDb();
    }

    res.json({
      success: true,
      deviceId,
      radCode: db.devices[deviceId].radCode,
      userName: db.devices[deviceId].name,
      waveId: db.devices[deviceId].waveId
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/users/search/:radCode", (req, res) => {
  const code = req.params.radCode.toUpperCase();
  const user = Object.values(db.devices).find(u => u.radCode === code);
  if (!user) return res.status(404).json({ error: "لا يوجد مستخدم بهذا الرقم" });

  res.json({
    deviceId: user.id,
    userName: user.name,
    radCode: user.radCode,
    waveId: user.waveId
  });
});

/* ==========================================
   Conversations
   ========================================== */

app.post("/api/conversations/start", (req, res) => {
  try {
    const { myDeviceId, otherDeviceId } = req.body || {};

    if (!myDeviceId || !otherDeviceId) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }
    if (!db.devices[myDeviceId] || !db.devices[otherDeviceId]) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const convId = generateConversationId(myDeviceId, otherDeviceId);

    if (!db.conversations[convId]) {
      db.conversations[convId] = {
        id: convId,
        participants: [myDeviceId, otherDeviceId],
        createdAt: now(),
        lastMessageAt: now()
      };
      db.messages[convId] = [];

      for (const id of [myDeviceId, otherDeviceId]) {
        db.devices[id].conversations ||= [];
        if (!db.devices[id].conversations.includes(convId)) {
          db.devices[id].conversations.push(convId);
        }
      }
      saveDb();
    }

    res.json({
      success: true,
      conversationId: convId,
      otherUser: {
        deviceId: otherDeviceId,
        userName: db.devices[otherDeviceId].name,
        radCode: db.devices[otherDeviceId].radCode
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/conversations/list/:deviceId", (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const user = db.devices[deviceId];
    if (!user) return res.json({ conversations: [] });

    const list = (user.conversations || []).map(convId => {
      const conv = db.conversations[convId];
      if (!conv) return null;

      const otherId = conv.participants.find(id => id !== deviceId);
      const other = db.devices[otherId];
      const messages = db.messages[convId] || [];
      const last = messages[messages.length - 1];

      return {
        conversationId: convId,
        otherUser: {
          deviceId: otherId,
          userName: other ? other.name : "مستخدم",
          radCode: other ? other.radCode : "—"
        },
        lastMessage: last ? {
          text: last.type === "voice" ? "🎤 رسالة صوتية" :
                last.type === "image" ? "🖼️ صورة" :
                last.type === "video" ? "🎬 فيديو" : (last.text || ""),
          time: last.time,
          sender: last.sender
        } : null,
        lastMessageAt: conv.lastMessageAt || conv.createdAt
      };
    }).filter(Boolean);

    list.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    res.json({ conversations: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/conversations/:convId/messages", (req, res) => {
  res.json({ messages: db.messages[req.params.convId] || [] });
});

/* ==========================================
   Waves
   ========================================== */

app.post("/api/waves/create", (req, res) => {
  try {
    const { deviceId, waveName } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "deviceId مطلوب" });

    const user = db.devices[deviceId];
    if (user && user.waveId && db.waves[user.waveId]) {
      const old = db.waves[user.waveId];
      if (old.ownerDevice === deviceId) {
        return res.json({
          success: true,
          waveId: old.id,
          waveName: old.name,
          isNew: false
        });
      }
    }

    let waveId;
    do {
      waveId = generateWaveId();
    } while (db.waves[waveId]);

    if (!db.devices[deviceId]) {
      db.devices[deviceId] = {
        id: deviceId,
        name: "مستخدم",
        radCode: generateRadCode(),
        waveId: null,
        conversations: [],
        createdAt: now()
      };
    }

    const wave = {
      id: waveId,
      name: waveName || "فرقتي",
      ownerDevice: deviceId,
      createdAt: now(),
      members: {},
      onlineNow: {}
    };

    wave.members[deviceId] = {
      id: deviceId,
      name: db.devices[deviceId].name || "المالك",
      isOwner: true,
      addedAt: now()
    };

    db.waves[waveId] = wave;
    db.devices[deviceId].waveId = waveId;
    saveDb();

    res.json({
      success: true,
      waveId,
      waveName: wave.name,
      isNew: true
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/waves/:waveId", (req, res) => {
  const wave = getWave(req.params.waveId);
  if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });

  const members = publicMembers(wave);
  res.json({
    waveId: wave.id,
    waveName: wave.name,
    listenersCount: members.filter(m => m.online).length,
    totalMembers: members.length,
    members,
    ownerDevice: wave.ownerDevice
  });
});

app.get("/api/waves/list/:deviceId", (req, res) => {
  const deviceId = req.params.deviceId;
  const waves = Object.values(db.waves)
    .filter(wave => canAccessWave(wave, deviceId))
    .map(wave => ({
      waveId: wave.id,
      waveName: wave.name,
      isOwner: isWaveOwner(wave, deviceId),
      membersCount: Object.keys(wave.members || {}).length
    }));

  res.json({ waves });
});

app.post("/api/waves/rename", (req, res) => {
  try {
    const { waveId, newName, deviceId } = req.body || {};
    const wave = getWave(waveId);

    if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });
    if (!isWaveOwner(wave, deviceId)) {
      return res.status(403).json({ error: "غير مصرح" });
    }

    wave.name = newName || wave.name;
    saveDb();
    res.json({ success: true, waveName: wave.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/waves/remove-member", (req, res) => {
  try {
    const { waveId, memberId, ownerDevice } = req.body || {};
    const wave = getWave(waveId);

    if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });
    if (!isWaveOwner(wave, ownerDevice)) {
      return res.status(403).json({ error: "غير مصرح" });
    }
    if (memberId === ownerDevice) {
      return res.status(400).json({ error: "لا يمكنك إخراج نفسك" });
    }

    delete wave.members[memberId];
    if (wave.onlineNow) delete wave.onlineNow[memberId];
    saveDb();

    const sid = deviceSockets[memberId];
    if (sid) {
      io.to(sid).emit("wave_removed", { waveId });
    }

    emitMembers(waveId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
