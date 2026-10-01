const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const devices = new Map();

// الأحرف المستخدمة لتوليد الرمز المكون من 4 خانات
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createId(length = 16) {
  return crypto
    .randomBytes(length)
    .toString("hex")
    .slice(0, length);
}

// توليد رمز غرفة من 4 خانات فريدة
function createRoomCode() {
  let code;
  do {
    code = "";
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
  } while (
    Array.from(rooms.values()).some(
      room => room.code === code
    )
  );
  return code;
}

function createRoomId() {
  let roomId;
  do {
    roomId =
      "RAD-" +
      crypto
        .randomBytes(4)
        .toString("hex")
        .toUpperCase();
  } while (rooms.has(roomId));
  return roomId;
}

function cleanText(value, max = 100) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, max);
}

function getDeviceId(req) {
  const value =
    req.body?.deviceId ||
    req.query?.deviceId ||
    req.headers["x-device-id"];

  return cleanText(value, 100);
}

function ensureDevice(deviceId) {
  if (!deviceId) return null;

  if (!devices.has(deviceId)) {
    devices.set(deviceId, {
      deviceId,
      favorites: [],
      createdAt: new Date().toISOString()
    });
  }

  return devices.get(deviceId);
}

function findMember(room, deviceId) {
  if (!room || !deviceId) return null;

  return room.members.find(
    member => member.deviceId === deviceId
  );
}

function findMemberByKey(room, memberKey) {
  if (!room || !memberKey) return null;

  return room.members.find(
    member => member.memberKey === memberKey
  );
}

function safeMember(member) {
  return {
    memberKey: member.memberKey,
    name: member.name,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt || null,
    requestedAt: member.requestedAt || null,
    approvedAt: member.approvedAt || null
  };
}

function publicRoom(room, deviceId = null) {
  const member = findMember(room, deviceId);
  const isOwner = deviceId === room.ownerDeviceId;

  return {
    id: room.id,
    name: room.name,
    roomCode: room.code, // إظهار الرمز المكون من 4 خانات
    createdAt: room.createdAt,
    memberCount: room.members.filter(m => m.status === "approved").length,
    pendingCount: room.members.filter(m => m.status === "pending").length,
    isOwner,
    isMember: !!member && member.status === "approved",
    isPending: !!member && member.status === "pending",
    favorite: !!deviceId && devices.get(deviceId)?.favorites?.includes(room.id) === true
  };
}

function findRoomByCode(code) {
  const normalized = cleanText(code, 10).toUpperCase();
  return Array.from(rooms.values()).find(
    room => room.code === normalized
  );
}

/* =========================
   الصفحة الرئيسية
========================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
   الجهاز
========================= */

app.post("/api/device", (req, res) => {
  let deviceId = getDeviceId(req);

  if (!deviceId) {
    deviceId = "DEV-" + createId(16);
  }

  ensureDevice(deviceId);

  res.json({
    success: true,
    deviceId,
    deviceReady: true
  });
});

/* =========================
   إنشاء غرفة
========================= */

app.post("/api/rooms", (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    const name = cleanText(req.body.name, 60);

    if (!deviceId) {
      return res.status(400).json({ error: "Device ID is required" });
    }

    if (!name) {
      return res.status(400).json({ error: "Room name is required" });
    }

    ensureDevice(deviceId);

    const roomId = createRoomId();
    const roomCode = createRoomCode(); // 4 خانات

    const ownerMember = {
      memberKey: "M-" + createId(12),
      deviceId,
      name: cleanText(req.body.memberName, 50) || "مسؤول الغرفة",
      role: "owner",
      status: "approved",
      joinedAt: new Date().toISOString()
    };

    const room = {
      id: roomId,
      code: roomCode,
      name,
      ownerDeviceId: deviceId,
      createdAt: new Date().toISOString(),
      members: [ownerMember]
    };

    rooms.set(roomId, room);

    res.json({
      success: true,
      room: publicRoom(room, deviceId),
      roomId,
      roomCode
    });

  } catch (error) {
    console.error("Create room error:", error);
    res.status(500).json({ error: "Failed to create room" });
  }
});

/* =========================
   قائمة الغرف
========================= */

app.get("/api/rooms", (req, res) => {
  const deviceId = getDeviceId(req);
  const result = Array.from(rooms.values()).map(room =>
    publicRoom(room, deviceId)
  );

  res.json({
    success: true,
    rooms: result
  });
});

/* =========================
   غرفة بواسطة ID
========================= */

app.get("/api/rooms/:roomId", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({
    success: true,
    room: publicRoom(room, deviceId)
  });
});

/* =========================
   طلب الانضمام بواسطة الرمز (4 خانات)
========================= */

