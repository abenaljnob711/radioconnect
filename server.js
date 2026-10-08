"use strict";

/* ==========================================
   Radio Connect Server - v1.0
   Node.js + Express + LiveKit
   ========================================== */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

let AccessToken;
try {
  const lk = require("livekit-server-sdk");
  AccessToken = lk.AccessToken;
} catch (e) {
  console.warn("⚠️ livekit-server-sdk غير مثبّت");
}

const app = express();
const PORT = process.env.PORT || 3000;
const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const DATA_FILE = path.join(__dirname, "rooms.json");
const MAX_MEMBERS = 60;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================
   قاعدة البيانات
   ========================================== */
let db = {
  devices: {},
  rooms: {},
  favorites: {},
  waveChannels: {},
  roomCounter: 0
};

const systemMessages = {};

function generateRoomId() {
  return "RAD-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function generateDeviceId() {
  return "dev_" + crypto.randomBytes(8).toString("hex");
}

function generateWaveFingerprint() {
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const numbers = Math.floor(100 + Math.random() * 900);
  return letter + numbers;
}

function generatePersonalCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function now() {
  return Date.now();
}

function getDeviceIdFromReq(req) {
  return req.headers["x-device-id"] || req.query.deviceId || req.body?.deviceId || null;
}

function addSystemMessage(roomId, text) {
  if (!systemMessages[roomId]) systemMessages[roomId] = [];
  systemMessages[roomId].push({
    id: crypto.randomBytes(4).toString("hex"),
    text,
    time: now()
  });
  if (systemMessages[roomId].length > 50) systemMessages[roomId].shift();
}

/* ==========================================
   تحميل وحفظ البيانات
   ========================================== */
function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      db.devices = parsed.devices || {};
      db.rooms = parsed.rooms || {};
      db.favorites = parsed.favorites || {};
      db.waveChannels = parsed.waveChannels || {};
      db.roomCounter = parsed.roomCounter || 0;

      for (const devId in db.devices) {
        if (!db.devices[devId].waveFingerprint) {
          db.devices[devId].waveFingerprint = generateWaveFingerprint();
        }
      }
      for (const roomId in db.rooms) {
        if (!db.rooms[roomId].roomNumber) {
          db.roomCounter++;
          db.rooms[roomId].roomNumber = db.roomCounter;
        }
      }
    }
  } catch (e) {
    console.error("⚠️ تحميل:", e.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("⚠️ حفظ:", e.message);
  }
}

loadDb();

/* ==========================================
   Health
   ========================================== */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    livekit: !!LIVEKIT_API_KEY,
    rooms: Object.keys(db.rooms).length,
    devices: Object.keys(db.devices).length,
    waveChannels: Object.keys(db.waveChannels).length
  });
});

/* ==========================================
   POST /api/device
   ========================================== */
