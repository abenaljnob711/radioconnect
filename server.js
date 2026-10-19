"use strict";

/* ==========================================
   Radio Connect Server - Final Version v4.5
   Includes: Search, Join Requests, Approval System, LiveKit, & Sockets
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

const deviceSockets = {};

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

/* ==========================================
   الدوال المساعدة
   ========================================== */
function generateRadCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "Q";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateConversationId(devA, devB) {
  const sorted = [devA, devB].sort();
  return "conv_" + crypto.createHash('md5').update(sorted.join('_')).digest('hex').substring(0, 16);
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

loadDb();

/* ==========================================
   المسارات (Routes)
   ========================================== */

app.get("/", (req, res) => {
  res.json({ status: "ok", name: "Radio Connect Server", version: "4.5" });
});

// 1. تصليح البحث: البحث بالكود وإرجاع الاسم الحقيقي
app.get("/api/waves/search/:waveCode", (req, res) => {
  const code = req.params.waveCode.toUpperCase();
  const wave = db.waves[code];
  if (!wave) return res.status(404).json({ error: "الفرقة غير موجودة" });

  res.json({
    success: true,
    waveId: wave.id,
    waveName: wave.name, // يظهر الاسم هنا
    totalMembers: Object.keys(wave.members || {}).length
  });
});

// 2. جلب طلبات الانضمام المعلقة (للقائد)
app.get("/api/waves/pending-requests/:waveId", (req, res) => {
  const { waveId } = req.params;
  const wave = db.waves[waveId];
  if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });

  const pending = Object.values(db.waveRequests).filter(
    req => req.waveId === waveId && req.status === "pending"
  );
  res.json({ success: true, pendingRequests: pending });
});

