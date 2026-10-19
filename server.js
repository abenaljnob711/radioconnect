"use strict";

/* ==========================================
   Radio Connect Server - v4.4 (Modified for Approval System)
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
  waveRequests: {}, // سيتم استخدام هذا لجلب الطلبات المعلقة
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

function generateWaveId() {
  return generateRadCode();
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
  res.json({ status: "ok", name: "Radio Connect Server", version: "4.4" });
});

app.get("/status", (req, res) => {
  res.json({ status: "ok", waves: Object.keys(db.waves).length, devices: Object.keys(db.devices).length });
});

app.post("/api/users/register", (req, res) => {
  try {
    const { deviceId, userName } = req.body;
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
    }
    res.json({ success: true, deviceId: deviceId, radCode: db.devices[deviceId].radCode, userName: db.devices[deviceId].name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================
   ✅ [جديد] البحث عن موجة/فرقة بالكود وإظهار الاسم
   ========================================== */
app.get("/api/waves/search/:waveCode", (req, res) => {
  const code = req.params.waveCode.toUpperCase();
  const wave = db.waves[code];
  if (!wave) return res.status(404).json({ error: "الفرقة غير موجودة" });

  res.json({
    success: true,
    waveId: wave.id,
    waveName: wave.name, // سيعرض الاسم الحقيقي بدلاً من الكود
    totalMembers: Object.keys(wave.members || {}).length
  });
});

/* ==========================================
   ✅ [جديد] جلب طلبات الانضمام المعلقة (للقائد)
   ========================================== */
app.get("/api/waves/pending-requests/:waveId", (req, res) => {
  const { waveId } = req.params;
  const wave = db.waves[waveId];
  if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });

  // جلب كل الطلبات التي تخص هذه الموجة وحالتها pending
  const pending = Object.values(db.waveRequests).filter(
    req => req.waveId === waveId && req.status === "pending"
  );

  res.json({ success: true, pendingRequests: pending });
});

/* ==========================================
   ✅ [جديد] الموافقة أو الرفض على طلب الانضمام
   ========================================== */
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
      // إضافة العضو للموجة
      if (!wave.members) wave.members = {};
      wave.members[request.fromDeviceId] = {
        id: request.fromDeviceId,
        name: request.fromUserName,
        isOwner: false,
        addedAt: now()
      };
      saveDb();

      // إبلاغ الشخص بالموافقة (عبر Socket)
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

      // تحديث قائمة الأعضاء للجميع
      io.to("wave_" + request.waveId).emit("wave_members_updated", {
        members: Object.values(wave.members).map(m => ({
          id: m.id,
          name: m.name,
          isOwner: m.isOwner || false,
          online: !!(wave.onlineNow && wave.onlineNow[m.id])
        }))
      });
    } else {
      // في حالة الرفض
      const requesterSocketId = deviceSockets[request.fromDeviceId];
      if (requesterSocketId) {
        io.to(requesterSocketId).emit("wave_join_response_received", {
          requestId: request.id,
          waveId: request.waveId,
          accepted: false,
          fromDeviceId: request.fromDeviceId,
          fromUserName: request.fromUserName
        });
      }
    }

    res.json({ success: true, message: action === "approve" ? "تمت الموافقة" : "تم الرفض" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==========================================
   الموجات (Waves / الفرق) - المسارات القديمة
   ========================================== */

app.post("/api/waves/create", (req, res) => {
  try {
    const { deviceId, waveName } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId مطلوب" });

    if (db.devices[deviceId] && db.devices[deviceId].waveId) {
      const existingWaveId = db.devices[deviceId].waveId;
      const existingWave = db.waves[existingWaveId];
      if (existingWave) return res.json({ success: true, waveId: existingWaveId, waveName: existingWave.name, isNew: false });
    }

    let waveId;
    do { waveId = generateWaveId(); } while (db.waves[waveId]);

    db.waves[waveId] = {
      id: waveId,
      name: waveName || "فرقتي",
      ownerDevice: deviceId,
      createdAt: now(),
      members: {},
      onlineNow: {}
    };

    if (!db.devices[deviceId]) db.devices[deviceId] = { id: deviceId, conversations: [] };
    db.devices[deviceId].waveId = waveId;

    db.waves[waveId].members[deviceId] = {
      id: deviceId,
      name: db.devices[deviceId].name || "المالك",
      isOwner: true,
      addedAt: now()
    };

    saveDb();
    res.json({ success: true, waveId: waveId, waveName: db.waves[waveId].name, isNew: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/waves/:waveId", (req, res) => {
  const wave = db.waves[req.params.waveId];
  if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });

  const members = Object.values(wave.members || {}).map(m => ({
    id: m.id,
    name: m.name,
    isOwner: m.isOwner || false,
    online: !!(wave.onlineNow && wave.onlineNow[m.id])
  }));

  res.json({ waveId: wave.id, waveName: wave.name, totalMembers: members.length, members: members, ownerDevice: wave.ownerDevice });
});

/* ==========================================
   Socket.IO — الأحداث الحية (معدلة)
   ========================================== */

io.on("connection", (socket) => {
  console.log("🔌 متصل:", socket.id);

  socket.on("register_device", ({ deviceId, userName }) => {
    if (deviceId) {
      socket.data.deviceId = deviceId;
      socket.data.userName = userName;
      deviceSockets[deviceId] = socket.id;
      // ... (نفس كود التسجيل القديم)
    }
  });

  // ... (باقي أكواد المحادثات والدردشة كما هي) ...

  socket.on("wave_join_request", ({ waveId, fromDeviceId, fromUserName }) => {
    const wave = db.waves[waveId];
    if (!wave) return socket.emit("wave_join_error", { error: "الموجة غير موجودة" });
    if (!wave.ownerDevice) return socket.emit("wave_join_error", { error: "لا يوجد صاحب" });

    // إذا كان عضواً بالفعل
    if (wave.members && wave.members[fromDeviceId]) {
      return socket.emit("wave_join_response_received", {
        waveId: waveId, accepted: true, fromDeviceId: fromDeviceId, fromUserName: fromUserName, direct: true
      });
    }

    // إنشاء طلب جديد وحفظه
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

    // إرسال إشعار للقائد إذا كان متصلاً
    const ownerSocketId = deviceSockets[wave.ownerDevice];
    if (ownerSocketId) {
      io.to(ownerSocketId).emit("wave_join_request_received", {
        requestId,
        waveId,
        fromDeviceId,
        fromUserName,
        toDeviceId: wave.ownerDevice
      });
      socket.emit("wave_join_request_sent", { requestId, waveId });
    } else {
      socket.emit("wave_join_error", { error: "صاحب الموجة غير متصل حالياً" });
    }
  });

  // ... (باقي الأحداث كما هي) ...
});

server.listen(PORT, () => {
  console.log(`🚀 Radio Connect Server v4.4 على المنفذ ${PORT}`);
});
