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

function createId(length = 16) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

function generateUserAdminCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const nums = "0123456789";
  const prefix = chars[Math.floor(Math.random() * chars.length)] + chars[Math.floor(Math.random() * chars.length)];
  let digits = "";
  for (let i = 0; i < 5; i++) {
    digits += nums[Math.floor(Math.random() * nums.length)];
  }
  return prefix + digits;
}

function cleanText(value, max = 100) {
  return String(value || "").trim().replace(/[<>]/g, "").slice(0, max);
}

function getDeviceId(req) {
  const value = req.body?.deviceId || req.query?.deviceId || req.headers["x-device-id"];
  return cleanText(value, 100);
}

function ensureDevice(deviceId) {
  if (!deviceId) return null;
  if (!devices.has(deviceId)) {
    devices.set(deviceId, {
      deviceId,
      adminCode: generateUserAdminCode(),
      favorites: [],
      createdAt: new Date().toISOString()
    });
  }
  return devices.get(deviceId);
}

function findMember(room, deviceId) {
  if (!room || !deviceId) return null;
  return room.members.find(member => member.deviceId === deviceId);
}

function findMemberByKey(room, memberKey) {
  if (!room || !memberKey) return null;
  return room.members.find(member => member.memberKey === memberKey);
}

function isUserAdminOrOwner(room, deviceId) {
  if (!room || !deviceId) return false;
  const member = findMember(room, deviceId);
  return member && member.status === "approved" && (member.role === "owner" || member.role === "admin");
}

function safeMember(member, isRequesterAdmin) {
  const isMemberAdmin = member.role === "owner" || member.role === "admin";
  return {
    memberKey: member.memberKey,
    name: member.name,
    role: member.role,
    status: member.status,
    adminCode: isMemberAdmin ? member.adminCode : null,
    joinedAt: member.joinedAt || null,
    requestedAt: member.requestedAt || null,
    approvedAt: member.approvedAt || null
  };
}

function publicRoom(room, deviceId = null) {
  const member = findMember(room, deviceId);
  const isAdmin = isUserAdminOrOwner(room, deviceId);
  const userDev = ensureDevice(deviceId);

  return {
    id: room.id,
    name: room.name,
    roomCode: isAdmin ? room.code : null,
    adminCode: (isAdmin && userDev) ? userDev.adminCode : null,
    createdAt: room.createdAt,
    memberCount: room.members.filter(m => m.status === "approved").length,
    pendingCount: room.members.filter(m => m.status === "pending").length,
    isOwner: member?.role === "owner",
    isAdmin: isAdmin,
    isMember: !!member && member.status === "approved",
    isPending: !!member && member.status === "pending",
    favorite: !!deviceId && userDev?.favorites?.includes(room.id) === true
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/device", (req, res) => {
  let deviceId = getDeviceId(req);
  if (!deviceId) {
    deviceId = "DEV-" + createId(16);
  }
  const device = ensureDevice(deviceId);

  res.json({
    success: true,
    deviceId: device.deviceId,
    deviceReady: true
  });
});

app.post("/api/rooms", (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    const name = cleanText(req.body.name, 60);

    if (!deviceId) return res.status(400).json({ error: "Device ID required" });
    if (!name) return res.status(400).json({ error: "Room name required" });

    const device = ensureDevice(deviceId);
    const roomId = "RAD-" + createId(8).toUpperCase();
    const roomCode = createId(6).toUpperCase();

    const ownerMember = {
      memberKey: "M-" + createId(12),
      deviceId,
      adminCode: device.adminCode,
      name: cleanText(req.body.memberName, 50) || "مالك الغرفة",
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
      adminCode: device.adminCode
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to create room" });
  }
});

app.get("/api/rooms", (req, res) => {
  const deviceId = getDeviceId(req);
  const result = Array.from(rooms.values()).map(room => publicRoom(room, deviceId));
  res.json({ success: true, rooms: result });
});

app.delete("/api/rooms/:roomId", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);

  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.ownerDeviceId !== deviceId) {
    return res.status(403).json({ error: "مالك الغرفة الأصلي فقط هو من يستطيع حذف الغرفة" });
  }

  rooms.delete(roomId);

  for (const device of devices.values()) {
    device.favorites = device.favorites.filter(id => id !== roomId);
  }

  res.json({ success: true, message: "تم حذف الغرفة بنجاح" });
});

app.post("/api/rooms/join", (req, res) => {
  const deviceId = getDeviceId(req);
  const code = cleanText(req.body.code, 20).toUpperCase();
  const inputAdminCode = cleanText(req.body.adminCode, 20).toUpperCase();
  const memberName = cleanText(req.body.memberName, 50) || "عضو جديد";

  if (!deviceId) return res.status(400).json({ error: "Device ID required" });

  const device = ensureDevice(deviceId);
  let room = Array.from(rooms.values()).find(r => r.code === code);

  if (!room && inputAdminCode) {
    room = Array.from(rooms.values()).find(r => {
      return r.members.some(m => (m.role === "owner" || m.role === "admin") && m.adminCode === inputAdminCode);
    });
  }

  if (!room) {
    return res.status(404).json({ error: "رمز الغرفة أو رقم التعريف غير صحيح" });
  }

  if (isUserAdminOrOwner(room, deviceId)) {
    return res.json({
      success: true,
      status: "approved",
      roomId: room.id,
      message: "مرحباً بك، أنت محدد كـ " + (findMember(room, deviceId)?.role === "owner" ? "مالك" : "مشرف")
    });
  }

  let member = findMember(room, deviceId);
  if (member) {
    return res.json({
      success: true,
      status: member.status,
      roomId: room.id,
      message: member.status === "approved" ? "أنت عضو مقبول بالفعل" : "طلبك بانتظار موافقة المشرفين"
    });
  }

  member = {
    memberKey: "M-" + createId(12),
    deviceId,
    adminCode: device.adminCode,
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
    message: "تم إرسال طلب الانضمام للمشرفين كعضو"
  });
});

