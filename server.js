"use strict";

/* ==========================================
   Radio Connect Server - v3.1
   + إرسال طلبات الانضمام لصاحب الموجة فقط
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
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8
});

const PORT = process.env.PORT || 3000;
const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const DATA_FILE = path.join(__dirname, "rooms.json");
const MAX_MEMBERS = 60;

/* ✅ خريطة ربط deviceId → socket.id */
const deviceSockets = {};

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================
   قاعدة البيانات
   ========================================== */
let db = {
  devices: {},
  rooms: {},
  messages: {},
  waves: {},
  waveRequests: {},
  roomCounter: 0
};

function generateRoomId() {
  return "RAD-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function generateWaveId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "Q";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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
      db.waves = parsed.waves || {};
      db.waveRequests = parsed.waveRequests || {};
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
   APIs عامة
   ========================================== */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "Radio Connect Server",
    version: "3.1",
    livekit: LIVEKIT_URL ? "configured" : "not configured",
    uptime: process.uptime()
  });
});

/* ==========================================
   APIs الموجات
   ========================================== */
app.post("/api/waves/create", (req, res) => {
  try {
    const { deviceId, waveName } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId مطلوب" });
    }

    // إذا كان له موجة سابقة → أرجعها
    if (db.devices[deviceId] && db.devices[deviceId].waveId) {
      const existingWaveId = db.devices[deviceId].waveId;
      const existingWave = db.waves[existingWaveId];
      if (existingWave) {
        return res.json({
          success: true,
          waveId: existingWaveId,
          waveName: existingWave.name,
          isNew: false
        });
      }
    }

    // توليد موجة جديدة
    let waveId;
    do {
      waveId = generateWaveId();
    } while (db.waves[waveId]);

    db.waves[waveId] = {
      id: waveId,
      name: waveName || "موجتي",
      ownerDevice: deviceId,
      createdAt: now(),
      listeners: {}
    };

    if (!db.devices[deviceId]) db.devices[deviceId] = {};
    db.devices[deviceId].waveId = waveId;

    saveDb();

    res.json({
      success: true,
      waveId: waveId,
      waveName: db.waves[waveId].name,
      isNew: true
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/waves/:waveId", (req, res) => {
  const wave = db.waves[req.params.waveId];
  if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });
  res.json({
    waveId: wave.id,
    waveName: wave.name,
    listenersCount: Object.keys(wave.listeners).length,
    ownerDevice: wave.ownerDevice
  });
});

app.get("/api/waves/search/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  const wave = db.waves[code];
  if (!wave) {
    return res.status(404).json({ error: "لا توجد موجة بهذا الرقم" });
  }
  res.json({
    waveId: wave.id,
    waveName: wave.name,
    listenersCount: Object.keys(wave.listeners).length,
    ownerDevice: wave.ownerDevice
  });
});

