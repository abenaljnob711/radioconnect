const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ===== ذاكرة مؤقتة =====
let waves = {}; // waveId -> { waveId, waveName, ownerId, ownerSocket, members: [] }
let users = {}; // deviceId -> { deviceId, userName, radCode, socketId }
let deviceSocket = {}; // deviceId -> socketId
let pendingRequests = {}; // requestId -> { waveId, fromDeviceId, toDeviceId }
let conversations = {}; // convId -> { messages: [] }

function genWaveId() { return 'Q' + Math.floor(100000 + Math.random()*900000); }
function genRadCode() { return 'RAD-' + Math.random().toString(36).substring(2,7).toUpperCase(); }
function genReqId() { return 'REQ-' + Date.now() + Math.random().toString(36).substring(2,5); }

io.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("register_device", ({ deviceId, userName }) => {
    deviceSocket[deviceId] = socket.id;
    if (!users[deviceId]) {
      users[deviceId] = { deviceId, userName, radCode: genRadCode(), socketId: socket.id };
    } else {
      users[deviceId].socketId = socket.id;
      users[deviceId].userName = userName;
    }
    socket.join(deviceId);
  });

  // صاحب موجة ينشئ
  socket.on("wave_join", ({ waveId, deviceId, userName }) => {
    if (!waves[waveId]) return;
    let w = waves[waveId];
    // اضافة للاعضاء
    if (!w.members.find(m=>m.id===deviceId)) {
      w.members.push({ id: deviceId, name: userName, online: true, isOwner: w.ownerId===deviceId });
    } else {
      w.members.forEach(m=>{ if(m.id===deviceId) m.online=true });
    }
    socket.join(waveId);
    io.to(waveId).emit("wave_members_updated", { members: w.members });
  });

  // ===== نظام طلب الانضمام =====
  socket.on("wave_join_request", ({ waveId, fromDeviceId, fromUserName }) => {
    const wave = waves[waveId];
    if (!wave) {
      socket.emit("wave_join_error", { error: "لا توجد موجة بهذا الرقم" });
      return;
    }
    if (fromDeviceId === wave.ownerId) {
      socket.emit("wave_join_error", { error: "هذه موجتك!" });
      return;
    }
    const requestId = genReqId();
    pendingRequests[requestId] = { waveId, fromDeviceId, toDeviceId: wave.ownerId };

    const ownerSocketId = deviceSocket[wave.ownerId];
    if (ownerSocketId) {
      io.to(ownerSocketId).emit("wave_join_request_received", {
        requestId, waveId, fromDeviceId, fromUserName, toDeviceId: wave.ownerId
      });
    }
    socket.emit("wave_join_request_sent", { requestId, waveId });
  });

  socket.on("wave_join_response", ({ requestId, accepted }) => {
    const req = pendingRequests[requestId];
    if (!req) return;
    const { waveId, fromDeviceId } = req;
    const requesterSocket = deviceSocket[fromDeviceId];

    if (accepted) {
      const wave = waves[waveId];
      if (wave) {
        // انضم فعليا
        if (!wave.members.find(m=>m.id===fromDeviceId)) {
          const u = users[fromDeviceId];
          wave.members.push({ id: fromDeviceId, name: u?.userName || "مستخدم", online: true, isOwner: false });
        }
        io.to(waveId).emit("wave_members_updated", { members: wave.members });
      }
    }

    if (requesterSocket) {
      io.to(requesterSocket).emit("wave_join_response_received", {
        waveId, accepted, direct: false
      });
    }
    delete pendingRequests[requestId];
  });

  socket.on("disconnect", () => {
    for (let did in deviceSocket) {
      if (deviceSocket[did] === socket.id) {
        const wId = Object.keys(waves).find(id => waves[id].members.find(m=>m.id===did));
        if (wId) {
          waves[wId].members.forEach(m=>{ if(m.id===did) m.online=false });
          io.to(wId).emit("wave_members_updated", { members: waves[wId].members });
        }
      }
    }
  });
});

// ===== APIs =====
app.post("/api/waves/create", (req, res) => {
  const { deviceId, waveName } = req.body;
  const waveId = genWaveId();
  waves[waveId] = { waveId, waveName: waveName || "موجتي", ownerId: deviceId, members: [{ id: deviceId, name: users[deviceId]?.userName || "أنا", online: true, isOwner:
