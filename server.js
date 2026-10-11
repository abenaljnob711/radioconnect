"use strict";

/* ==========================================
   Radio Connect Server - v2.0
   Node.js + Express + LiveKit + Socket.io
   ========================================== */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

let AccessToken;
try {
  const lk = require("livekit-server-sdk");
  AccessToken = lk.AccessToken;
} catch (e) {
  console.warn("⚠️ livekit-server-sdk غير مثبّت");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

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
   قاعدة البيانات (JSON)
   ========================================== */
let db = {
  devices: {},
  rooms: {},
  messages: {},
  roomCounter: 0
};

function generateRoomId() {
  return "RAD-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function generateDeviceId() {
  return "dev_" + crypto.randomBytes(8).toString("hex");
}

function generatePersonalCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function now() {
  return Date.now();
}

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      db.devices = parsed.devices || {};
      db.rooms = parsed.rooms || {};
      db.messages = parsed.messages || {};
      db.roomCounter = parsed.roomCounter || 0;
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

loadDb();

/* ==========================================
   APIs العامة
   ========================================== */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "Radio Connect Server",
    version: "2.0",
    livekit: LIVEKIT_URL ? "configured" : "not configured",
    uptime: process.uptime()
  });
});

// ✅ إنشاء غرفة جديدة
app.post("/api/rooms/create", (req, res) => {
  try {
    const { name, channel, deviceId } = req.body;
    if (!name || !channel) {
      return res.status(400).json({ error: "الاسم والقناة مطلوبان" });
    }

    const roomId = generateRoomId();
    db.rooms[roomId] = {
      id: roomId,
      name: name,
      channel: channel,
      roomNumber: ++db.roomCounter,
      createdAt: now(),
      members: {},
      ownerDevice: deviceId || null
    };
    db.messages[roomId] = [];

    saveDb();

    res.json({
      success: true,
      roomId: roomId,
      roomName: name,
      channel: channel
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ الانضمام إلى غرفة
app.post("/api/rooms/join", (req, res) => {
  try {
    const { roomId, deviceId, userName } = req.body;
    if (!roomId || !deviceId) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    const room = db.rooms[roomId];
    if (!room) {
      return res.status(404).json({ error: "الغرفة غير موجودة" });
    }

    if (Object.keys(room.members).length >= MAX_MEMBERS) {
      return res.status(403).json({ error: "الغرفة ممتلئة" });
    }

    room.members[deviceId] = {
      id: deviceId,
      name: userName || "مستخدم",
      joinedAt: now()
    };
    saveDb();

    res.json({
      success: true,
      roomId: roomId,
      roomName: room.name,
      channel: room.channel,
      members: Object.values(room.members)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ معلومات غرفة
app.get("/api/rooms/:roomId", (req, res) => {
  const room = db.rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "الغرفة غير موجودة" });
  res.json(room);
});

// ✅ توليد Token لـ LiveKit (للصوت)
app.post("/api/livekit/token", async (req, res) => {
  try {
    const { roomId, deviceId, userName } = req.body;

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(500).json({ error: "LiveKit غير مهيّأ على السيرفر" });
    }
    if (!roomId || !deviceId) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }

    if (!AccessToken) {
      return res.status(500).json({ error: "مكتبة LiveKit غير مثبتة" });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: deviceId,
      name: userName || deviceId,
      ttl: "6h"
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
      success: true,
      token: token,
      url: LIVEKIT_URL,
      room: roomId
    });
  } catch (e) {
    console.error("خطأ LiveKit:", e);
    res.status(500).json({ error: e.message });
  }
});

// ✅ البحث برقم الغرفة
app.get("/api/search/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = Object.values(db.rooms).find(r => r.id === code);
  if (!room) return res.status(404).json({ error: "لا توجد غرفة بهذا الرقم" });
  res.json({
    roomId: room.id,
    roomName: room.name,
    channel: room.channel,
    membersCount: Object.keys(room.members).length
  });
});

/* ==========================================
   Socket.io - الرسائل الفورية
   ========================================== */
io.on("connection", (socket) => {
  console.log("🔌 مستخدم متصل:", socket.id);

  // ✅ الانضمام لغرفة Socket.io
  socket.on("join_room", ({ roomId, deviceId, userName }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.deviceId = deviceId;
    socket.data.userName = userName;

    if (!db.rooms[roomId]) {
      db.rooms[roomId] = {
        id: roomId,
        name: roomId,
        channel: "07",
        members: {},
        createdAt: now()
      };
      db.messages[roomId] = [];
    }

    db.rooms[roomId].members[deviceId] = {
      id: deviceId,
      name: userName || "مستخدم",
      joinedAt: now()
    };
    saveDb();

    // إشعار الجميع بانضمام عضو جديد
    io.to(roomId).emit("member_joined", {
      deviceId,
      userName,
      members: Object.values(db.rooms[roomId].members)
    });

    // إرسال الرسائل السابقة
    socket.emit("previous_messages", db.messages[roomId] || []);

    console.log(`👤 ${userName} انضم لغرفة ${roomId}`);
  });

  // ✅ استقبال رسالة نصية
  socket.on("send_message", ({ roomId, message }) => {
    if (!db.messages[roomId]) db.messages[roomId] = [];
    db.messages[roomId].push(message);
    if (db.messages[roomId].length > 500) db.messages[roomId].shift();
    saveDb();

    // إرسال الرسالة لكل من في الغرفة
    io.to(roomId).emit("new_message", message);

    // إشعار المرسل بأن الرسالة تم تسليمها
    socket.emit("message_delivered", { messageId: message.id });
  });

  // ✅ استقبال رسالة صوتية
  socket.on("send_voice", ({ roomId, voiceMessage }) => {
    if (!db.messages[roomId]) db.messages[roomId] = [];
    db.messages[roomId].push(voiceMessage);
    saveDb();

    io.to(roomId).emit("new_message", voiceMessage);
    socket.emit("message_delivered", { messageId: voiceMessage.id });
  });

  // ✅ مؤشر "يكتب الآن"
  socket.on("typing", ({ roomId, userName }) => {
    socket.to(roomId).emit("user_typing", { userName });
  });

  // ✅ مغادرة
  socket.on("disconnect", () => {
    const { roomId, deviceId, userName } = socket.data;
    if (roomId && db.rooms[roomId]) {
      delete db.rooms[roomId].members[deviceId];
      saveDb();
      io.to(roomId).emit("member_left", {
        deviceId,
        userName,
        members: Object.values(db.rooms[roomId].members)
      });
    }
    console.log("❌ مستخدم غادر:", socket.id);
  });
});

/* ==========================================
   تشغيل السيرفر
   ========================================== */
server.listen(PORT, () => {
  console.log(`🚀 Radio Connect Server يعمل على المنفذ ${PORT}`);
  console.log(`📡 LiveKit: ${LIVEKIT_URL ? "✅ مهيّأ" : "❌ غير مهيّأ"}`);
});
