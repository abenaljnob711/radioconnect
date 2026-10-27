require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';

// قاعدة بيانات مؤقتة في الذاكرة (In-Memory Data Store)
const users = new Map();         // deviceId -> { deviceId, userName, radCode, waveId, roomCode, socketId }
const waves = new Map();         // waveId -> { waveId, waveName, ownerId, members: Set(deviceId) }
const conversations = new Map(); // convId -> { id, participants: [deviceId1, deviceId2], messages: [] }
const friendRequests = new Map();// targetDeviceId -> [ { fromDeviceId, fromUserName, fromCode } ]

// توليد رموز عشوائية مثل Q12345 أو M98765
function generateCode(prefix = 'Q') {
  const num = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}${num}`;
}

/* =========================================================
   REST API Endpoints
   ========================================================= */

// تسجيل أو تحديث مستخدم
app.post('/api/users/register', (req, res) => {
  const { deviceId, userName } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId مطلوب' });

  let user = users.get(deviceId);
  if (!user) {
    user = {
      deviceId,
      userName: userName || 'مستخدم',
      radCode: generateCode('Q'),
      waveId: null,
      socketId: null
    };
    users.set(deviceId, user);
  } else {
    if (userName) user.userName = userName;
  }

  res.json({
    success: true,
    radCode: user.radCode,
    waveId: user.waveId
  });
});

// البحث عن مستخدم بكود Q#####
app.get('/api/users/search/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  for (const user of users.values()) {
    if (user.radCode === code) {
      return res.json({
        deviceId: user.deviceId,
        userName: user.userName,
        radCode: user.radCode
      });
    }
  }
  res.status(404).json({ error: 'المستخدم غير موجود' });
});

// حذف حساب مستخدم
app.delete('/api/users/delete/:id', (req, res) => {
  const deviceId = req.params.id;
  users.delete(deviceId);
  
  // تنظيف المجموعات والفرق
  for (const [wId, wave] of waves.entries()) {
    wave.members.delete(deviceId);
    if (wave.ownerId === deviceId) {
      waves.delete(wId);
    }
  }
  res.json({ success: true, message: 'تم حذف البيانات نهائياً' });
});

// إنشاء فرقة لاسلكية جديدة
app.post('/api/waves/create', (req, res) => {
  const { deviceId, waveName } = req.body;
  if (!deviceId || !waveName) return res.status(400).json({ error: 'بيانات ناقصة' });

  const waveId = generateCode('M');
  const waveData = {
    waveId,
    waveName,
    ownerId: deviceId,
    members: new Set([deviceId])
  };

  waves.set(waveId, waveData);

  const user = users.get(deviceId);
  if (user) user.waveId = waveId;

  res.json({
    success: true,
    waveId,
    waveName
  });
});

// الحصول على معلومات الفرقة وأعضائها
app.get('/api/waves/:id', (req, res) => {
  const waveId = req.params.id.toUpperCase();
  const wave = waves.get(waveId);
  if (!wave) return res.status(404).json({ error: 'الفرقة غير موجودة' });

  const memberList = Array.from(wave.members).map(mId => {
    const u = users.get(mId);
    return {
      id: mId,
      name: u ? u.userName : 'مستخدم',
      isOwner: mId === wave.ownerId,
      online: u && u.socketId ? true : false
    };
  });

  res.json({
    waveId: wave.waveId,
    waveName: wave.waveName,
    totalMembers: wave.members.size,
    members: memberList
  });
});

// إعادة تسمية الفرقة
app.post('/api/waves/rename', (req, res) => {
  const { waveId, newName, deviceId } = req.body;
  const wave = waves.get(waveId);
  if (!wave) return res.status(404).json({ error: 'الفرقة غير موجودة' });
  if (wave.ownerId !== deviceId) return res.status(403).json({ error: 'غير مصرح لك' });

  wave.waveName = newName;
  res.json({ success: true });
});

// إخراج عضو من الفرقة
app.post('/api/waves/remove-member', (req, res) => {
  const { waveId, memberId, ownerDevice } = req.body;
  const wave = waves.get(waveId);
  if (!wave) return res.status(404).json({ error: 'الفرقة غير موجودة' });
  if (wave.ownerId !== ownerDevice) return res.status(403).json({ error: 'غير مصرح لك' });

  wave.members.delete(memberId);
  
  // إرسال تنبيه للمطرود عبر Socket
  const targetUser = users.get(memberId);
  if (targetUser && targetUser.socketId) {
    io.to(targetUser.socketId).emit('wave_removed', { waveId });
  }

  res.json({ success: true });
});

// بدء محادثة ثنائية
app.post('/api/conversations/start', (req, res) => {
  const { myDeviceId, otherDeviceId } = req.body;
  if (!myDeviceId || !otherDeviceId) return res.status(400).json({ error: 'بيانات ناقصة' });

  // البحث عن محادثة قائمة أو إنشاء واحدة جديدة
  const convId = [myDeviceId, otherDeviceId].sort().join('_');
  if (!conversations.has(convId)) {
    conversations.set(convId, {
      id: convId,
      participants: [myDeviceId, otherDeviceId],
      messages: []
    });
  }

  res.json({ success: true, conversationId: convId });
});

// الحصول على قائمة المحادثات لمستخدم
app.get('/api/conversations/list/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const list = [];

  for (const conv of conversations.values()) {
    if (conv.participants.includes(deviceId)) {
      const otherId = conv.participants.find(id => id !== deviceId);
      const otherUser = users.get(otherId) || { userName: 'مستخدم', deviceId: otherId };
      const lastMsg = conv.messages[conv.messages.length - 1] || null;

      list.push({
        conversationId: conv.id,
        otherUser,
        lastMessage: lastMsg,
        lastMessageAt: lastMsg ? lastMsg.time : null
      });
    }
  }

  res.json({ conversations: list });
});

// الحصول على رسائل محادثة معينة
app.get('/api/conversations/:id/messages', (req, res) => {
  const conv = conversations.get(req.params.id);
  res.json({ messages: conv ? conv.messages : [] });
});

// طلبات الصداقة المعلقة
app.get('/api/friends/requests/:deviceId', (req, res) => {
  const reqs = friendRequests.get(req.params.deviceId) || [];
  res.json({ requests: reqs });
});

// توليد توكن LiveKit لاتصال الصوت المباشر (PTT)
app.post('/api/livekit/token', async (req, res) => {
  const { roomId, deviceId, userName } = req.body;
  if (!roomId || !deviceId) return res.status(400).json({ error: 'roomId و deviceId مطلوبان' });

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: deviceId,
      name: userName || 'User'
    });

    at.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true
    });

    const token = await at.toJwt();
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: 'فشل إنشاء توكن LiveKit' });
  }
});

/* =========================================================
   Socket.io Real-time Event Handlers
   ========================================================= */

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

function broadcastWaveMembers(waveId) {
  const wave = waves.get(waveId);
  if (!wave) return;

  const memberList = Array.from(wave.members).map(mId => {
    const u = users.get(mId);
    return {
      id: mId,
      name: u ? u.userName : 'مستخدم',
      isOwner: mId === wave.ownerId,
      online: u && u.socketId ? true : false
    };
  });

  io.to(`wave_${waveId}`).emit('wave_members_updated', { members: memberList });
}

io.on('connection', (socket) => {

  // تسجيل جهاز المستخدم ربط الـ Socket بالـ Device ID
  socket.on('register_device', ({ deviceId, userName }) => {
    let u = users.get(deviceId);
    if (!u) {
      u = { deviceId, userName: userName || 'مستخدم', radCode: generateCode('Q'), waveId: null };
      users.set(deviceId, u);
    }
    u.socketId = socket.id;
    if (userName) u.userName = userName;
    socket.deviceId = deviceId;
  });

  // الانضمام إلى غرفة فرقة لاسلكية
  socket.on('wave_join', ({ waveId, deviceId, userName }) => {
    let wave = waves.get(waveId);
    if (!wave) {
      wave = { waveId, waveName: 'فرقة', ownerId: deviceId, members: new Set() };
      waves.set(waveId, wave);
    }

    wave.members.add(deviceId);
    socket.join(`wave_${waveId}`);

    const u = users.get(deviceId);
    if (u) u.waveId = waveId;

    broadcastWaveMembers(waveId);
  });

  // مغادرة الفرقة اللاسلكية
  socket.on('wave_leave', ({ waveId, deviceId }) => {
    const wave = waves.get(waveId);
    if (wave) {
      wave.members.delete(deviceId);
      socket.leave(`wave_${waveId}`);
      broadcastWaveMembers(waveId);
    }
  });

  // إرسال طلب انضمام لفرقة
  socket.on('wave_join_request', (data) => {
    const { toDeviceId } = data;
    const owner = users.get(toDeviceId);
    if (owner && owner.socketId) {
      io.to(owner.socketId).emit('wave_join_request_received', data);
    }
  });

  // الرد على طلب الانضمام
  socket.on('wave_join_response', (data) => {
    const { fromDeviceId, accepted, waveId } = data;
    const requester = users.get(fromDeviceId);
    if (requester && requester.socketId) {
      io.to(requester.socketId).emit('wave_join_response_received', { accepted, waveId });
    }
  });

  // الانضمام لغرفة المحادثة النصية Direct Chat
  socket.on('join_conversation', ({ conversationId }) => {
    socket.join(`conv_${conversationId}`);
  });

  socket.on('leave_conversation', ({ conversationId }) => {
    socket.leave(`conv_${conversationId}`);
  });

  // إرسال رسالة شات مباشرة
  socket.on('send_direct_message', ({ conversationId, message, toDeviceId }) => {
    let conv = conversations.get(conversationId);
    if (conv && message) {
      conv.messages.push(message);
    }

    // إرسال الرسالة إلى جميع الأطراف في الغرفة
    if (conversationId) {
      io.to(`conv_${conversationId}`).emit('new_direct_message', { conversationId, message });
    }

    // إرسال تنبيه مباشر في حال لم يكن الطرف الآخر داخل الغرفة
    if (toDeviceId) {
      const targetUser = users.get(toDeviceId);
      if (targetUser && targetUser.socketId) {
        io.to(targetUser.socketId).emit('new_direct_message', { conversationId, message });
      }
    }
  });

  // تأكيد وصول الرسالة
  socket.on('message_delivered', ({ messageId, conversationId }) => {
    io.to(`conv_${conversationId}`).emit('message_delivered_ack', { messageId });
  });

  // طلبات الصداقة
  socket.on('friend_request', (data) => {
    const { toDeviceId, fromDeviceId, fromUserName, fromCode } = data;
    if (!friendRequests.has(toDeviceId)) {
      friendRequests.set(toDeviceId, []);
    }
    friendRequests.get(toDeviceId).push({ fromDeviceId, fromUserName, fromCode });

    const targetUser = users.get(toDeviceId);
    if (targetUser && targetUser.socketId) {
      io.to(targetUser.socketId).emit('friend_request_received', data);
    }
  });

  socket.on('friend_accept', ({ fromDeviceId, toDeviceId }) => {
    const sender = users.get(fromDeviceId);
    const receiver = users.get(toDeviceId);
    if (sender && sender.socketId) {
      io.to(sender.socketId).emit('friend_accepted', {
        byDeviceId: toDeviceId,
        byName: receiver ? receiver.userName : 'مستخدم',
        byCode: receiver ? receiver.radCode : '—'
      });
    }
  });

  socket.on('friend_reject', ({ fromDeviceId, toDeviceId }) => {
    const sender = users.get(fromDeviceId);
    if (sender && sender.socketId) {
      io.to(sender.socketId).emit('friend_rejected', { byDeviceId: toDeviceId });
    }
  });

  // قطع الاتصال
  socket.on('disconnect', () => {
    if (socket.deviceId) {
      const u = users.get(socket.deviceId);
      if (u) {
        u.socketId = null;
        if (u.waveId) {
          broadcastWaveMembers(u.waveId);
        }
      }
    }
  });
});

// تشغيل السيرفر
server.listen(PORT, () => {
  console.log(`🚀 RadioConnect Server is running on port ${PORT}`);
});
