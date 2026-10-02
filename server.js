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

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createId(length = 16) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

function generateAdminId() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digit = Math.floor(Math.random() * 10);
  const letter = letters[Math.floor(Math.random() * letters.length)];
  const five = Math.floor(10000 + Math.random() * 90000);
  return `${digit}${letter}${five}`;
}

function createRoomCode() {
  let code;
  do {
    code = "";
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
  } while (Array.from(rooms.values()).some(room => room.code === code));
  return code;
}

function createRoomId() {
  let roomId;
  do {
    roomId = "RAD-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  } while (rooms.has(roomId));
  return roomId;
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
      adminId: generateAdminId(),
      sessionToken: crypto.randomBytes(24).toString("hex"),
      favorites: [],
      createdAt: new Date().toISOString()
    });
  } else {
    const d = devices.get(deviceId);
    if (!d.adminId) d.adminId = generateAdminId();
    if (!d.sessionToken) d.sessionToken = crypto.randomBytes(24).toString("hex");
  }
  return devices.get(deviceId);
}

function findMember(room, deviceId) {
  if (!room ||!deviceId) return null;
  return room.members.find(member => member.deviceId === deviceId);
}

function findMemberByKey(room, memberKey) {
  if (!room ||!memberKey) return null;
  return room.members.find(member => member.memberKey === memberKey);
}

function safeMember(member, requesterDeviceId = null) {
  const isSelf = requesterDeviceId && member.deviceId === requesterDeviceId;
  return {
    memberKey: member.memberKey,
    name: member.name,
    role: member.role,
    status: member.status,
    adminId: isSelf? member.adminId : undefined,
    isSelf:!!isSelf,
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
    roomCode: room.code,
    createdAt: room.createdAt,
    memberCount: room.members.filter(m => m.status === "approved").length,
    pendingCount: room.members.filter(m => m.status === "pending").length,
    isOwner,
    isMember:!!member && member.status === "approved",
    isPending:!!member && member.status === "pending",
    favorite:!!deviceId && devices.get(deviceId)?.favorites?.includes(room.id) === true
  };
}

function findRoomByCode(code) {
  const normalized = cleanText(code, 10).toUpperCase();
  return Array.from(rooms.values()).find(room => room.code === normalized);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/device", (req, res) => {
  let deviceId = getDeviceId(req);
  if (!deviceId) deviceId = "DEV-" + createId(16);
  const device = ensureDevice(deviceId);
  res.json({
    success: true,
    deviceId: device.deviceId,
    adminId: device.adminId,
    sessionToken: device.sessionToken,
    deviceReady: true
  });
});

app.get("/api/account", (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "Device ID required" });
  const device = ensureDevice(deviceId);
  res.json({ deviceId: device.deviceId, adminId: device.adminId });
});

app.post("/api/rooms", (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    const name = cleanText(req.body.name, 60);
    if (!deviceId) return res.status(400).json({ error: "Device ID is required" });
    if (!name) return res.status(400).json({ error: "Room name is required" });
    const device = ensureDevice(deviceId);
    const roomId = createRoomId();
    const roomCode = createRoomCode();
    const ownerMember = {
      memberKey: "M-" + createId(12),
      deviceId,
      adminId: device.adminId,
      name: cleanText(req.body.memberName, 50) || "مسؤول الغرفة",
      role: "owner",
      status: "approved",
      joinedAt: new Date().toISOString()
    };
    const room = { id: roomId, code: roomCode, name, ownerDeviceId: deviceId, createdAt: new Date().toISOString(), members: [ownerMember] };
    rooms.set(roomId, room);
    res.json({ success: true, room: publicRoom(room, deviceId), roomId, roomCode, adminId: device.adminId });
  } catch (error) {
    res.status(500).json({ error: "Failed to create room" });
  }
});

app.get("/api/rooms", (req, res) => {
  const deviceId = getDeviceId(req);
  const result = Array.from(rooms.values()).map(room => publicRoom(room, deviceId));
  res.json({ success: true, rooms: result });
});

app.get("/api/rooms/:roomId", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, room: publicRoom(room, deviceId) });
});