app.post("/api/rooms/join", (req, res) => {
  const deviceId = getDeviceId(req);
  const code = cleanText(req.body.code, 10).toUpperCase();
  const memberName = cleanText(req.body.memberName, 50) || "عضو جديد";

  if (!deviceId) {
    return res.status(400).json({ error: "Device ID is required" });
  }

  if (!code) {
    return res.status(400).json({ error: "Room code is required" });
  }

  const room = findRoomByCode(code);

  if (!room) {
    return res.status(404).json({ error: "رمز الغرفة غير صحيح" });
  }

  ensureDevice(deviceId);

  if (deviceId === room.ownerDeviceId) {
    return res.json({
      success: true,
      status: "approved",
      roomId: room.id,
      room: publicRoom(room, deviceId),
      message: "أنت مشرف هذه الغرفة"
    });
  }

  let member = findMember(room, deviceId);

  if (member) {
    return res.json({
      success: true,
      status: member.status,
      roomId: room.id,
      room: publicRoom(room, deviceId),
      message: member.status === "approved" ? "أنت عضو مقبول بالفعل" : "طلبك بانتظار موافقة المشرف"
    });
  }

  member = {
    memberKey: "M-" + createId(12),
    deviceId,
    name: memberName,
    role: "member",
    status: "pending",
    requestedAt: new Date().toISOString()
  };

  room.members.push(member);

  res.json({
    success: true,
    status: "pending",
    roomId: room.id,
    message: "تم إرسال طلب الانضمام لمشرف الغرفة"
  });
});

/* =========================
   أعضاء الغرفة
========================= */

app.get("/api/rooms/:roomId/members", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const currentMember = findMember(room, deviceId);

  if (
    deviceId !== room.ownerDeviceId &&
    (!currentMember || currentMember.status !== "approved")
  ) {
    return res.status(403).json({ error: "Access denied" });
  }

  res.json({
    success: true,
    members: room.members.map(safeMember)
  });
});

/* =========================
   الموافقة على عضو
========================= */

app.post("/api/rooms/:roomId/members/:memberKey/approve", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const memberKey = cleanText(req.params.memberKey, 100);
  const ownerDeviceId = getDeviceId(req);

  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (room.ownerDeviceId !== ownerDeviceId) {
    return res.status(403).json({ error: "Only room owner can approve members" });
  }

  const member = findMemberByKey(room, memberKey);

  if (!member) {
    return res.status(404).json({ error: "Member not found" });
  }

  member.status = "approved";
  member.approvedAt = new Date().toISOString();

  res.json({
    success: true,
    message: "تمت الموافقة على العضو"
  });
});

/* =========================
   حذف / رفض عضو
========================= */

app.delete("/api/rooms/:roomId/members/:memberKey", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const memberKey = cleanText(req.params.memberKey, 100);
  const ownerDeviceId = getDeviceId(req);

  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (room.ownerDeviceId !== ownerDeviceId) {
    return res.status(403).json({ error: "Only room owner can remove members" });
  }

  const index = room.members.findIndex(m => m.memberKey === memberKey);

  if (index === -1) {
    return res.status(404).json({ error: "Member not found" });
  }

  if (room.members[index].role === "owner") {
    return res.status(400).json({ error: "Cannot remove owner" });
  }

  room.members.splice(index, 1);

  res.json({
    success: true,
    message: "تم إزالة العضو"
  });
});

/* =========================
   حذف الغرفة
========================= */

app.delete("/api/rooms/:roomId", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);

  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (room.ownerDeviceId !== deviceId) {
    return res.status(403).json({ error: "Only room owner can delete the room" });
  }

  rooms.delete(roomId);

  for (const device of devices.values()) {
    device.favorites = device.favorites.filter(id => id !== roomId);
  }

  res.json({
    success: true,
    message: "تم حذف الغرفة"
  });
});

/* =========================
   المفضلة
========================= */

app.post("/api/rooms/:roomId/favorite", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);

  if (!deviceId) {
    return res.status(400).json({ error: "Device ID is required" });
  }

  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: "Room not found" });
  }

  const device = ensureDevice(deviceId);
  const index = device.favorites.indexOf(roomId);

  if (index === -1) {
    device.favorites.push(roomId);
    return res.json({ success: true, favorite: true });
  }

  device.favorites.splice(index, 1);
  res.json({ success: true, favorite: false });
});

/* =========================
   LiveKit Token
========================= */

app.get("/token", async (req, res) => {
  try {
    const identity = cleanText(req.query.identity || "", 64);
    const roomId = cleanText(req.query.room || "", 64);
    const deviceId = cleanText(req.query.deviceId || identity, 100);

    if (!identity || !roomId) {
      return res.status(400).json({ error: "Identity and Room are required" });
    }

    const room = rooms.get(roomId);

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const member = findMember(room, deviceId);
    const isOwner = deviceId === room.ownerDeviceId;
    const isApproved = member && member.status === "approved";

    if (!isOwner && !isApproved) {
      return res.status(403).json({ error: "You are not approved to join this room" });
    }

    const livekitApiKey = process.env.LIVEKIT_API_KEY || "devkey";
    const livekitApiSecret = process.env.LIVEKIT_API_SECRET || "secret";
    const livekitUrl = process.env.LIVEKIT_URL || "wss://radioconnect-8uyh53qc.livekit.cloud";

    const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity });

    token.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true
    });

    const jwt = await token.toJwt();

    res.json({
      success: true,
      token: jwt,
      url: livekitUrl,
      room: roomId,
      identity
    });

  } catch (error) {
    console.error("Token error:", error);
    res.status(500).json({ error: "Failed to create LiveKit token" });
  }
});

/* =========================
   Health
========================= */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "جهاز لاسلكي",
    rooms: rooms.size,
    uptime: process.uptime(),
    time: new Date().toISOString()
  });
});

/* =========================
   تشغيل الخادم
========================= */

app.listen(PORT, () => {
  console.log("=================================");
  console.log("جهاز لاسلكي - Radio Connect");
  console.log(`Server running on port ${PORT}`);
  console.log("=================================");
});
