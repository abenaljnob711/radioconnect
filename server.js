const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let waves = {}, users = {}, deviceSocket = {}, pendingRequests = {};
const genWaveId = () => 'Q' + Math.floor(100000 + Math.random()*900000);
const genRadCode = () => 'RAD-' + Math.random().toString(36).substring(2,7).toUpperCase();
const genReqId = () => 'REQ' + Date.now();

io.on("connection", (socket) => {
  socket.on("register_device", ({ deviceId, userName }) => {
    deviceSocket[deviceId] = socket.id;
    if (!users[deviceId]) users[deviceId] = { deviceId, userName, radCode: genRadCode() };
    users[deviceId].userName = userName;
    socket.join(deviceId);
  });
  socket.on("wave_join", ({ waveId, deviceId, userName }) => {
    if (!waves[waveId]) return;
    socket.join(waveId);
    let w = waves[waveId];
    if (!w.members.find(m => m.id === deviceId)) w.members.push({ id: deviceId, name: userName, online: true, isOwner: w.ownerId === deviceId });
    else w.members.forEach(m => { if (m.id === deviceId) m.online = true; });
    io.to(waveId).emit("wave_members_updated", { members: w.members });
  });
  socket.on("wave_join_request", ({ waveId, fromDeviceId, fromUserName }) => {
    const wave = waves[waveId];
    if (!wave) { socket.emit("wave_join_error", { error: "لا توجد موجة" }); return; }
    const requestId = genReqId();
    pendingRequests[requestId] = { waveId, fromDeviceId, fromUserName };
    const ownerSocketId = deviceSocket[wave.ownerId];
    if (ownerSocketId) io.to(ownerSocketId).emit("wave_join_request_received", { requestId, waveId, fromDeviceId, fromUserName });
    socket.emit("wave_join_request_sent", { requestId });
  });
  socket.on("wave_join_response", ({ requestId, accepted }) => {
    const req = pendingRequests[requestId]; if (!req) return;
    const { waveId, fromDeviceId } = req;
    const s = deviceSocket[fromDeviceId];
    if (s) io.to(s).emit("wave_join_response_received", { waveId, accepted });
    if (accepted && waves[waveId] &&!waves[waveId].members.find(m=>m.id===fromDeviceId)) {
      waves[waveId].members.push({ id: fromDeviceId, name: users[fromDeviceId]?.userName || "مستخدم", online: true, isOwner: false });
      io.to(waveId).emit("wave_members_updated", { members: waves[waveId].members });
    }
    delete pendingRequests[requestId];
  });
  socket.on("disconnect", () => { for (let did in deviceSocket) if (deviceSocket[did] === socket.id) delete deviceSocket[did]; });
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
app.post("/api/users/register", (req, res) => {
  const { deviceId, userName } = req.body;
  if (!users[deviceId]) users[deviceId] = { deviceId, userName, radCode: genRadCode() };
  users[deviceId].userName = userName;
  res.json({ success: true, radCode: users[deviceId].radCode, deviceId });
});
app.get("/", (req,res)=> res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 10000;
server.listen(PORT, ()=> console.log("Live on " + PORT));
