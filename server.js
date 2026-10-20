"use strict";

/* ==========================================
   Radio Connect Server - v4.3
   RadCode format: Q#####
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
  messages: {},
  friendRequests: {},   // ✅ إضافة 1: طلبات الصداقة
  friendships: {}       // ✅ إضافة 1: الصداقات المقبولة
};

/* ==========================================
   ✅ توليد كود RadCode بصيغة Q#####
   ========================================== */
function generateRadCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "Q";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/* توليد كود موجة (نفس الصيغة) */
function generateWaveId() {
  return generateRadCode();
}

/* توليد كود غرفة (يبدأ بـ G) */
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "G";
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
      db.friendRequests = parsed.friendRequests || {};   // ✅ إضافة 2
      db.friendships = parsed.friendships || {};         // ✅ إضافة 2
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
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      status: "ok",
      name: "Radio Connect Server",
      version: "4.3",
      livekit: LIVEKIT_URL ? "configured" : "not configured",
      uptime: process.uptime()
    });
  }
});

app.get("/status", (req, res) => {
  res.json({
    status: "ok",
    name: "Radio Connect Server",
    version: "4.3",
    livekit: LIVEKIT_URL ? "configured" : "not configured",
    uptime: process.uptime(),
    waves: Object.keys(db.waves).length,
    devices: Object.keys(db.devices).length
  });
});

