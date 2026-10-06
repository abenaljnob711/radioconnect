"use strict";

/* ==========================================
   Radio Connect - السيرفر الكامل
   مع نظام الأرقام الشخصية الثابتة
   ========================================== */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";

const DATA_FILE = path.join(__dirname, "rooms.json");

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================
   قاعدة البيانات البسيطة
   ========================================== */
let db = {
  devices: {},   // { deviceId: { createdAt } }
  rooms: {}      // { roomId: { id, name, owner, members[], createdAt } }
};

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      db.devices = parsed.devices || {};
      db.rooms = parsed.rooms || {};
    }
  } catch (e) { console.error("loadDb error:", e.message); }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (e) { console.error("saveDb error:", e.message); }
}

loadDb();

/* ==========================================
   أدوات عامة
   ========================================== */
function generateDeviceId() {
  return "dev_" + crypto.randomBytes(8).toString("hex");
}

function generateRoomId() {
  return "RAD-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

/**
 * يولّد رقماً شخصياً من 6 خانات (hex)
 * يُستخدم مرة واحدة لكل عضو — لا يتغير أبداً
 */
function generatePersonalCode() {
  let code;
  let attempts = 0;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 خانات
    attempts++;
  } while (isCodeTaken(code) && attempts < 100);
  return code;
}

/**
 * هل الرقم مستخدم في أي غرفة؟
 */
function isCodeTaken(code) {
  for (const room of Object.values(db.rooms)) {
    for (const m of room.members || []) {
      if (m.personalCode === code) return true;
    }
  }
  return false;
}

function getDeviceIdFromReq(req) {
  return req.headers["x-device-id"] || req.query.deviceId || req.body?.deviceId || null;
}

function now() { return Date.now(); }

/* ==========================================
   Health
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
   تسجيل جهاز جديد
   ========================================== */
