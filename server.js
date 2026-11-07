"use strict";

const exp = require('e'+'xpress');
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
  console.warn("livekit غير مثبّت");
}

const app = exp();
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
app.use(exp.json({ limit: "10mb" }));
app.use(exp.static(path.join(__dirname, "public")));
app.use(exp.static(__dirname));

let db = { devices: {}, waves: {}, waveRequests: {}, conversations: {}, messages: {}, friendRequests: {}, friendships: {}, rooms: {} };

function generateRadCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "R";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function generateWaveId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "T";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "R";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function generateConversationId(devA, devB) {
  const sorted = [devA, devB].sort();
  return "conv_" + crypto.createHash('md5').update(sorted.join('_')).digest('hex').substring(0, 16);
}
function now() { return Date.now(); }

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
      db.friendRequests = parsed.friendRequests || {};
      db.friendships = parsed.friendships || {};
      db.rooms = parsed.rooms || {};
      for (const code of Object.keys(db.rooms)) {
        if (!db.rooms[code].members) db.rooms[code].members = {};
        if (db.rooms[code].deviceId) db.rooms[code].members[db.rooms[code].deviceId] = { id: db.rooms[code].deviceId, joinedAt: db.rooms[code].createdAt || now() };
      }
    }
  } catch (e) { console.error("خطأ تحميل:", e.message); }
}
function saveDb() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error("خطأ حفظ:", e.message); }
}
loadDb();

app.get("/", (req, res) => {
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send("Not Found");
});