app.get("/api/rooms/:roomId/members", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);

  if (!room) return res.status(404).json({ error: "Room not found" });

  const currentMember = findMember(room, deviceId);
  const isAdmin = isUserAdminOrOwner(room, deviceId);

  if (!isAdmin && (!currentMember || currentMember.status !== "approved")) {
    return res.status(403).json({ error: "Access denied" });
  }

  res.json({
    success: true,
    members: room.members.map(m => safeMember(m, isAdmin))
  });
});

app.post("/api/rooms/:roomId/members/:memberKey/role", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const memberKey = cleanText(req.params.memberKey, 100);
  const deviceId = getDeviceId(req);
  const { newRole } = req.body;

  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (!isUserAdminOrOwner(room, deviceId)) {
    return res.status(403).json({ error: "هذه الخدمة متاحة للمشرفين والمالك فقط" });
  }

  const member = findMemberByKey(room, memberKey);
  if (!member) return res.status(404).json({ error: "Member not found" });

  if (member.role === "owner") {
    return res.status(400).json({ error: "لا يمكن تعديل صلاحيات مالك الغرفة الأصلي" });
  }

  member.role = newRole === "admin" ? "admin" : "member";

  res.json({
    success: true,
    message: member.role === "admin" ? "تمت ترقية العضو إلى مشرف" : "تم سحب صلاحية الإشراف من العضو"
  });
});

app.post("/api/rooms/:roomId/members/:memberKey/approve", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const memberKey = cleanText(req.params.memberKey, 100);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);

  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!isUserAdminOrOwner(room, deviceId)) {
    return res.status(403).json({ error: "هذه الخدمة متاحة للمشرفين فقط" });
  }

  const member = findMemberByKey(room, memberKey);
  if (!member) return res.status(404).json({ error: "Member not found" });

  member.status = "approved";
  member.approvedAt = new Date().toISOString();

  res.json({ success: true, message: "تمت الموافقة على العضو" });
});

app.delete("/api/rooms/:roomId/members/:memberKey", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const memberKey = cleanText(req.params.memberKey, 100);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);

  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!isUserAdminOrOwner(room, deviceId)) {
    return res.status(403).json({ error: "هذه الخدمة متاحة للمشرفين فقط" });
  }

  const member = findMemberByKey(room, memberKey);
  if (!member) return res.status(404).json({ error: "Member not found" });

  if (member.role === "owner") {
    return res.status(400).json({ error: "لا يمكن حذف مالك الغرفة الأصلي" });
  }

  const index = room.members.findIndex(m => m.memberKey === memberKey);
  room.members.splice(index, 1);

  res.json({ success: true, message: "تم حذف العضو من الغرفة" });
});

app.post("/api/rooms/:roomId/favorite", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);

  if (!deviceId) return res.status(400).json({ error: "Device ID is required" });
  if (!rooms.has(roomId)) return res.status(404).json({ error: "Room not found" });

  const device = ensureDevice(deviceId);
  const index = device.favorites.indexOf(roomId);

  if (index === -1) {
    device.favorites.push(roomId);
    return res.json({ success: true, favorite: true });
  }

  device.favorites.splice(index, 1);
  res.json({ success: true, favorite: false });
});

app.get("/api/favorites", (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "Device ID is required" });

  const device = devices.get(deviceId);
  if (!device) return res.json({ success: true, rooms: [] });

  const favoriteRooms = device.favorites
    .map(roomId => rooms.get(roomId))
    .filter(Boolean)
    .map(room => publicRoom(room, deviceId));

  res.json({ success: true, rooms: favoriteRooms });
});

/* =========================
   LiveKit Token Generator
========================= */

app.get("/token", async (req, res) => {
  try {
    const identity = cleanText(req.query.identity || "", 64);
    const roomId = cleanText(req.query.room || "", 64);
    const reqDeviceId = cleanText(req.query.deviceId || identity, 100);

    if (!identity || !roomId) {
      return res.status(400).json({ error: "Identity and Room required" });
    }

    const room = rooms.get(roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });

    const member = findMember(room, reqDeviceId);
    const isAdmin = isUserAdminOrOwner(room, reqDeviceId);
    const isApproved = member && member.status === "approved";

    if (!isAdmin && !isApproved) {
      return res.status(403).json({ error: "غير مصرح لك بالدخول لهذه الغرفة" });
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
    res.json({ success: true, token: jwt, url: livekitUrl, room: roomId, identity });
  } catch (error) {
    res.status(500).json({ error: "Failed to create LiveKit token" });
  }
});

app.listen(PORT, () => {
  console.log("=================================");
  console.log("جهاز لاسلكي - Radio Connect");
  console.log(`Server running on port ${PORT}`);
  console.log("=================================");
});