app.post("/api/device", (req, res) => {
  try {
    let { deviceId } = req.body || {};

    if (!deviceId || !db.devices[deviceId]) {
      deviceId = deviceId || generateDeviceId();
      db.devices[deviceId] = {
        createdAt: now(),
        waveFingerprint: generateWaveFingerprint()
      };
      saveDb();
    } else if (!db.devices[deviceId].waveFingerprint) {
      db.devices[deviceId].waveFingerprint = generateWaveFingerprint();
      saveDb();
    }

    res.json({
      deviceId,
      createdAt: db.devices[deviceId].createdAt,
      waveFingerprint: db.devices[deviceId].waveFingerprint
    });
  } catch (e) {
    console.error("device:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms
   ========================================== */
app.get("/api/rooms", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);

    const roomsList = Object.values(db.rooms).map(room => {
      const member = room.members.find(m => m.deviceId === deviceId);
      const approvedCount = room.members.filter(m => m.status === "approved").length;
      const pendingCount = room.members.filter(m => m.status === "pending").length;
      const isFav = (db.favorites[deviceId] || []).includes(room.id);

      return {
        id: room.id,
        name: room.name,
        roomNumber: room.roomNumber,
        isOwner: room.owner === deviceId,
        isMember: !!member && member.status === "approved",
        isPending: !!member && member.status === "pending",
        memberCount: approvedCount,
        pendingCount,
        favorite: isFav,
        createdAt: room.createdAt
      };
    });

    roomsList.sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      if (a.isMember !== b.isMember) return a.isMember ? -1 : 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    res.json({ rooms: roomsList });
  } catch (e) {
    console.error("rooms:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms
   ========================================== */
app.post("/api/rooms", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { name } = req.body || {};

    if (!deviceId) return res.status(401).json({ error: "device_required" });
    if (!name || !name.trim()) return res.status(400).json({ error: "name_required" });

    let roomId = generateRoomId();
    while (db.rooms[roomId]) roomId = generateRoomId();

    db.roomCounter = (db.roomCounter || 0) + 1;
    const personalCode = generatePersonalCode();

    const room = {
      id: roomId,
      name: name.trim(),
      owner: deviceId,
      roomNumber: db.roomCounter,
      createdAt: now(),
      members: [{
        deviceId,
        name: "المسؤول",
        role: "owner",
        status: "approved",
        personalCode: personalCode,
        joinedAt: now()
      }]
    };

    db.rooms[roomId] = room;
    saveDb();
    addSystemMessage(roomId, "تم إنشاء الغرفة: " + room.name);

    res.json({
      roomId: room.id,
      room: {
        id: room.id,
        name: room.name,
        roomNumber: room.roomNumber,
        isOwner: true,
        isMember: true,
        memberCount: 1,
        personalCode: personalCode
      }
    });
  } catch (e) {
    console.error("create:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/join
   ========================================== */
app.post("/api/rooms/join", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { code, name } = req.body || {};

    if (!deviceId) return res.status(401).json({ error: "device_required" });
    if (!code) return res.status(400).json({ error: "code_required" });

    const room = db.rooms[code] ||
      Object.values(db.rooms).find(r =>
        r.id === code ||
        r.id.endsWith(code) ||
        r.members.some(m => m.personalCode === code && (m.role === "owner" || m.role === "admin"))
      );

    if (!room) return res.status(404).json({ error: "invalid_code" });

    const approvedCount = room.members.filter(m => m.status === "approved").length;
    if (approvedCount >= MAX_MEMBERS) {
      return res.status(400).json({ error: "room_full" });
    }

    let member = room.members.find(m => m.deviceId === deviceId);
    if (member) {
      return res.json({
        room: { id: room.id, name: room.name, roomNumber: room.roomNumber },
        status: member.status,
        message: "أنت عضو بالفعل"
      });
    }

    member = {
      deviceId,
      name: (name || "عضو").trim().substring(0, 50),
      role: "member",
      status: "pending",
      personalCode: null,
      joinedAt: now()
    };
    room.members.push(member);
    saveDb();
    addSystemMessage(room.id, "طلب انضمام من " + member.name);

    res.json({
      room: { id: room.id, name: room.name, roomNumber: room.roomNumber },
      status: "pending",
      message: "تم إرسال طلب الانضمام"
    });
  } catch (e) {
    console.error("join:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms/:id/members
   ========================================== */
app.get("/api/rooms/:id/members", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });

    const requester = room.members.find(m => m.deviceId === deviceId);
    if (!requester || (requester.status !== "approved" && room.owner !== deviceId)) {
      return res.status(403).json({ error: "not_a_member" });
    }

    const isOwner = room.owner === deviceId;

    const members = room.members.map(m => ({
      deviceId: m.deviceId,
      name: m.name,
      role: m.role,
      status: m.status,
      personalCode: (isOwner || m.deviceId === deviceId) ? m.personalCode : null,
      joinedAt: m.joinedAt
    }));

    res.json({ members, isOwner });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/members/:deviceId/approve
   ========================================== */
app.post("/api/rooms/:id/members/:deviceId/approve", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });

    const requester = room.members.find(m => m.deviceId === deviceId);
    if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
      return res.status(403).json({ error: "admin_only" });
    }

    const member = room.members.find(m => m.deviceId === req.params.deviceId);
    if (!member) return res.status(404).json({ error: "member_not_found" });

    member.status = "approved";
    saveDb();
    addSystemMessage(room.id, "تم الانضمام إلى الغرفة: " + member.name);
    res.json({ message: "تمت الموافقة" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/members/:deviceId/reject
   ========================================== */
app.post("/api/rooms/:id/members/:deviceId/reject", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });

    const requester = room.members.find(m => m.deviceId === deviceId);
    if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
      return res.status(403).json({ error: "admin_only" });
    }

    const idx = room.members.findIndex(m => m.deviceId === req.params.deviceId);
    if (idx === -1) return res.status(404).json({ error: "member_not_found" });

    room.members.splice(idx, 1);
    saveDb();
    res.json({ message: "تم الرفض" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/promote
   ========================================== */
app.post("/api/rooms/:id/promote", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { targetDeviceId } = req.body || {};
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (room.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    const member = room.members.find(m => m.deviceId === targetDeviceId);
    if (!member) return res.status(404).json({ error: "member_not_found" });

    member.role = "admin";
    member.personalCode = generatePersonalCode();
    saveDb();
    addSystemMessage(room.id, "تم ترقية " + member.name + " إلى مشرف");

    res.json({ message: "تمت الترقية", personalCode: member.personalCode });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/demote
   ========================================== */
app.post("/api/rooms/:id/demote", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { targetDeviceId } = req.body || {};
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (room.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    const member = room.members.find(m => m.deviceId === targetDeviceId);
    if (!member) return res.status(404).json({ error: "member_not_found" });
    if (member.role === "owner") return res.status(400).json({ error: "cannot_demote_owner" });

    member.role = "member";
    member.personalCode = null;
    saveDb();
    addSystemMessage(room.id, "تم إنزال " + member.name + " من الإشراف");

    res.json({ message: "تم سحب الإشراف" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   DELETE /api/rooms/:id/members/:deviceId
   ========================================== */
app.delete("/api/rooms/:id/members/:deviceId", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });

    const requester = room.members.find(m => m.deviceId === deviceId);
    if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
      return res.status(403).json({ error: "admin_only" });
    }

    const idx = room.members.findIndex(m => m.deviceId === req.params.deviceId);
    if (idx === -1) return res.status(404).json({ error: "member_not_found" });
    if (room.members[idx].role === "owner") return res.status(400).json({ error: "cannot_remove_owner" });
    if (requester.role === "admin" && room.members[idx].role === "admin") {
      return res.status(403).json({ error: "cannot_remove_admin" });
    }

    const removedName = room.members[idx].name;
    room.members.splice(idx, 1);
    saveDb();
    addSystemMessage(room.id, "تم حذف " + removedName + " من الغرفة");
    res.json({ message: "تم الحذف" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/favorite
   ========================================== */
app.post("/api/rooms/:id/favorite", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (!deviceId) return res.status(401).json({ error: "device_required" });

    if (!db.favorites[deviceId]) db.favorites[deviceId] = [];
    const idx = db.favorites[deviceId].indexOf(room.id);
    let isFavorite;

    if (idx === -1) {
      db.favorites[deviceId].push(room.id);
      isFavorite = true;
    } else {
      db.favorites[deviceId].splice(idx, 1);
      isFavorite = false;
    }

    saveDb();
    res.json({ favorite: isFavorite });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/favorites
   ========================================== */
app.get("/api/favorites", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    if (!deviceId) return res.json({ rooms: [] });

    const favIds = db.favorites[deviceId] || [];
    const roomsList = favIds.map(id => db.rooms[id]).filter(Boolean).map(room => ({
      id: room.id,
      name: room.name,
      roomNumber: room.roomNumber,
      isOwner: room.owner === deviceId,
      isMember: room.members.some(m => m.deviceId === deviceId && m.status === "approved"),
      memberCount: room.members.filter(m => m.status === "approved").length,
      favorite: true
    }));

    res.json({ rooms: roomsList });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   DELETE /api/rooms/:id
   ========================================== */
app.delete("/api/rooms/:id", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (room.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    delete db.rooms[req.params.id];
    Object.keys(db.favorites).forEach(devId => {
      const idx = db.favorites[devId].indexOf(req.params.id);
      if (idx !== -1) db.favorites[devId].splice(idx, 1);
    });
    saveDb();
    res.json({ message: "تم حذف الغرفة" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms/:id/system-messages
   ========================================== */
app.get("/api/rooms/:id/system-messages", (req, res) => {
  res.json({ messages: systemMessages[req.params.id] || [] });
});

/* ==========================================
   POST /api/wave-channels/create
   ========================================== */
app.post("/api/wave-channels/create", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { fingerprint } = req.body || {};
    if (!deviceId) return res.status(401).json({ error: "device_required" });
    if (!fingerprint) return res.status(400).json({ error: "fingerprint_required" });

    const code = fingerprint.toUpperCase();
    if (db.waveChannels[code]) {
      const channel = db.waveChannels[code];
      if (channel.owner === deviceId) {
        return res.json({ ok: true, message: "أنت صاحب البصمة" });
      }
      return res.status(400).json({ error: "channel_exists" });
    }

    db.waveChannels[code] = {
      code,
      owner: deviceId,
      createdAt: now(),
      members: [{
        deviceId,
        name: "صاحب البصمة",
        status: "approved",
        joinedAt: now()
      }],
      pendingRequests: []
    };
    saveDb();
    res.json({ ok: true, code, message: "تم إنشاء القناة" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/wave-channels/join
   ========================================== */
app.post("/api/wave-channels/join", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { fingerprint, memberName } = req.body || {};
    if (!deviceId) return res.status(401).json({ error: "device_required" });
    if (!fingerprint) return res.status(400).json({ error: "fingerprint_required" });

    const code = fingerprint.toUpperCase();
    const channel = db.waveChannels[code];
    if (!channel) return res.status(404).json({ error: "channel_not_found" });

    const approvedCount = channel.members.filter(m => m.status === "approved").length;
    if (approvedCount >= MAX_MEMBERS) return res.status(400).json({ error: "channel_full" });

    if (channel.owner === deviceId) {
      return res.json({ status: "approved", message: "أنت صاحب البصمة" });
    }

    let member = channel.members.find(m => m.deviceId === deviceId);
    if (member) {
      return res.json({
        status: member.status,
        message: member.status === "approved" ? "متصل" : "قيد المراجعة"
      });
    }

    channel.members.push({
      deviceId,
      name: (memberName || "متصل").trim().substring(0, 50),
      status: "pending",
      joinedAt: now()
    });

    channel.pendingRequests.push({
      deviceId,
      name: (memberName || "متصل").trim().substring(0, 50),
      requestedAt: now()
    });

    saveDb();
    res.json({ status: "pending", message: "تم إرسال الطلب" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/wave-channels/:code/pending
   ========================================== */
app.get("/api/wave-channels/:code/pending", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const code = (req.params.code || "").toUpperCase();
    const channel = db.waveChannels[code];

    if (!channel) return res.status(404).json({ error: "channel_not_found" });
    if (channel.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    res.json({ pendingRequests: channel.pendingRequests || [] });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/wave-channels/:code/approve
   ========================================== */
app.post("/api/wave-channels/:code/approve", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { targetDeviceId } = req.body || {};
    const code = (req.params.code || "").toUpperCase();
    const channel = db.waveChannels[code];

    if (!channel) return res.status(404).json({ error: "channel_not_found" });
    if (channel.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    const member = channel.members.find(m => m.deviceId === targetDeviceId);
    if (member) member.status = "approved";
    channel.pendingRequests = channel.pendingRequests.filter(r => r.deviceId !== targetDeviceId);
    saveDb();
    res.json({ ok: true, message: "تمت الموافقة" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/wave-channels/:code/reject
   ========================================== */
app.post("/api/wave-channels/:code/reject", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { targetDeviceId } = req.body || {};
    const code = (req.params.code || "").toUpperCase();
    const channel = db.waveChannels[code];

    if (!channel) return res.status(404).json({ error: "channel_not_found" });
    if (channel.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    channel.members = channel.members.filter(m => m.deviceId !== targetDeviceId);
    channel.pendingRequests = channel.pendingRequests.filter(r => r.deviceId !== targetDeviceId);
    saveDb();
    res.json({ ok: true, message: "تم الرفض" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/search-user
   ========================================== */
app.get("/api/search-user", (req, res) => {
  try {
    const myDeviceId = getDeviceIdFromReq(req);
    const fingerprint = (req.query.fingerprint || "").toUpperCase();
    if (!fingerprint) return res.status(400).json({ error: "fingerprint_required" });

    let targetDeviceId = null;
    for (const devId in db.devices) {
      if (db.devices[devId].waveFingerprint === fingerprint) {
        targetDeviceId = devId;
        break;
      }
    }

    if (!targetDeviceId) return res.status(404).json({ error: "user_not_found" });
    if (targetDeviceId === myDeviceId) return res.status(400).json({ error: "cannot_search_self" });

    let targetRoom = null;
    for (const roomId in db.rooms) {
      const room = db.rooms[roomId];
      const member = room.members.find(m => m.deviceId === targetDeviceId && m.status === "approved");
      if (member) {
        targetRoom = { id: room.id, name: room.name, roomNumber: room.roomNumber };
        break;
      }
    }

    if (!targetRoom) return res.status(404).json({ error: "user_not_in_room" });

    res.json({
      found: true,
      deviceId: targetDeviceId,
      waveFingerprint: fingerprint,
      room: targetRoom
    });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /token
   ========================================== */
app.get("/token", async (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const roomId = req.query.room;

    if (!deviceId) return res.status(401).json({ error: "device_required" });
    if (!roomId) return res.status(400).json({ error: "room_required" });
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(500).json({ error: "livekit_not_configured" });
    }

    const room = db.rooms[roomId];
    if (room) {
      const member = room.members.find(m => m.deviceId === deviceId);
      if (!member || member.status !== "approved") {
        return res.status(403).json({ error: "not_a_member" });
      }
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: deviceId,
      ttl: "6h",
      name: deviceId.substring(0, 12)
    });

    at.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const token = await at.toJwt();

    res.json({
      token,
      url: LIVEKIT_URL || "wss://radioconnect-8uyh53qc.livekit.cloud"
    });
  } catch (e) {
    console.error("token:", e);
    res.status(500).json({ error: "token_failed" });
  }
});

/* ==========================================
   404 fallback
   ========================================== */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ==========================================
   تشغيل
   ========================================== */
app.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log("📡  Radio Connect Server");
  console.log("========================================");
  console.log("✅  المنفذ: " + PORT);
  console.log("🔑  LiveKit: " + (LIVEKIT_API_KEY ? "مفعّل ✅" : "غير مُعدّ ❌"));
  console.log("📦  الغرف: " + Object.keys(db.rooms).length);
  console.log("📻  قنوات الموجة: " + Object.keys(db.waveChannels).length);
  console.log("========================================");
  console.log("");
});