app.post("/api/waves/rename", (req, res) => {
  try {
    const { waveId, newName, deviceId } = req.body;
    const wave = db.waves[waveId];
    if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });
    if (wave.ownerDevice !== deviceId) {
      return res.status(403).json({ error: "غير مصرح" });
    }
    wave.name = newName || wave.name;
    saveDb();
    res.json({ success: true, waveName: wave.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==========================================
   APIs الغرف
   ========================================== */
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

app.get("/api/rooms/:roomId", (req, res) => {
  const room = db.rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "الغرفة غير موجودة" });
  res.json(room);
});

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
   LiveKit Token
   ========================================== */
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

/* ==========================================
   Socket.io
   ========================================== */
io.on("connection", (socket) => {
  console.log("🔌 مستخدم متصل:", socket.id);

  /* ✅ تسجيل deviceId ← socket.id */
  socket.on("register_device", ({ deviceId }) => {
    if (deviceId) {
      socket.data.deviceId = deviceId;
      deviceSockets[deviceId] = socket.id;
      console.log(`✅ ربط deviceId ${deviceId} ← ${socket.id}`);
    }
  });

  /* ==========================================
     أحداث الغرف
     ========================================== */
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

    io.to(roomId).emit("member_joined", {
      deviceId,
      userName,
      members: Object.values(db.rooms[roomId].members)
    });

    socket.emit("previous_messages", db.messages[roomId] || []);
  });

  socket.on("send_message", ({ roomId, message }) => {
    if (!db.messages[roomId]) db.messages[roomId] = [];
    db.messages[roomId].push(message);
    if (db.messages[roomId].length > 1000) db.messages[roomId].shift();
    saveDb();
    io.to(roomId).emit("new_message", message);
    socket.emit("message_delivered", { messageId: message.id });
  });

  socket.on("typing", ({ roomId, userName }) => {
    socket.to(roomId).emit("user_typing", { userName });
  });

  /* ==========================================
     أحداث الموجات
     ========================================== */

  // ✅ الانضمام لموجة
  socket.on("wave_join", ({ waveId, deviceId, userName }) => {
    socket.join("wave_" + waveId);
    socket.data.waveId = waveId;
    socket.data.deviceId = deviceId;
    socket.data.userName = userName;

    if (!db.waves[waveId]) {
      db.waves[waveId] = {
        id: waveId,
        name: waveId,
        ownerDevice: null,
        createdAt: now(),
        listeners: {}
      };
    }

    db.waves[waveId].listeners[deviceId] = {
      id: deviceId,
      name: userName || "مستخدم",
      joinedAt: now()
    };
    saveDb();

    io.to("wave_" + waveId).emit("wave_listener_joined", {
      deviceId,
      userName,
      listeners: Object.values(db.waves[waveId].listeners)
    });

    console.log(`📻 ${userName} انضم للموجة ${waveId}`);
  });

  // ✅ خروج من موجة
  socket.on("wave_leave", ({ waveId, deviceId }) => {
    if (db.waves[waveId] && db.waves[waveId].listeners[deviceId]) {
      delete db.waves[waveId].listeners[deviceId];
      saveDb();
      io.to("wave_" + waveId).emit("wave_listener_left", {
        deviceId,
        listeners: Object.values(db.waves[waveId].listeners)
      });
    }
    socket.leave("wave_" + waveId);
  });

  // ✅ إرسال طلب انضمام لموجة
  socket.on("wave_join_request", ({ waveId, fromDeviceId, fromUserName }) => {
    const wave = db.waves[waveId];
    if (!wave) {
      socket.emit("wave_join_error", { error: "الموجة غير موجودة" });
      return;
    }

    if (!wave.ownerDevice) {
      socket.emit("wave_join_error", { error: "لا يوجد صاحب للموجة" });
      return;
    }

    const requestId = "req_" + crypto.randomBytes(6).toString("hex");
    db.waveRequests[requestId] = {
      id: requestId,
      waveId: waveId,
      fromDeviceId: fromDeviceId,
      fromUserName: fromUserName,
      toDeviceId: wave.ownerDevice,
      createdAt: now(),
      status: "pending"
    };
    saveDb();

    // ✅ أرسل الطلب لصاحب الموجة فقط
    const ownerSocketId = deviceSockets[wave.ownerDevice];
    if (ownerSocketId) {
      io.to(ownerSocketId).emit("wave_join_request_received", {
        requestId: requestId,
        waveId: waveId,
        fromDeviceId: fromDeviceId,
        fromUserName: fromUserName,
        toDeviceId: wave.ownerDevice
      });
      console.log(`📩 طلب انضمام من ${fromUserName} أُرسل لصاحب الموجة ${wave.ownerDevice}`);
    } else {
      console.log(`⚠️ صاحب الموجة ${wave.ownerDevice} غير متصل الآن`);
      socket.emit("wave_join_error", { error: "صاحب الموجة غير متصل الآن، حاول لاحقاً" });
      return;
    }

    socket.emit("wave_join_request_sent", {
      requestId: requestId,
      waveId: waveId
    });
  });

  // ✅ الرد على طلب انضمام
  socket.on("wave_join_response", ({ requestId, accepted }) => {
    const request = db.waveRequests[requestId];
    if (!request) {
      socket.emit("wave_join_error", { error: "الطلب غير موجود" });
      return;
    }

    request.status = accepted ? "accepted" : "rejected";
    saveDb();

    // ✅ أرسل النتيجة للشخص الذي طلب الانضمام فقط
    const requesterSocketId = deviceSockets[request.fromDeviceId];
    if (requesterSocketId) {
      io.to(requesterSocketId).emit("wave_join_response_received", {
        requestId: requestId,
        waveId: request.waveId,
        accepted: accepted,
        fromDeviceId: request.fromDeviceId,
        fromUserName: request.fromUserName
      });
    }

    // إذا تم القبول → أضف العضو للموجة
    if (accepted) {
      if (!db.waves[request.waveId]) {
        db.waves[request.waveId] = {
          id: request.waveId,
          name: request.waveId,
          ownerDevice: null,
          createdAt: now(),
          listeners: {}
        };
      }
      db.waves[request.waveId].listeners[request.fromDeviceId] = {
        id: request.fromDeviceId,
        name: request.fromUserName,
        joinedAt: now()
      };
      saveDb();

      io.to("wave_" + request.waveId).emit("wave_listener_joined", {
        deviceId: request.fromDeviceId,
        userName: request.fromUserName,
        listeners: Object.values(db.waves[request.waveId].listeners)
      });
    }
  });

  /* ==========================================
     البث الحي (إشارات)
     ========================================== */
  socket.on("wave_broadcast_start", ({ waveId, deviceId, userName }) => {
    socket.to("wave_" + waveId).emit("wave_broadcast_start", {
      deviceId: deviceId,
      userName: userName
    });
  });

  socket.on("wave_broadcast_stop", ({ waveId, deviceId }) => {
    socket.to("wave_" + waveId).emit("wave_broadcast_stop", {
      deviceId: deviceId
    });
  });

  /* ==========================================
     قطع الاتصال
     ========================================== */
  socket.on("disconnect", () => {
    const { roomId, deviceId, userName, waveId } = socket.data;

    // ✅ احذف من خريطة deviceSockets
    if (deviceId && deviceSockets[deviceId] === socket.id) {
      delete deviceSockets[deviceId];
      console.log(`🗑️ حذف ربط ${deviceId}`);
    }

    if (roomId && db.rooms[roomId] && deviceId) {
      delete db.rooms[roomId].members[deviceId];
      saveDb();
      io.to(roomId).emit("member_left", {
        deviceId,
        userName,
        members: Object.values(db.rooms[roomId].members)
      });
    }

    if (waveId && db.waves[waveId] && deviceId) {
      delete db.waves[waveId].listeners[deviceId];
      saveDb();
      io.to("wave_" + waveId).emit("wave_listener_left", {
        deviceId,
        listeners: Object.values(db.waves[waveId].listeners)
      });
    }

    console.log("❌ مستخدم غادر:", socket.id);
  });
});

/* ==========================================
   تشغيل السيرفر
   ========================================== */
server.listen(PORT, () => {
  console.log(`🚀 Radio Connect Server v3.1 يعمل على المنفذ ${PORT}`);
  console.log(`📡 LiveKit: ${LIVEKIT_URL ? "✅ مهيّأ" : "❌ غير مهيّأ"}`);
});