app.post("/api/device", (req, res) => {
  try {
    let { deviceId } = req.body || {};
    if (!deviceId || !db.devices[deviceId]) {
      deviceId = deviceId || generateDeviceId();
      db.devices[deviceId] = { createdAt: now() };
      saveDb();
    }
    res.json({ deviceId, createdAt: db.devices[deviceId].createdAt });
  } catch (e) {
    console.error("device error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms
   قائمة الغرف (مع حالة المستخدم)
   ========================================== */
app.get("/api/rooms", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const roomsList = Object.values(db.rooms).map(room => {
      const member = (room.members || []).find(m => m.deviceId === deviceId);
      const approved = (room.members || []).filter(m => m.status === "approved").length;

      return {
        id: room.id,
        name: room.name,
        isOwner: room.owner === deviceId,
        isMember: !!member && member.status === "approved",
        isAdmin: !!member && member.role === "admin" && member.status === "approved",
        role: member?.role || null,
        memberCount: approved,
        // ⚠️ لا نُرسل الرقم الشخصي هنا إطلاقاً
        createdAt: room.createdAt
      };
    });

    roomsList.sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
      if (a.isMember !== b.isMember) return a.isMember ? -1 : 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    res.json({ rooms: roomsList });
  } catch (e) {
    console.error("rooms error:", e);
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

    let roomId = generateRoomId();
    while (db.rooms[roomId]) roomId = generateRoomId();

    const ownerPersonalCode = generatePersonalCode();

    const room = {
      id: roomId,
      name: name.trim(),
      owner: deviceId,
      createdAt: now(),
      members: [{
        deviceId,
        name: "المالك",
        role: "owner",
        status: "approved",
        personalCode: ownerPersonalCode,   // رقم شخصي ثابت
        isCodeVisible: true,               // المالك يرى رقمه
        invitedBy: null,
        invitedMembers: [],
        joinedAt: now()
      }]
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
        isAdmin: false,
        role: "owner",
        memberCount: 1,
        personalCode: ownerPersonalCode  // يُرسل فقط للمالك
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

    const member = (room.members || []).find(m => m.deviceId === deviceId);
    const approved = (room.members || []).filter(m => m.status === "approved").length;

    const canSeeCode = member && (member.role === "owner" || member.role === "admin");

    res.json({
      room: {
        id: room.id,
        name: room.name,
        isOwner: room.owner === deviceId,
        isMember: !!member && member.status === "approved",
        isAdmin: !!member && member.role === "admin" && member.status === "approved",
        role: member?.role || null,
        memberCount: approved,
        // ⚠️ الرقم الشخصي يُرسل فقط إذا كان مشرفاً أو مالكاً
        personalCode: canSeeCode ? member.personalCode : null
      }
    });
  } catch (e) {
    console.error("room details error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/join-by-code
   الانضمام لغرفة عن طريق رقم مشرف/مالك
   ========================================== */
app.post("/api/rooms/join-by-code", (req, res) => {
  try {
    const newMemberId = getDeviceIdFromReq(req);
    const { code, memberName } = req.body || {};

    if (!newMemberId) return res.status(401).json({ error: "device_required" });
    if (!code || !code.trim()) return res.status(400).json({ error: "code_required" });
    if (!memberName || !memberName.trim()) return res.status(400).json({ error: "name_required" });

    const cleanCode = code.trim().toUpperCase();

    // ابحث عن الغرفة التي فيها عضو بهذا الرقم (مشرف أو مالك)
    let targetRoom = null;
    let inviter = null;

    for (const room of Object.values(db.rooms)) {
      const m = (room.members || []).find(
        mem => mem.personalCode === cleanCode &&
               (mem.role === "owner" || mem.role === "admin") &&
               mem.status === "approved"
      );
      if (m) {
        targetRoom = room;
        inviter = m;
        break;
      }
    }

    if (!targetRoom) {
      return res.status(404).json({ error: "invalid_code" });
    }

    // هل المستخدم عضو بالفعل؟
    const existing = (targetRoom.members || []).find(m => m.deviceId === newMemberId);
    if (existing) {
      return res.json({
        status: existing.status,
        roomId: targetRoom.id,
        message: "أنت بالفعل في هذه الغرفة"
      });
    }

    // رقم شخصي جديد للعضو (سري!)
    const newPersonalCode = generatePersonalCode();

    const newMember = {
      deviceId: newMemberId,
      name: memberName.trim().substring(0, 40),
      role: "member",
      status: "approved",              // مباشرة — لا حاجة لموافقة
      personalCode: newPersonalCode,   // مخفي عن العضو
      isCodeVisible: false,
      invitedBy: inviter.deviceId,     // من ضمّه
      invitedByCode: cleanCode,
      invitedMembers: [],
      joinedAt: now()
    };

    targetRoom.members.push(newMember);

    // سجل المضمومين عند المشرف/المالك
    if (!inviter.invitedMembers) inviter.invitedMembers = [];
    inviter.invitedMembers.push(newMemberId);

    saveDb();

    res.json({
      status: "approved",
      roomId: targetRoom.id,
      roomName: targetRoom.name,
      message: "تم الانضمام بنجاح ✅"
    });
  } catch (e) {
    console.error("join-by-code error:", e);
    res.status(500).json({ error: "server_error" });
  }
});
/* ==========================================
   GET /api/rooms/:id/members
   قائمة الأعضاء (مع الرقم فقط للمشرف/المالك)
   ========================================== */
app.get("/api/rooms/:id/members", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });

    const requester = (room.members || []).find(m => m.deviceId === deviceId);
    if (!requester || requester.status !== "approved") {
      return res.status(403).json({ error: "not_a_member" });
    }

    const canSeeCodes = requester.role === "owner" || requester.role === "admin";

    const members = (room.members || []).map(m => ({
      deviceId: m.deviceId,
      name: m.name,
      role: m.role,
      status: m.status,
      joinedAt: m.joinedAt,
      invitedBy: m.invitedBy,
      // ⚠️ الرقم يُرسَل فقط للمشرف/المالك (وللشخص نفسه إن كان مشرفاً)
      personalCode: canSeeCodes || m.deviceId === deviceId
        ? (m.isCodeVisible ? m.personalCode : null)
        : null,
      isCodeVisible: m.isCodeVisible
    }));

    res.json({
      members,
      myRole: requester.role,
      canSeeCodes
    });
  } catch (e) {
    console.error("members error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /api/rooms/:id/my-code
   الرقم الشخصي الحالي (يُرسَل فقط إن كان مرئياً)
   ========================================== */
app.get("/api/rooms/:id/my-code", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });

    const member = (room.members || []).find(m => m.deviceId === deviceId);
    if (!member) return res.status(404).json({ error: "not_a_member" });

    const canSee = member.role === "owner" || member.role === "admin";

    res.json({
      personalCode: canSee ? member.personalCode : null,
      isVisible: canSee,
      role: member.role
    });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/promote
   ترقية عضو إلى مشرف (المالك فقط)
   ========================================== */
app.post("/api/rooms/:id/promote", (req, res) => {
  try {
    const requesterId = getDeviceIdFromReq(req);
    const { targetDeviceId } = req.body || {};
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });

    // التحقق: الطالب هو المالك
    if (room.owner !== requesterId) {
      return res.status(403).json({ error: "owner_only" });
    }

    const target = (room.members || []).find(m => m.deviceId === targetDeviceId);
    if (!target) return res.status(404).json({ error: "member_not_found" });
    if (target.role === "owner") return res.status(400).json({ error: "cannot_promote_owner" });
    if (target.role === "admin") return res.status(400).json({ error: "already_admin" });

    // ترقية
    target.role = "admin";
    target.isCodeVisible = true;
    target.promotedAt = now();
    saveDb();

    res.json({
      message: "تم الترقية بنجاح 🎉",
      personalCode: target.personalCode,  // يُرسل لصاحب الرقم فقط
      member: {
        deviceId: target.deviceId,
        name: target.name,
        role: target.role,
        isCodeVisible: true
      }
    });
  } catch (e) {
    console.error("promote error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   POST /api/rooms/:id/demote
   سحب الإشراف (المالك فقط)
   ========================================== */
app.post("/api/rooms/:id/demote", (req, res) => {
  try {
    const requesterId = getDeviceIdFromReq(req);
    const { targetDeviceId } = req.body || {};
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });

    // التحقق: الطالب هو المالك
    if (room.owner !== requesterId) {
      return res.status(403).json({ error: "owner_only" });
    }

    const target = (room.members || []).find(m => m.deviceId === targetDeviceId);
    if (!target) return res.status(404).json({ error: "member_not_found" });
    if (target.role === "owner") return res.status(400).json({ error: "cannot_demote_owner" });
    if (target.role !== "admin") return res.status(400).json({ error: "not_admin" });

    // سحب الإشراف — الرقم يبقى محفوظاً لكن يُخفى
    target.role = "member";
    target.isCodeVisible = false;   // ⚠️ نُخفي الرقم فقط، لا نحذفه
    target.demotedAt = now();
    saveDb();

    res.json({
      message: "تم سحب الإشراف — الأعضاء الذين ضمّهم يبقون في الغرفة",
      member: {
        deviceId: target.deviceId,
        name: target.name,
        role: target.role,
        isCodeVisible: false
      }
    });
  } catch (e) {
    console.error("demote error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   DELETE /api/rooms/:id/members/:deviceId
   حذف/طرد عضو (المالك فقط، أو المشرف لأعضاء ضمّهم)
   ========================================== */
app.delete("/api/rooms/:id/members/:deviceId", (req, res) => {
  try {
    const requesterId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });

    const requester = (room.members || []).find(m => m.deviceId === requesterId);
    if (!requester) return res.status(403).json({ error: "not_a_member" });

    const targetId = req.params.deviceId;
    const target = (room.members || []).find(m => m.deviceId === targetId);
    if (!target) return res.status(404).json({ error: "member_not_found" });

    if (target.role === "owner") {
      return res.status(400).json({ error: "cannot_remove_owner" });
    }

    const isOwner = requester.role === "owner";
    const isAdminWhoInvited = requester.role === "admin" && target.invitedBy === requesterId;

    if (!isOwner && !isAdminWhoInvited) {
      return res.status(403).json({ error: "no_permission" });
    }

    // حذف العضو
    const idx = room.members.findIndex(m => m.deviceId === targetId);
    room.members.splice(idx, 1);

    // إزالة من قائمة invitedMembers عند من ضمّه
    const inviter = room.members.find(m => m.deviceId === target.invitedBy);
    if (inviter && inviter.invitedMembers) {
      inviter.invitedMembers = inviter.invitedMembers.filter(id => id !== targetId);
    }

    saveDb();
    res.json({ message: "تم حذف العضو" });
  } catch (e) {
    console.error("remove member error:", e);
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   DELETE /api/rooms/:id
   حذف الغرفة (المالك فقط)
   ========================================== */
app.delete("/api/rooms/:id", (req, res) => {
  try {
    const deviceId = getDeviceIdFromReq(req);
    const room = db.rooms[req.params.id];
    if (!room) return res.status(404).json({ error: "room_not_found" });
    if (room.owner !== deviceId) return res.status(403).json({ error: "owner_only" });

    delete db.rooms[req.params.id];
    saveDb();
    res.json({ message: "تم حذف الغرفة" });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
});

/* ==========================================
   GET /token
   توكن LiveKit
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
      const member = (room.members || []).find(m => m.deviceId === deviceId);
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
   404 fallback — SPA
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
  console.log("📦  عدد الغرف: " + Object.keys(db.rooms).length);
  console.log("========================================");
  console.log("");
});