app.get("/api/friends/requests/:deviceId", (req, res) => {
  try {
    const requests = Object.values(db.friendRequests).filter(r => r.toDeviceId === req.params.deviceId && r.status === "pending");
    res.json({ requests: requests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/status", (req, res) => {
  res.json({ status: "ok", name: "Radio Connect Server", version: "4.6", livekit: LIVEKIT_URL ? "configured" : "not configured", uptime: process.uptime(), waves: Object.keys(db.waves).length, rooms: Object.keys(db.rooms).length, devices: Object.keys(db.devices).length });
});

app.post("/api/users/register", (req, res) => {
  try {
    const { deviceId, userName } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId مطلوب" });
    if (!db.devices[deviceId]) {
      db.devices[deviceId] = { id: deviceId, name: userName || "مستخدم", radCode: generateRadCode(), waveId: null, conversations: [], createdAt: now() };
      saveDb();
    } else {
      if (userName) db.devices[deviceId].name = userName;
      if (!db.devices[deviceId].radCode || db.devices[deviceId].radCode.startsWith("RAD-")) { db.devices[deviceId].radCode = generateRadCode(); saveDb(); }
    }
    res.json({ success: true, deviceId: deviceId, radCode: db.devices[deviceId].radCode, userName: db.devices[deviceId].name, waveId: db.devices[deviceId].waveId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/users/search/:radCode", (req, res) => {
  const code = req.params.radCode.toUpperCase();
  const user = Object.values(db.devices).find(u => u.radCode === code);
  if (!user) return res.status(404).json({ error: "لا يوجد مستخدم بهذا الرقم" });
  res.json({ deviceId: user.id, userName: user.name, radCode: user.radCode, waveId: user.waveId });
});

app.post("/api/rooms/create", (req, res) => {
  try {
    const { deviceId, roomCode, roomName } = req.body;
    if (!deviceId || !roomCode) return res.status(400).json({ error: "بيانات ناقصة" });
    if (!db.rooms) db.rooms = {};
    const code = roomCode.toUpperCase();
    if (db.rooms[code]) {
      if (!db.rooms[code].members) db.rooms[code].members = {};
      db.rooms[code].members[deviceId] = { id: deviceId, joinedAt: now() };
      saveDb();
      return res.json({ success: true, roomCode: code, roomName: db.rooms[code].name });
    }
    db.rooms[code] = { code: code, name: roomName || "غرفة بدون اسم", deviceId: deviceId, createdAt: now(), members: { [deviceId]: { id: deviceId, joinedAt: now() } } };
    saveDb();
    res.json({ success: true, roomCode: code, roomName: db.rooms[code].name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/rooms/join", (req, res) => {
  try {
    const { deviceId, roomCode } = req.body;
    if (!deviceId || !roomCode) return res.status(400).json({ error: "بيانات ناقصة" });
    const room = db.rooms ? db.rooms[roomCode.toUpperCase()] : null;
    if (!room) return res.status(404).json({ error: "لا توجد غرفة بهذا الرقم" });
    if (!room.members) room.members = {};
    room.members[deviceId] = { id: deviceId, joinedAt: now() };
    saveDb();
    res.json({ success: true, roomCode: room.code, roomName: room.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/rooms/leave", (req, res) => {
  try {
    const { deviceId, roomCode } = req.body;
    const room = db.rooms ? db.rooms[roomCode.toUpperCase()] : null;
    if (!room) return res.json({ success: true });
    if (room.members && room.members[deviceId]) delete room.members[deviceId];
    saveDb();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/rooms/delete", (req, res) => {
  try {
    const { roomCode, deviceId } = req.body;
    const code = roomCode.toUpperCase();
    if (db.rooms && db.rooms[code]) {
      if (db.rooms[code].deviceId === deviceId) { delete db.rooms[code]; saveDb(); res.json({ success: true }); }
      else res.status(403).json({ error: "غير مصرح" });
    } else res.status(404).json({ error: "الغرفة غير موجودة" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/rooms/search/:roomCode", (req, res) => {
  const code = req.params.roomCode.toUpperCase();
  const room = db.rooms ? db.rooms[code] : null;
  if (!room) return res.status(404).json({ error: "لا توجد غرفة" });
  res.json({ roomCode: room.code, roomName: room.name, deviceId: room.deviceId, membersCount: Object.keys(room.members || {}).length });
});

app.get("/api/rooms/my/:deviceId", (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const myRooms = Object.values(db.rooms || {}).filter(r => (r.members && r.members[deviceId]) || r.deviceId === deviceId);
    res.json({ rooms: myRooms.map(r => ({ roomCode: r.code, roomName: r.name, deviceId: r.deviceId, membersCount: Object.keys(r.members || {}).length })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/conversations/start", (req, res) => {
  try {
    const { myDeviceId, otherDeviceId } = req.body;
    if (!myDeviceId || !otherDeviceId) return res.status(400).json({ error: "بيانات ناقصة" });
    if (!db.devices[myDeviceId]) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (!db.devices[otherDeviceId]) return res.status(404).json({ error: "المستخدم الآخر غير موجود" });
    const convId = generateConversationId(myDeviceId, otherDeviceId);
    if (!db.conversations[convId]) {
      db.conversations[convId] = { id: convId, participants: [myDeviceId, otherDeviceId], createdAt: now(), lastMessageAt: now() };
      db.messages[convId] = [];
      if (!db.devices[myDeviceId].conversations) db.devices[myDeviceId].conversations = [];
      if (!db.devices[otherDeviceId].conversations) db.devices[otherDeviceId].conversations = [];
      if (!db.devices[myDeviceId].conversations.includes(convId)) db.devices[myDeviceId].conversations.push(convId);
      if (!db.devices[otherDeviceId].conversations.includes(convId)) db.devices[otherDeviceId].conversations.push(convId);
      saveDb();
    }
    res.json({ success: true, conversationId: convId, otherUser: { deviceId: otherDeviceId, userName: db.devices[otherDeviceId].name, radCode: db.devices[otherDeviceId].radCode } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/conversations/list/:deviceId", (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const user = db.devices[deviceId];
    if (!user) return res.json({ conversations: [] });
    const convList = (user.conversations || []).map(convId => {
      const conv = db.conversations[convId];
      if (!conv) return null;
      const otherId = conv.participants.find(p => p !== deviceId);
      const other = db.devices[otherId];
      const messages = db.messages[convId] || [];
      const lastMsg = messages[messages.length - 1];
      return { conversationId: convId, otherUser: { deviceId: otherId, userName: other ? other.name : "مستخدم", radCode: other ? other.radCode : "—" }, lastMessage: lastMsg ? { text: lastMsg.type === 'voice' ? 'رسالة صوتية' : lastMsg.type === 'image' ? 'صورة' : lastMsg.type === 'video' ? 'فيديو' : (lastMsg.text || ''), time: lastMsg.time, sender: lastMsg.sender } : null, lastMessageAt: conv.lastMessageAt || conv.createdAt };
    }).filter(c => c !== null);
    convList.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    res.json({ conversations: convList });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/conversations/:convId/messages", (req, res) => {
  try { res.json({ messages: db.messages[req.params.convId] || [] }); } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    db.waves[waveId] = { id: waveId, name: waveName || "فرقتي", ownerDevice: deviceId, createdAt: now(), members: {}, onlineNow: {} };
    if (!db.devices[deviceId]) db.devices[deviceId] = { id: deviceId, conversations: [] };
    db.devices[deviceId].waveId = waveId;
    db.waves[waveId].members[deviceId] = { id: deviceId, name: db.devices[deviceId].name || "المالك", isOwner: true, addedAt: now() };
    saveDb();
    res.json({ success: true, waveId: waveId, waveName: db.waves[waveId].name, isNew: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/waves/:waveId", (req, res) => {
  const wave = db.waves[req.params.waveId];
  if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });
  const members = Object.values(wave.members || {}).map(m => ({ id: m.id, name: m.name, isOwner: m.isOwner || false, online: !!(wave.onlineNow && wave.onlineNow[m.id]) }));
  res.json({ waveId: wave.id, waveName: wave.name, listenersCount: members.filter(m => m.online).length, totalMembers: members.length, members: members, ownerDevice: wave.ownerDevice });
});

app.get("/api/waves/my/:deviceId", (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const myWaves = Object.values(db.waves || {}).filter(w => (w.members && w.members[deviceId]) || w.ownerDevice === deviceId);
    res.json({ waves: myWaves.map(w => ({ waveId: w.id, waveName: w.name, ownerDevice: w.ownerDevice, membersCount: Object.keys(w.members || {}).length })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/waves/rename", (req, res) => {
  try {
    const { waveId, newName, deviceId } = req.body;
    const wave = db.waves[waveId];
    if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });
    if (wave.ownerDevice !== deviceId) return res.status(403).json({ error: "غير مصرح" });
    wave.name = newName || wave.name;
    saveDb();
    res.json({ success: true, waveName: wave.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/waves/delete", (req, res) => {
  try {
    const { waveId } = req.body;
    if (db.waves && db.waves[waveId]) { delete db.waves[waveId]; saveDb(); res.json({ success: true }); }
    else res.status(404).json({ error: "الموجة غير موجودة" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/waves/remove-member", (req, res) => {
  try {
    const { waveId, memberId, ownerDevice } = req.body;
    const wave = db.waves[waveId];
    if (!wave) return res.status(404).json({ error: "الموجة غير موجودة" });
    if (wave.ownerDevice !== ownerDevice) return res.status(403).json({ error: "غير مصرح" });
    if (memberId === ownerDevice) return res.status(400).json({ error: "لا يمكنك إخراج نفسك" });
    if (wave.members[memberId]) delete wave.members[memberId];
    if (wave.onlineNow && wave.onlineNow[memberId]) delete wave.onlineNow[memberId];
    saveDb();
    const memberSocketId = deviceSockets[memberId];
    if (memberSocketId) io.to(memberSocketId).emit("wave_removed", { waveId: waveId });
    io.to("wave_" + waveId).emit("wave_members_updated", { members: Object.values(wave.members).map(m => ({ id: m.id, name: m.name, isOwner: m.isOwner || false, online: !!(wave.onlineNow && wave.onlineNow[m.id]) })) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/livekit/token", async (req, res) => {
  try {
    const { roomId, deviceId, userName } = req.body;
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) return res.status(500).json({ error: "LiveKit غير مهيّأ" });
    if (!roomId || !deviceId) return res.status(400).json({ error: "بيانات ناقصة" });
    if (!AccessToken) return res.status(500).json({ error: "مكتبة LiveKit غير مثبتة" });
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: deviceId, name: userName || deviceId, ttl: "6h" });
    at.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true, canPublishData: true });
    res.json({ success: true, token: await at.toJwt(), url: LIVEKIT_URL, room: roomId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

io.on("connection", (socket) => {
  socket.on("register_device", ({ deviceId, userName }) => {
    if (deviceId) {
      socket.data.deviceId = deviceId;
      socket.data.userName = userName;
      deviceSockets[deviceId] = socket.id;
      if (!db.devices[deviceId]) {
        db.devices[deviceId] = { id: deviceId, name: userName || "مستخدم", radCode: generateRadCode(), waveId: null, conversations: [], createdAt: now() };
        saveDb();
      }
      const waveId = db.devices[deviceId].waveId;
      if (waveId && db.waves[waveId]) {
        db.waves[waveId].onlineNow = db.waves[waveId].onlineNow || {};
        db.waves[waveId].onlineNow[deviceId] = true;
        saveDb();
        io.to("wave_" + waveId).emit("wave_members_updated", { members: Object.values(db.waves[waveId].members).map(m => ({ id: m.id, name: m.name, isOwner: m.isOwner || false, online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id]) })) });
      }
    }
  });
  socket.on("join_conversation", ({ conversationId }) => {
    socket.join("conv_" + conversationId);
    socket.data.currentConvId = conversationId;
    socket.emit("conversation_history", { conversationId: conversationId, messages: db.messages[conversationId] || [] });
  });
  socket.on("leave_conversation", ({ conversationId }) => {
    socket.leave("conv_" + conversationId);
    if (socket.data.currentConvId === conversationId) socket.data.currentConvId = null;
  });
  socket.on("send_direct_message", ({ conversationId, message }) => {
    if (!db.messages[conversationId]) db.messages[conversationId] = [];
    db.messages[conversationId].push(message);
    if (db.conversations[conversationId]) db.conversations[conversationId].lastMessageAt = now();
    saveDb();
    socket.to("conv_" + conversationId).emit("new_direct_message", { conversationId: conversationId, message: message });
    const conv = db.conversations[conversationId];
    if (conv) {
      conv.participants.forEach(pid => {
        if (pid !== message.sender) {
          const otherSocketId = deviceSockets[pid];
          if (otherSocketId) io.to(otherSocketId).emit("conversation_updated", { conversationId });
        }
      });
    }
    socket.emit("message_delivered", { messageId: message.id });
  });
  socket.on("wave_join", ({ waveId, deviceId, userName }) => {
    socket.join("wave_" + waveId);
    socket.data.waveId = waveId; socket.data.deviceId = deviceId; socket.data.userName = userName;
    if (!db.waves[waveId]) db.waves[waveId] = { id: waveId, name: waveId, ownerDevice: null, createdAt: now(), members: {}, onlineNow: {} };
    if (!db.waves[waveId].members) db.waves[waveId].members = {};
    if (!db.waves[waveId].onlineNow) db.waves[waveId].onlineNow = {};
    if (!db.waves[waveId].members[deviceId]) db.waves[waveId].members[deviceId] = { id: deviceId, name: userName || "مستخدم", isOwner: false, addedAt: now() };
    db.waves[waveId].onlineNow[deviceId] = true;
    saveDb();
    io.to("wave_" + waveId).emit("wave_members_updated", { members: Object.values(db.waves[waveId].members).map(m => ({ id: m.id, name: m.name, isOwner: m.isOwner || false, online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id]) })) });
  });
  socket.on("wave_leave", ({ waveId, deviceId }) => {
    if (db.waves[waveId] && db.waves[waveId].onlineNow) {
      delete db.waves[waveId].onlineNow[deviceId];
      saveDb();
      io.to("wave_" + waveId).emit("wave_members_updated", { members: Object.values(db.waves[waveId].members).map(m => ({ id: m.id, name: m.name, isOwner: m.isOwner || false, online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id]) })) });
    }
    socket.leave("wave_" + waveId);
  });
  socket.on("send_wave_voice", ({ waveId, senderName, audio }) => {
    if (!waveId || !audio) return;
    socket.to("wave_" + waveId).emit("new_wave_voice", { senderId: socket.data.deviceId, senderName: senderName || "مستخدم", audio });
  });
  socket.on("wave_join_request", ({ waveId, fromDeviceId, fromUserName }) => {
    const wave = db.waves[waveId];
    if (!wave) return socket.emit("wave_join_error", { error: "الموجة غير موجودة" });
    if (!wave.ownerDevice) return socket.emit("wave_join_error", { error: "لا يوجد صاحب" });
    if (wave.members && wave.members[fromDeviceId]) return socket.emit("wave_join_response_received", { waveId, accepted: true, fromDeviceId, fromUserName, direct: true });
    const requestId = "req_" + crypto.randomBytes(6).toString("hex");
    db.waveRequests[requestId] = { id: requestId, waveId, fromDeviceId, fromUserName, toDeviceId: wave.ownerDevice, createdAt: now(), status: "pending" };
    saveDb();
    const ownerSocketId = deviceSockets[wave.ownerDevice];
    if (ownerSocketId) io.to(ownerSocketId).emit("wave_join_request_received", { requestId, waveId, fromDeviceId, fromUserName, toDeviceId: wave.ownerDevice });
    else return socket.emit("wave_join_error", { error: "صاحب الموجة غير متصل" });
    socket.emit("wave_join_request_sent", { requestId, waveId });
  });
  socket.on("wave_join_response", ({ requestId, accepted }) => {
    const request = db.waveRequests[requestId];
    if (!request) return socket.emit("wave_join_error", { error: "الطلب غير موجود" });
    request.status = accepted ? "accepted" : "rejected";
    saveDb();
    const requesterSocketId = deviceSockets[request.fromDeviceId];
    if (requesterSocketId) io.to(requesterSocketId).emit("wave_join_response_received", { requestId, waveId: request.waveId, accepted, fromDeviceId: request.fromDeviceId, fromUserName: request.fromUserName });
    if (accepted) {
      if (!db.waves[request.waveId]) db.waves[request.waveId] = { id: request.waveId, name: request.waveId, ownerDevice: null, createdAt: now(), members: {}, onlineNow: {} };
      if (!db.waves[request.waveId].members) db.waves[request.waveId].members = {};
      if (!db.waves[request.waveId].onlineNow) db.waves[request.waveId].onlineNow = {};
      db.waves[request.waveId].members[request.fromDeviceId] = { id: request.fromDeviceId, name: request.fromUserName, isOwner: false, addedAt: now() };
      saveDb();
      io.to("wave_" + request.waveId).emit("wave_members_updated", { members: Object.values(db.waves[request.waveId].members).map(m => ({ id: m.id, name: m.name, isOwner: m.isOwner || false, online: !!(db.waves[request.waveId].onlineNow && db.waves[request.waveId].onlineNow[m.id]) })) });
    }
  });
  socket.on("wave_broadcast_start", ({ waveId, deviceId, userName }) => socket.to("wave_" + waveId).emit("wave_broadcast_start", { deviceId, userName }));
  socket.on("wave_broadcast_stop", ({ waveId, deviceId }) => socket.to("wave_" + waveId).emit("wave_broadcast_stop", { deviceId }));
  socket.on("friend_request", ({ fromDeviceId, fromUserName, fromCode, toDeviceId }) => {
    try {
      if (!fromDeviceId || !toDeviceId || fromDeviceId === toDeviceId) return;
      const friendshipKey = [fromDeviceId, toDeviceId].sort().join("_");
      if (db.friendships[friendshipKey]) return socket.emit("friend_error", { error: "أنتما صديقان بالفعل" });
      const existingReq = Object.values(db.friendRequests).find(r => r.fromDeviceId === fromDeviceId && r.toDeviceId === toDeviceId && r.status === "pending");
      if (existingReq) return socket.emit("friend_error", { error: "أرسلت طلباً بالفعل" });
      const requestId = "fr_" + crypto.randomBytes(6).toString("hex");
      db.friendRequests[requestId] = { id: requestId, fromDeviceId, fromUserName: fromUserName || "مستخدم", fromCode: fromCode || "—", toDeviceId, status: "pending", createdAt: now() };
      saveDb();
      const toSocketId = deviceSockets[toDeviceId];
      if (toSocketId) io.to(toSocketId).emit("friend_request_received", { requestId, fromDeviceId, fromUserName: fromUserName || "مستخدم", fromCode: fromCode || "—" });
      socket.emit("friend_request_sent", { requestId, toDeviceId });
    } catch (e) { console.error("خطأ friend_request:", e); }
  });
  socket.on("friend_accept", ({ fromDeviceId, toDeviceId }) => {
    try {
      const reqEntry = Object.entries(db.friendRequests).find(([id, r]) => r.fromDeviceId === fromDeviceId && r.toDeviceId === toDeviceId && r.status === "pending");
      if (!reqEntry) return;
      const [requestId, request] = reqEntry;
      request.status = "accepted"; request.acceptedAt = now();
      const friendshipKey = [fromDeviceId, toDeviceId].sort().join("_");
      db.friendships[friendshipKey] = { deviceA: fromDeviceId, deviceB: toDeviceId, since: now() };
      saveDb();
      const fromSocketId = deviceSockets[fromDeviceId];
      if (fromSocketId) {
        const toUser = db.devices[toDeviceId];
        io.to(fromSocketId).emit("friend_accepted", { byDeviceId: toDeviceId, byName: toUser ? toUser.name : "مستخدم", byCode: toUser ? toUser.radCode : "—" });
      }
      socket.emit("friend_accept_success", { withDeviceId: fromDeviceId });
    } catch (e) { console.error("خطأ friend_accept:", e); }
  });
  socket.on("friend_reject", ({ fromDeviceId, toDeviceId }) => {
    try {
      const reqEntry = Object.entries(db.friendRequests).find(([id, r]) => r.fromDeviceId === fromDeviceId && r.toDeviceId === toDeviceId && r.status === "pending");
      if (!reqEntry) return;
      const [requestId, request] = reqEntry;
      request.status = "rejected"; request.rejectedAt = now(); saveDb();
      const fromSocketId = deviceSockets[fromDeviceId];
      if (fromSocketId) io.to(fromSocketId).emit("friend_rejected", { byDeviceId: toDeviceId });
    } catch (e) { console.error("خطأ friend_reject:", e); }
  });
  socket.on("disconnect", () => {
    const { deviceId, waveId } = socket.data;
    if (deviceId && deviceSockets[deviceId] === socket.id) delete deviceSockets[deviceId];
    if (deviceId && waveId && db.waves[waveId] && db.waves[waveId].onlineNow) {
      delete db.waves[waveId].onlineNow[deviceId]; saveDb();
      io.to("wave_" + waveId).emit("wave_members_updated", { members: Object.values(db.waves[waveId].members || {}).map(m => ({ id: m.id, name: m.name, isOwner: m.isOwner || false, online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id]) })) });
    }
  });
});

server.listen(PORT, () => {
  console.log("Server v4.6 على المنفذ " + PORT);
});
