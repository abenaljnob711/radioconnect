"use strict";

/* ==========================================
   Radio Connect - السيرفر الكامل
   Node.js + Express + LiveKit
   ========================================== */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

/* LiveKit SDK */
let AccessToken, RoomServiceClient;
try {
  const lk = require("livekit-server-sdk");
  AccessToken = lk.AccessToken;
  RoomServiceClient = lk.RoomServiceClient;
} catch (e) {
  console.warn("⚠️ livekit-server-sdk غير مثبّت — شغّل: npm install");
}

/* ==========================================
   إعدادات
   ========================================== */
const app = express();
const PORT = process.env.PORT || 3000;

const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";

/* مسار تخزين البيانات */
const DATA_FILE = path.join(__dirname, "rooms.json");

/* Middleware */
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================
   قاعدة بيانات بسيطة (JSON)
   ========================================== */
let db = {
  devices: {},      /* { deviceId: { createdAt } } */
  rooms: {},        /* { roomId: { id, name, owner, createdAt, members[], favorites[] } } */
  favorites: {}     /* { deviceId: [roomId, roomId, ...] } */
};

/* تحميل البيانات */
function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      db.devices = parsed.devices || {};
      db.rooms = parsed.rooms || {};
      db.favorites = parsed.favorites || {};
    }
  } catch (e) {
    console.error("⚠️ تعذر تحميل rooms.json:", e.message);
  }
}

/* حفظ البيانات */
function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("⚠️ تعذر حفظ rooms.json:", e.message);
  }
}

loadDb();

/* ==========================================
   أدوات مساعدة
   ========================================== */
function generateRoomId() {
  return "RAD-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function generateDeviceId() {
  return "dev_" + crypto.randomBytes(8).toString("hex");
}

function now() {
  return Date.now();
}

function getDeviceIdFromReq(req) {
  return req.headers["x-device-id"] || req.query.deviceId || req.body?.deviceId || null;
}

/* ==========================================
   Health check
   ========================================== */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    livekit: !!LIVEKIT_API_KEY,
    rooms: Object.keys(db.rooms).length,
    devices: Object.keys(db.devices).length
  });
});

/* ==========================================
   POST /api/device
   تسجيل جهاز جديد أو استرجاع جهاز موجود
   ========================================== */
app.post("/api/device", (req, res) => {
  try {
    let { deviceId } = req.body || {};

    if (!deviceId || !db.devices[deviceId]) {
      deviceId = deviceId || generateDeviceId();
      db.devices[deviceId] = { createdAt: now() };
      saveDb();
    }

    res.json({
      deviceId,
      createdAt: db.devices[deviceId].createdAt
    });
  } catch (e) {
    console.error("device error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms
   قائمة الغرف (مع حالة المستخدم في كل غرفة)
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
        isOwner: room.owner === deviceId,
        isMember: !!member && member.status === "approved",
        isPending: !!member && member.status === "pending",
        memberCount: approvedCount,
        pendingCount: pendingCount,
        favorite: isFav,
        createdAt: room.createdAt
      };
    });

    /* ترتيب: الغرف الخاصة بالمستخدم أولاً ثم الأحدث */
    roomsList.sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      if (a.isMember !== b.isMember) return a.isMember ? -1 : 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    res.json({ rooms: roomsList });
  } catch (e) {
    console.error("rooms list error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms
   إنشاء غرفة جديدة
   ========================================== */
app.post("/api/rooms", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { name } = req.body || {};

    if (!deviceId) return res.status(401).json({ error: "device_required" });
    if (!name || !name.trim()) return res.status(400).json({ error: "name_required" });

    /* إنشاء ID فريد */
    let roomId = generateRoomId();
    while (db.rooms[roomId]) {
      roomId = generateRoomId();
    }

    const room = {
      id: roomId,
      name: name.trim(),
      owner: deviceId,
      createdAt: now(),
      members: [
        {
          deviceId,
          name: "المسؤول",
          role: "owner",
          status: "approved",
          joinedAt: now()
        }
      ]
    };

    db.rooms[roomId] = room;
    saveDb();

    res.json({
      roomId: room.id,
      room: {
        id: room.id,
        name: room.name,
        isOwner: true,
        isMember: true,
        memberCount: 1
      }
    });
  } catch (e) {
    console.error("create room error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms/:id
   تفاصيل غرفة واحدة
   ========================================== */
app.get("/api/rooms/:id", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });

    const member = room.members.find(m => m.deviceId === deviceId);
    const approvedCount = room.members.filter(m => m.status === "approved").length;

    res.json({
      room: {
        id: room.id,
        name: room.name,
        isOwner: room.owner === deviceId,
        isMember: !!member && member.status === "approved",
        isPending: !!member && member.status === "pending",
        memberCount: approvedCount,
        createdAt: room.createdAt
      }
    });
  } catch (e) {
    console.error("room details error:", e);
    res.status(500).json({ error: "server_error" });
  }
});
/* ==========================================
   POST /api/rooms/:id/join
   طلب الانضمام إلى غرفة
   ========================================== */
