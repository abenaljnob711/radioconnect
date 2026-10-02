const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { AccessToken } = require('livekit-server-sdk');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// LiveKit config من Render env
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://your-livekit.livekit.cloud';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'API_KEY';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'API_SECRET';

// ذاكرة مؤقتة للغرف (للإنتاج استخدم DB)
let rooms = []; // {id, name, roomCode, ownerDeviceId, createdAt}
let devices = {}; // deviceId -> {adminId}

function genId() { return crypto.randomBytes(8).toString('hex'); }
function genAdminId() { return 'ADM-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for(let i=0;i<4;i++) c+= chars[Math.floor(Math.random()*chars.length)];
  return c;
}

// تسجيل الجهاز
app.post('/api/device', (req, res) => {
  let { deviceId } = req.body;
  if (!deviceId || !devices[deviceId]) {
    deviceId = genId();
    const adminId = genAdminId();
    devices[deviceId] = { adminId, createdAt: new Date() };
    return res.json({ deviceId, adminId });
  }
  res.json({ deviceId, adminId: devices[deviceId].adminId });
});

// جلب الغرف
app.get('/api/rooms', (req, res) => {
  const deviceId = req.headers['x-device-id'];
  const list = rooms.map(r => ({
    ...r,
    isOwner: r.ownerDeviceId === deviceId
  }));
  res.json({ rooms: list });
});

// إنشاء غرفة
app.post('/api/rooms', (req, res) => {
  const deviceId = req.headers['x-device-id'];
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم الغرفة مطلوب' });
  const room = {
    id: 'room_' + genId(),
    name,
    roomCode: genRoomCode(),
    ownerDeviceId: deviceId,
    createdAt: new Date().toISOString()
  };
  rooms.unshift(room);
  res.json({ room, roomCode: room.roomCode });
});

// الانضمام برمز
app.post('/api/rooms/join', (req, res) => {
  const { code } = req.body;
  const room = rooms.find(r => r.roomCode === code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'رمز الغرفة غير موجود' });
  res.json({ message: 'تم الانضمام إلى ' + room.name, room });
});

// إنشاء LiveKit Token - أهم جزء
app.get('/token', async (req, res) => {
  try {
    const { identity, room, deviceId } = req.query;
    if (!room || !identity) {
      return res.status(400).json({ error: 'room و identity مطلوبين' });
    }
    
    // التحقق من وجود الغرفة
    const roomExists = rooms.find(r => r.id === room);
    if (!roomExists && rooms.length > 0) {
      // لو الغرفة غير موجودة، استخدم أول غرفة أو أنشئ مؤقتة
      console.log('Room not found, using requested room id directly for LiveKit');
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: identity.substring(0, 50),
      ttl: '2h',
      name: identity
    });

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const token = await at.toJwt();
    
    res.json({
      token,
      url: LIVEKIT_URL,
      identity,
      room
    });
  } catch (e) {
    console.error('Token error:', e);
    res.status(500).json({ error: 'فشل إنشاء رمز الصوت: ' + e.message });
  }
});

// فحص الصحة
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.length, 
    livekit: LIVEKIT_URL ? 'configured' : 'missing',
    uptime: process.uptime()
  });
});

// صفحة الرئيسية
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔗 LiveKit URL: ${LIVEKIT_URL}`);
  console.log(`🏠 Rooms: ${rooms.length}`);
});
