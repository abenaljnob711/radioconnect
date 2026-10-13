const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let waves = {};
let users = {};
let deviceSocket = {};
let pendingRequests = {};

function genWaveId() {
  return 'Q' + Math.floor(100000 + Math.random()*900000);
}
function genRadCode() {
  return 'RAD-' + Math.random().toString(36).substring(2,7).toUpperCase();
}
function genReqId() {
  return 'REQ' + Date.now();
}

io.on("connection", (socket) => {

  socket.on("register_device", ({ deviceId, userName }) => {
    deviceSocket[deviceId] = socket.id;
    if (!users[deviceId]) {
      users[deviceId] = { deviceId, userName, radCode: genRadCode() };
    }
    users[deviceId].userName = userName;
    socket.join(deviceId);
  });

  socket.on("wave_join", ({ waveId, deviceId, userName }) => {
    if (!waves[waveId]) return;
    socket.join(waveId);
    let w = waves[waveId];
    if (!w.members.find(m => m.id === deviceId)) {
      w.members.push({ id: deviceId, name: userName, online: true, isOwner: w.ownerId === deviceId });
    } else {
      w.members.forEach(m => { if (m.id === deviceId) m.online = true; });
    }
    io.to(waveId).emit("wave_members_updated", { members: w.members });
  });

  socket.on("wave_join_request", ({ waveId, fromDeviceId, fromUserName }) => {
    const wave = waves[waveId];
    if (!wave) {
      socket.emit("wave_join_error", { error: "لا توجد موجة بهذا الرقم" });
      return;
    }
    const requestId = genReqId();
    pendingRequests[requestId] = { waveId, fromDeviceId, fromUserName, toDeviceId: wave.ownerId };

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
    const { waveId, fromDeviceId, fromUserName } = req;
    const requesterSocket = deviceSocket[fromDeviceId];

    if (requesterSocket) {
      io.to(requesterSocket).emit("wave_join_response_received", {
        waveId, accepted, fromUserName: "", direct: false
      });
    }
    if (accepted && waves[waveId]) {
      const u = users[fromDeviceId];
      if (!waves[waveId].members.find(m=>m.id===fromDeviceId)) {
        waves[waveId].members.push({ id: fromDeviceId, name: u?.userName || fromUserName || "مستخدم", online: true, isOwner: false });
        io.to(waveId).emit("wave_members_updated", { members: waves[waveId].members });
      }
    }
    delete pendingRequests[requestId];
  });

  socket.on("disconnect", () => {
    for (let did in deviceSocket) {
      if (deviceSocket[did] === socket.id) delete deviceSocket[did];
    }
  });
});

app.post("/api/waves/create", (req, res) => {
  const { deviceId, waveName } = req.body;
  const waveId = genWaveId();
  waves[waveId] = { waveId, waveName: waveName || "موجتي", ownerId: deviceId, members: [] };
  res.json({ success: true, waveId, waveName: waves[waveId].waveName });
});

app.get("/api/waves/:waveId", (req, res) => {
  const w = waves[req.params.waveId.toUpperCase()];
  if (!w) return res.status(404).json({ error: "not found" });
  res.json({ waveId: w.waveId, waveName: w.waveName, listenersCount: w.members.filter(m=>m.online).length });
});

app.post("/api/waves/rename", (req, res) => {
  const { waveId, newName } = req.body;
  if (waves[waveId]) waves[waveId].waveName = newName;
  res.json({ success: true });
});

app.post("/api/waves/remove-member", (req, res