app.post("/api/rooms/:id/join", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const { memberName } = req.body || {};
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (!deviceId) return res.status(401).json({ error: "device_required" });

    /* إذا كان العضو موجوداً */
    let member = room.members.find(m => m.deviceId === deviceId);
    if (member) {
      return res.json({
        status: member.status,
        message: member.status === "approved" ? "أنت عضو بالفعل" : "طلبك قيد المراجعة"
      });
    }

    /* إذا كان مالك الغرفة */
    if (room.owner === deviceId) {
      room.members.push({
        deviceId,
        name: memberName || "المسؤول",
        role: "owner",
        status: "approved",
        joinedAt: now()
      });
      saveDb();
      return res.json({ status: "approved", message: "مرحباً بك" });
    }

    /* إضافة طلب انضمام جديد */
    member = {
      deviceId,
      name: (memberName || "عضو جديد").trim().substring(0, 50),
      role: "member",
      status: "pending",
      joinedAt: now()
    };
    room.members.push(member);
    saveDb();

    res.json({
      status: "pending",
      message: "تم إرسال طلب الانضمام للمسؤول"
    });
  } catch (e) {
    console.error("join error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms/:id/status
   حالة طلب الانضمام
   ========================================== */
app.get("/api/rooms/:id/status", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });

    const member = room.members.find(m => m.deviceId === deviceId);
    res.json({
      status: member ? member.status : "none"
    });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms/:id/members
   قائمة أعضاء الغرفة
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

    const members = room.members.map(m => ({
      deviceId: m.deviceId,
      name: m.name,
      role: m.role,
      status: m.status,
      joinedAt: m.joinedAt
    }));

    res.json({ members });
  } catch (e) {
    console.error("members error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/members/:deviceId/approve
   موافقة على عضو
   ========================================== */
app.post("/api/rooms/:id/members/:deviceId/approve", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (room.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    const member = room.members.find(m => m.deviceId === req.params.deviceId);
    if (!member) return res.status(404).json({ error: "member_not_found" });

    member.status = "approved";
    saveDb();

    res.json({ message: "تمت الموافقة على العضو" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/members/:deviceId/reject
   رفض عضو
   ========================================== */
app.post("/api/rooms/:id/members/:deviceId/reject", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (room.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    const idx = room.members.findIndex(m => m.deviceId === req.params.deviceId);
    if (idx === -1) return res.status(404).json({ error: "member_not_found" });

    room.members.splice(idx, 1);
    saveDb();

    res.json({ message: "تم رفض الطلب" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   DELETE /api/rooms/:id/members/:deviceId
   حذف عضو
   ========================================== */
app.delete("/api/rooms/:id/members/:deviceId", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (room.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    const idx = room.members.findIndex(m => m.deviceId === req.params.deviceId);
    if (idx === -1) return res.status(404).json({ error: "member_not_found" });

    if (room.members[idx].role === "owner") {
      return res.status(400).json({ error: "cannot_remove_owner" });
    }

    room.members.splice(idx, 1);
    saveDb();

    res.json({ message: "تم حذف العضو" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/favorite
   تبديل المفضلة لغرفة
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
   قائمة الغرف المفضلة
   ========================================== */
app.get("/api/favorites", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    if (!deviceId) return res.json({ rooms: [] });

    const favIds = db.favorites[deviceId] || [];
    const roomsList = favIds
      .map(id => db.rooms[id])
      .filter(Boolean)
      .map(room => {
        const member = room.members.find(m => m.deviceId === deviceId);
        return {
          id: room.id,
          name: room.name,
          isOwner: room.owner === deviceId,
          isMember: !!member && member.status === "approved",
          memberCount: room.members.filter(m => m.status === "approved").length,
          favorite: true
        };
      });

    res.json({ rooms: roomsList });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   DELETE /api/rooms/:id
   حذف غرفة (المالك فقط)
   ========================================== */
app.delete("/api/rooms/:id", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];

    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (room.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    delete db.rooms[req.params.id];

    /* حذف من المفضلة عند الجميع */
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
   GET /token
   توليد توكن LiveKit لدخول الغرفة
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

    /* التحقق من العضوية */
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
    console.error("token error:", e);
    res.status(500).json({ error: "token_generation_failed" });
  }
});

/* ==========================================
   404 fallback — إرجاع index.html للـ SPA
   ========================================== */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ==========================================
   تشغيل السيرفر
   ========================================== */
app.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log("📡  Radio Connect Server");
  console.log("========================================");
  console.log("✅  يعمل على المنفذ: " + PORT);
  console.log("🔑  LiveKit: " + (LIVEKIT_API_KEY ? "مفعّل ✅" : "غير مُعدّ ❌"));
  console.log("🌐  URL: " + (LIVEKIT_URL || "غير محدد"));
  console.log("📦  عدد الغرف: " + Object.keys(db.rooms).length);
  console.log("========================================");
  console.log("");
});