/* تسجيل مستخدم جديد */
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
      if (!db.devices[deviceId].radCode || db.devices[deviceId].radCode.startsWith("RAD-")) {
        db.devices[deviceId].radCode = generateRadCode();
        saveDb();
      }
    }

    res.json({
      success: true,
      deviceId: deviceId,
      radCode: db.devices[deviceId].radCode,
      userName: db.devices[deviceId].name,
      waveId: db.devices[deviceId].waveId
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* البحث عن مستخدم */
app.get("/api/users/search/:radCode", (req, res) => {
  const code = req.params.radCode.toUpperCase();
  const user = Object.values(db.devices).find(u => u.radCode === code);
  if (!user) return res.status(404).json({ error: "لا يوجد مستخدم بهذا الرقم" });

  res.json({
    deviceId: user.id,
    userName: user.name,
    radCode: user.radCode,
    waveId: user.waveId
  });
});

/* ==========================================
   المحادثات (Conversations)
   ========================================== */

app.post("/api/conversations/start", (req, res) => {
  try {
    const { myDeviceId, otherDeviceId } = req.body;
    if (!myDeviceId || !otherDeviceId) return res.status(400).json({ error: "بيانات ناقصة" });
    if (!db.devices[myDeviceId]) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (!db.devices[otherDeviceId]) return res.status(404).json({ error: "المستخدم الآخر غير موجود" });

    const convId = generateConversationId(myDeviceId, otherDeviceId);

    if (!db.conversations[convId]) {
      db.conversations[convId] = {
        id: convId,
        participants: [myDeviceId, otherDeviceId],
        createdAt: now(),
        lastMessageAt: now()
      };
      db.messages[convId] = [];

      if (!db.devices[myDeviceId].conversations) db.devices[myDeviceId].conversations = [];
      if (!db.devices[otherDeviceId].conversations) db.devices[otherDeviceId].conversations = [];

      if (!db.devices[myDeviceId].conversations.includes(convId)) {
        db.devices[myDeviceId].conversations.push(convId);
      }
      if (!db.devices[otherDeviceId].conversations.includes(convId)) {
        db.devices[otherDeviceId].conversations.push(convId);
      }
      saveDb();
    }

    res.json({
      success: true,
      conversationId: convId,
      otherUser: {
        deviceId: otherDeviceId,
        userName: db.devices[otherDeviceId].name,
        radCode: db.devices[otherDeviceId].radCode
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* قائمة محادثات المستخدم */
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

      return {
        conversationId: convId,
        otherUser: {
          deviceId: otherId,
          userName: other ? other.name : "مستخدم",
          radCode: other ? other.radCode : "—"
        },
        lastMessage: lastMsg ? {
          text: lastMsg.type === 'voice' ? '🎤 رسالة صوتية' :
                lastMsg.type === 'image' ? '🖼️ صورة' :
                lastMsg.type === 'video' ? '🎬 فيديو' :
                (lastMsg.text || ''),
          time: lastMsg.time,
          sender: lastMsg.sender
        } : null,
        lastMessageAt: conv.lastMessageAt || conv.createdAt
      };
    }).filter(c => c !== null);

    convList.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

    res.json({ conversations: convList });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* رسائل محادثة معينة */
app.get("/api/conversations/:convId/messages", (req, res) => {
  try {
    const convId = req.params.convId;
    const messages = db.messages[convId] || [];
    res.json({ messages: messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==========================================
   الموجات (Waves / الفرق)
   ========================================== */

app.post("/api/waves/create", (req, res) => {
  try {
    const { deviceId, waveName } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId مطلوب" });

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

    let waveId;
    do {
      waveId = generateWaveId();
    } while (db.waves[waveId]);

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

  const members = Object.values(wave.members || {}).map(m => ({
    id: m.id,
    name: m.name,
    isOwner: m.isOwner || false,
    online: !!(wave.onlineNow && wave.onlineNow[m.id])
  }));

  const onlineCount = members.filter(m => m.online).length;

  res.json({
    waveId: wave.id,
    waveName: wave.name,
    listenersCount: onlineCount,
    totalMembers: members.length,
    members: members,
    ownerDevice: wave.ownerDevice
  });
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    if (memberSocketId) {
      io.to(memberSocketId).emit("wave_removed", { waveId: waveId });
    }

    io.to("wave_" + waveId).emit("wave_members_updated", {
      members: Object.values(wave.members).map(m => ({
        id: m.id,
        name: m.name,
        isOwner: m.isOwner || false,
        online: !!(wave.onlineNow && wave.onlineNow[m.id])
      }))
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    if (!roomId || !deviceId) return res.status(400).json({ error: "بيانات ناقصة" });
    if (!AccessToken) return res.status(500).json({ error: "مكتبة LiveKit غير مثبتة" });

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

    res.json({ success: true, token: token, url: LIVEKIT_URL, room: roomId });
  } catch (e) {
    console.error("خطأ LiveKit:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ==========================================
   Socket.IO — الأحداث الحية
   ========================================== */

io.on("connection", (socket) => {
  console.log("🔌 متصل:", socket.id);

  socket.on("register_device", ({ deviceId, userName }) => {
    if (deviceId) {
      socket.data.deviceId = deviceId;
      socket.data.userName = userName;
      deviceSockets[deviceId] = socket.id;

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
      }

      const waveId = db.devices[deviceId].waveId;
      if (waveId && db.waves[waveId]) {
        db.waves[waveId].onlineNow = db.waves[waveId].onlineNow || {};
        db.waves[waveId].onlineNow[deviceId] = true;
        saveDb();

        io.to("wave_" + waveId).emit("wave_members_updated", {
          members: Object.values(db.waves[waveId].members).map(m => ({
            id: m.id,
            name: m.name,
            isOwner: m.isOwner || false,
            online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id])
          }))
        });
      }
    }
  });

  socket.on("join_conversation", ({ conversationId }) => {
    socket.join("conv_" + conversationId);
    socket.data.currentConvId = conversationId;
    socket.emit("conversation_history", {
      conversationId: conversationId,
      messages: db.messages[conversationId] || []
    });
  });

  socket.on("leave_conversation", ({ conversationId }) => {
    socket.leave("conv_" + conversationId);
    if (socket.data.currentConvId === conversationId) socket.data.currentConvId = null;
  });

  socket.on("send_direct_message", ({ conversationId, message }) => {
    if (!db.messages[conversationId]) db.messages[conversationId] = [];
    db.messages[conversationId].push(message);

    if (db.conversations[conversationId]) {
      db.conversations[conversationId].lastMessageAt = now();
    }
    saveDb();

    io.to("conv_" + conversationId).emit("new_direct_message", {
      conversationId: conversationId,
      message: message
    });

    const conv = db.conversations[conversationId];
    if (conv) {
      conv.participants.forEach(pid => {
        if (pid !== message.sender) {
          const otherSocketId = deviceSockets[pid];
          if (otherSocketId) {
            io.to(otherSocketId).emit("conversation_updated", {
              conversationId: conversationId
            });
          }
        }
      });
    }

    socket.emit("message_delivered", { messageId: message.id });
  });

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
        members: {},
        onlineNow: {}
      };
    }

    if (!db.waves[waveId].members) db.waves[waveId].members = {};
    if (!db.waves[waveId].onlineNow) db.waves[waveId].onlineNow = {};

    if (!db.waves[waveId].members[deviceId]) {
      db.waves[waveId].members[deviceId] = {
        id: deviceId,
        name: userName || "مستخدم",
        isOwner: false,
        addedAt: now()
      };
    }

    db.waves[waveId].onlineNow[deviceId] = true;
    saveDb();

    io.to("wave_" + waveId).emit("wave_members_updated", {
      members: Object.values(db.waves[waveId].members).map(m => ({
        id: m.id,
        name: m.name,
        isOwner: m.isOwner || false,
        online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id])
      }))
    });

    io.to("wave_" + waveId).emit("wave_listener_joined", {
      deviceId,
      userName,
      members: Object.values(db.waves[waveId].members).map(m => ({
        id: m.id,
        name: m.name,
        isOwner: m.isOwner || false,
        online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id])
      }))
    });
  });

  socket.on("wave_leave", ({ waveId, deviceId }) => {
    if (db.waves[waveId] && db.waves[waveId].onlineNow) {
      delete db.waves[waveId].onlineNow[deviceId];
      saveDb();

      io.to("wave_" + waveId).emit("wave_members_updated", {
        members: Object.values(db.waves[waveId].members).map(m => ({
          id: m.id,
          name: m.name,
          isOwner: m.isOwner || false,
          online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id])
        }))
      });
    }
    socket.leave("wave_" + waveId);
  });

  socket.on("wave_join_request", ({ waveId, fromDeviceId, fromUserName }) => {
    const wave = db.waves[waveId];
    if (!wave) return socket.emit("wave_join_error", { error: "الموجة غير موجودة" });
    if (!wave.ownerDevice) return socket.emit("wave_join_error", { error: "لا يوجد صاحب" });

    if (wave.members && wave.members[fromDeviceId]) {
      socket.emit("wave_join_response_received", {
        waveId: waveId,
        accepted: true,
        fromDeviceId: fromDeviceId,
        fromUserName: fromUserName,
        direct: true
      });
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

    const ownerSocketId = deviceSockets[wave.ownerDevice];
    if (ownerSocketId) {
      io.to(ownerSocketId).emit("wave_join_request_received", {
        requestId,
        waveId,
        fromDeviceId,
        fromUserName,
        toDeviceId: wave.ownerDevice
      });
    } else {
      return socket.emit("wave_join_error", { error: "صاحب الموجة غير متصل" });
    }

    socket.emit("wave_join_request_sent", { requestId, waveId });
  });

  socket.on("wave_join_response", ({ requestId, accepted }) => {
    const request = db.waveRequests[requestId];
    if (!request) return socket.emit("wave_join_error", { error: "الطلب غير موجود" });

    request.status = accepted ? "accepted" : "rejected";
    saveDb();

    const requesterSocketId = deviceSockets[request.fromDeviceId];
    if (requesterSocketId) {
      io.to(requesterSocketId).emit("wave_join_response_received", {
        requestId,
        waveId: request.waveId,
        accepted,
        fromDeviceId: request.fromDeviceId,
        fromUserName: request.fromUserName
      });
    }

    if (accepted) {
      if (!db.waves[request.waveId]) {
        db.waves[request.waveId] = {
          id: request.waveId,
          name: request.waveId,
          ownerDevice: null,
          createdAt: now(),
          members: {},
          onlineNow: {}
        };
      }

      if (!db.waves[request.waveId].members) db.waves[request.waveId].members = {};
      if (!db.waves[request.waveId].onlineNow) db.waves[request.waveId].onlineNow = {};

      db.waves[request.waveId].members[request.fromDeviceId] = {
        id: request.fromDeviceId,
        name: request.fromUserName,
        isOwner: false,
        addedAt: now()
      };
      saveDb();

      io.to("wave_" + request.waveId).emit("wave_members_updated", {
        members: Object.values(db.waves[request.waveId].members).map(m => ({
          id: m.id,
          name: m.name,
          isOwner: m.isOwner || false,
          online: !!(db.waves[request.waveId].onlineNow && db.waves[request.waveId].onlineNow[m.id])
        }))
      });
    }
  });

  socket.on("wave_broadcast_start", ({ waveId, deviceId, userName }) => {
    socket.to("wave_" + waveId).emit("wave_broadcast_start", { deviceId, userName });
  });

  socket.on("wave_broadcast_stop", ({ waveId, deviceId }) => {
    socket.to("wave_" + waveId).emit("wave_broadcast_stop", { deviceId });
  });

  /* ==========================================
     🆕 نظام طلبات الصداقة — إضافة 3
     ========================================== */

  socket.on("friend_request", ({ fromDeviceId, fromUserName, fromCode, toDeviceId }) => {
    try {
      if (!fromDeviceId || !toDeviceId) return;
      if (fromDeviceId === toDeviceId) return;

      const friendshipKey = [fromDeviceId, toDeviceId].sort().join("_");
      if (db.friendships[friendshipKey]) {
        return socket.emit("friend_error", { error: "أنتما صديقان بالفعل" });
      }

      const existingReq = Object.values(db.friendRequests).find(
        r => r.fromDeviceId === fromDeviceId && r.toDeviceId === toDeviceId && r.status === "pending"
      );
      if (existingReq) {
        return socket.emit("friend_error", { error: "أرسلت طلباً بالفعل" });
      }

      const requestId = "fr_" + crypto.randomBytes(6).toString("hex");
      db.friendRequests[requestId] = {
        id: requestId,
        fromDeviceId,
        fromUserName: fromUserName || "مستخدم",
        fromCode: fromCode || "—",
        toDeviceId,
        status: "pending",
        createdAt: now()
      };
      saveDb();

      const toSocketId = deviceSockets[toDeviceId];
      if (toSocketId) {
        io.to(toSocketId).emit("friend_request_received", {
          requestId,
          fromDeviceId,
          fromUserName: fromUserName || "مستخدم",
          fromCode: fromCode || "—"
        });
      }

      socket.emit("friend_request_sent", { requestId, toDeviceId });
    } catch (e) {
      console.error("خطأ friend_request:", e);
    }
  });

  socket.on("friend_accept", ({ fromDeviceId, toDeviceId }) => {
    try {
      const reqEntry = Object.entries(db.friendRequests).find(
        ([id, r]) => r.fromDeviceId === fromDeviceId && r.toDeviceId === toDeviceId && r.status === "pending"
      );
      if (!reqEntry) return;

      const [requestId, request] = reqEntry;
      request.status = "accepted";
      request.acceptedAt = now();

      const friendshipKey = [fromDeviceId, toDeviceId].sort().join("_");
      db.friendships[friendshipKey] = {
        deviceA: fromDeviceId,
        deviceB: toDeviceId,
        since: now()
      };
      saveDb();

      const fromSocketId = deviceSockets[fromDeviceId];
      if (fromSocketId) {
        const toUser = db.devices[toDeviceId];
        io.to(fromSocketId).emit("friend_accepted", {
          byDeviceId: toDeviceId,
          byName: toUser ? toUser.name : "مستخدم",
          byCode: toUser ? toUser.radCode : "—"
        });
      }

      socket.emit("friend_accept_success", { withDeviceId: fromDeviceId });
    } catch (e) {
      console.error("خطأ friend_accept:", e);
    }
  });

  socket.on("friend_reject", ({ fromDeviceId, toDeviceId }) => {
    try {
      const reqEntry = Object.entries(db.friendRequests).find(
        ([id, r]) => r.fromDeviceId === fromDeviceId && r.toDeviceId === toDeviceId && r.status === "pending"
      );
      if (!reqEntry) return;

      const [requestId, request] = reqEntry;
      request.status = "rejected";
      request.rejectedAt = now();
      saveDb();

      const fromSocketId = deviceSockets[fromDeviceId];
      if (fromSocketId) {
        io.to(fromSocketId).emit("friend_rejected", {
          byDeviceId: toDeviceId
        });
      }
    } catch (e) {
      console.error("خطأ friend_reject:", e);
    }
  });

  /* ========== نهاية نظام الصداقة ========== */

  socket.on("disconnect", () => {
    const { deviceId, waveId } = socket.data;

    if (deviceId && deviceSockets[deviceId] === socket.id) {
      delete deviceSockets[deviceId];
    }

    if (deviceId && waveId && db.waves[waveId] && db.waves[waveId].onlineNow) {
      delete db.waves[waveId].onlineNow[deviceId];
      saveDb();

      io.to("wave_" + waveId).emit("wave_members_updated", {
        members: Object.values(db.waves[waveId].members || {}).map(m => ({
          id: m.id,
          name: m.name,
          isOwner: m.isOwner || false,
          online: !!(db.waves[waveId].onlineNow && db.waves[waveId].onlineNow[m.id])
        }))
      });
    }

    console.log("❌ غادر:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Radio Connect Server v4.3 على المنفذ ${PORT}`);
  console.log(`📡 LiveKit: ${LIVEKIT_URL ? "✅ مهيّأ" : "❌ غير مهيّأ"}`);
});