app.post("/api/rooms/join", (req, res) => {
  const deviceId = getDeviceId(req);
  const code = cleanText(req.body.code, 10).toUpperCase();
  const memberName = cleanText(req.body.memberName, 50) || "عضو جديد";
  if (!deviceId) return res.status(400).json({ error: "Device ID is required" });
  if (!code) return res.status(400).json({ error: "Room code is required" });
  const room = findRoomByCode(code);
  if (!room) return res.status(404).json({ error: "رمز الغرفة غير صحيح" });
  const device = ensureDevice(deviceId);
  if (deviceId === room.ownerDeviceId) {
    return res.json({ success: true, status: "approved", roomId: room.id, room: publicRoom(room, deviceId), message: "أنت مشرف هذه الغرفة" });
  }
  let member = findMember(room, deviceId);
  if (member) {
    return res.json({ success: true, status: member.status, roomId: room.id, room: publicRoom(room, deviceId), message: member.status === "approved"? "أنت عضو مقبول بالفعل" : "طلبك بانتظار موافقة المشرف" });
  }
  member = { memberKey: "M-" + createId(12), deviceId, adminId: device.adminId, name: memberName, role: "member", status: "pending", requestedAt: new Date().toISOString() };
  room.members.push(member);
  res.json({ success: true, status: "pending", roomId: room.id, message: "تم إرسال طلب الانضمام لمشرف الغرفة" });
});

app.get("/api/rooms/:roomId/members", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const currentMember = findMember(room, deviceId);
  if (deviceId!== room.ownerDeviceId && (!currentMember || currentMember.status!== "approved")) {
    return res.status(403).json({ error: "Access denied" });
  }
  const device = devices.get(deviceId);
  res.json({ success: true, members: room.members.map(m => safeMember(m, deviceId)), myAdminId: device? device.adminId : null, isOwner: room.ownerDeviceId === deviceId });
});

app.post("/api/rooms/:roomId/members/:memberKey/approve", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const memberKey = cleanText(req.params.memberKey, 100);
  const ownerDeviceId = getDeviceId(req);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.ownerDeviceId!== ownerDeviceId) return res.status(403).json({ error: "Only room owner can approve members" });
  const member = findMemberByKey(room, memberKey);
  if (!member) return res.status(404).json({ error: "Member not found" });
  member.status = "approved";
  member.approvedAt = new Date().toISOString();
  res.json({ success: true, message: "تمت الموافقة على العضو" });
});

app.delete("/api/rooms/:roomId/members/:memberKey", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const memberKey = cleanText(req.params.memberKey, 100);
  const ownerDeviceId = getDeviceId(req);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.ownerDeviceId!== ownerDeviceId) return res.status(403).json({ error: "Only room owner can remove members" });
  const index = room.members.findIndex(m => m.memberKey === memberKey);
  if (index === -1) return res.status(404).json({ error: "Member not found" });
  if (room.members[index].role === "owner") return res.status(400).json({ error: "Cannot remove owner" });
  room.members.splice(index, 1);
  res.json({ success: true, message: "تم إزالة العضو" });
});

app.delete("/api/rooms/:roomId", (req, res) => {
  const roomId = cleanText(req.params.roomId, 64);
  const deviceId = getDeviceId(req);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.ownerDeviceId!== deviceId) return res.status(403).json({ error: "Only room owner can delete the room" });
  rooms.delete(roomId);
  for (const device of devices.values()) {
    device.favorites = device.favorites.filter(id => id!== roomId);
  }
  res.json({ success: true, message: "تم حذف الغرفة" });
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

app.get("/token", async (req, res) => {
  try {
    const identity = cleanText(req.query.identity || "", 64);
    const roomId = cleanText(req.query.room || "", 64);
    const deviceId = cleanText(req.query.deviceId || identity, 100);
    if (!identity ||!roomId) return res.status(400).json({ error: "Identity and Room are required" });
    const room = rooms.get(roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });
    const member = findMember(room, deviceId);
    const isOwner = deviceId === room.ownerDeviceId;
    const isApproved = member && member.status === "approved";
    if (!isOwner &&!isApproved) return res.status(403).json({ error: "You are not approved to join this room" });
    const livekitApiKey = process.env.LIVEKIT_API_KEY || "devkey";
    const livekitApiSecret = process.env.LIVEKIT_API_SECRET || "secret";
    const livekitUrl = process.env.LIVEKIT_URL || "wss://radioconnect-8uyh53qc.livekit.cloud";
    const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity });
    token.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true });
    const jwt = await token.toJwt();
    res.json({ success: true, token: jwt, url: livekitUrl, room: roomId, identity });
  } catch (error) {
    res.status(500).json({ error: "Failed to create LiveKit token" });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "جهاز لاسلكي", rooms: rooms.size, devices: devices.size, uptime: process.uptime(), time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log("=================================");
  console.log("جهاز لاسلكي - Radio Connect");
  console.log(`Server running on port ${PORT}`);
  console.log("AdminID system: ENABLED - 7F53602 format");
  console.log("=================================");
});