// 3. لوحة القائد: الموافقة أو الرفض
app.post("/api/waves/handle-request", (req, res) => {
  try {
    const { requestId, action, leaderDeviceId } = req.body;
    const request = db.waveRequests[requestId];

    if (!request) return res.status(404).json({ error: "الطلب غير موجود" });
    if (request.toDeviceId !== leaderDeviceId) return res.status(403).json({ error: "ليس لديك صلاحية" });

    request.status = action === "approve" ? "accepted" : "rejected";
    saveDb();

    const wave = db.waves[request.waveId];

    if (action === "approve" && wave) {
      if (!wave.members) wave.members = {};
      wave.members[request.fromDeviceId] = {
        id: request.fromDeviceId,
        name: request.fromUserName,
        isOwner: false,
        addedAt: now()
      };
      saveDb();

      // إبلاغ الشخص بالموافقة
      const requesterSocketId = deviceSockets[request.fromDeviceId];
      if (requesterSocketId) {
        io.to(requesterSocketId).emit("wave_join_response_received", {
          requestId: request.id,
          waveId: request.waveId,
          accepted: true,
          fromDeviceId: request.fromDeviceId,
          fromUserName: request.fromUserName
        });
      }

      // تحديث قائمة الأعضاء
      io.to("wave_" + request.waveId).emit("wave_members_updated", {
        members: Object.values(wave.members).map(m => ({
          id: m.id,
          name: m.name,
          isOwner: m.isOwner || false,
          online: !!(wave.onlineNow && wave.onlineNow[m.id])
        }))
      });
    } else {
      const requesterSocketId = deviceSockets[request.fromDeviceId];
      if (requesterSocketId) {
        io.to(requesterSocketId).emit("wave_join_response_received", {
          requestId: request.id,
          waveId: request.waveId,
          accepted: false
        });
      }
    }
    res.json({ success: true, message: action === "approve" ? "تمت الموافقة" : "تم الرفض" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// مسار إنشاء فرقة
app.post("/api/waves/create", (req, res) => {
  try {
    const { deviceId, waveName } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId مطلوب" });

    let waveId;
    do { waveId = generateRadCode(); } while (db.waves[waveId]);

    db.waves[waveId] = {
      id: waveId,
      name: waveName || "فرقتي",
      ownerDevice: deviceId,
      createdAt: now(),
      members: {},
      onlineNow: {}
    };

    db.waves[waveId].members[deviceId] = {
      id: deviceId,
      name: (db.devices[deviceId] && db.devices[deviceId].name) || "المالك",
      isOwner: true,
      addedAt: now()
    };

    saveDb();
    res.json({ success: true, waveId: waveId, waveName: db.waves[waveId].name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// جلب بيانات فرقة معينة
app.get("/api/waves/:waveId", (req, res) => {
  const wave = db.waves[req.params.waveId];
  if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });

  const members = Object.values(wave.members || {}).map(m => ({
    id: m.id,
    name: m.name,
    isOwner: m.isOwner || false,
    online: !!(wave.onlineNow && wave.onlineNow[m.id])
  }));

  res.json({
    waveId: wave.id,
    waveName: wave.name,
    totalMembers: members.length,
    members: members,
    ownerDevice: wave.ownerDevice
  });
});

// LiveKit Token (للغرف الصوتية)
app.post("/api/livekit/token", async (req, res) => {
  try {
    const { roomId, deviceId, userName } = req.body;
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(500).json({ error: "LiveKit غير مهيّأ" });
    }
    if (!AccessToken) return res.status(500).json({ error: "مكتبة LiveKit غير مثبتة" });

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: deviceId,
      name: userName || deviceId,
      ttl: "6h"
    });

    at.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();
    res.json({ success: true, token: token, url: LIVEKIT_URL, room: roomId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==========================================
   Socket.IO - الأحداث الحية
   ========================================== */
io.on("connection", (socket) => {
  console.log("🔌 متصل:", socket.id);

  socket.on("register_device", ({ deviceId, userName }) => {
    if (deviceId) {
      socket.data.deviceId = deviceId;
      socket.data.userName = userName;
      deviceSockets[deviceId] = socket.id;
      
      if (!db.devices[deviceId]) {
        db.devices[deviceId] = { id: deviceId, name: userName || "مستخدم", radCode: generateRadCode(), conversations: [], createdAt: now() };
        saveDb();
      }
    }
  });

  // حدث إرسال طلب الانضمام
  socket.on("wave_join_request", ({ waveId, fromDeviceId, fromUserName }) => {
    const wave = db.waves[waveId];
    if (!wave || !wave.ownerDevice) return socket.emit("wave_join_error", { error: "الموجة غير موجودة" });

    if (wave.members && wave.members[fromDeviceId]) {
      return socket.emit("wave_join_response_received", { waveId: waveId, accepted: true, fromDeviceId: fromDeviceId, fromUserName: fromUserName, direct: true });
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

    const ownerSocketId = deviceSockets[wave.ownerDevice];
    if (ownerSocketId) {
      io.to(ownerSocketId).emit("wave_join_request_received", {
        requestId, waveId, fromDeviceId, fromUserName, toDeviceId: wave.ownerDevice
      });
      socket.emit("wave_join_request_sent", { requestId, waveId });
    } else {
      socket.emit("wave_join_error", { error: "صاحب الموجة غير متصل حالياً" });
    }
  });

  socket.on("wave_join", ({ waveId, deviceId, userName }) => {
    socket.join("wave_" + waveId);
    socket.data.waveId = waveId;
    socket.data.deviceId = deviceId;
    socket.data.userName = userName;

    if (db.waves[waveId] && db.waves[waveId].members && db.waves[waveId].members[deviceId]) {
        db.waves[waveId].onlineNow = db.waves[waveId].onlineNow || {};
        db.waves[waveId].onlineNow[deviceId] = true;
        saveDb();
        
        io.to("wave_" + waveId).emit("wave_members_updated", {
          members: Object.values(db.waves[waveId].members).map(m => ({
            id: m.id, name: m.name, isOwner: m.isOwner || false,
            online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id])
          }))
        });
    }
  });

  socket.on("disconnect", () => {
    const { deviceId, waveId } = socket.data;
    if (deviceId && deviceSockets[deviceId] === socket.id) delete deviceSockets[deviceId];

    if (waveId && db.waves[waveId] && db.waves[waveId].onlineNow && deviceId) {
      delete db.waves[waveId].onlineNow[deviceId];
      saveDb();
      io.to("wave_" + waveId).emit("wave_members_updated", {
        members: Object.values(db.waves[waveId].members || {}).map(m => ({
          id: m.id, name: m.name, isOwner: m.isOwner || false,
          online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id])
        }))
      });
    }
    console.log("❌ غادر:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Radio Connect Server v4.5 على المنفذ ${PORT}`);
  console.log(`📡 LiveKit: ${LIVEKIT_URL ? "✅ مهيّأ" : "❌ غير مهيّأ"}`);
});
