const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const path = require('path');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let users = {}; 
let waves = {};

// 1. مسار تسجيل المستخدم
app.post('/api/users/register', (req, res) => {
    const { deviceId, userName } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID required' });
    
    if (!users[deviceId]) {
        const radCode = 'Q' + Math.floor(10000 + Math.random() * 90000);
        users[deviceId] = { deviceId, userName: userName || 'مستخدم', radCode };
    } else {
        users[deviceId].userName = userName || users[deviceId].userName;
    }
    res.json(users[deviceId]);
});

// 2. مسار البحث عن مستخدم
app.get('/api/users/search/:code', (req, res) => {
    const code = req.params.code.toUpperCase();
    const user = Object.values(users).find(u => u.radCode === code);
    if (user) res.json(user);
    else res.status(404).json({ error: 'User not found' });
});

// 3. مسار إنشاء فرقة
app.post('/api/waves/create', (req, res) => {
    const { deviceId, waveName } = req.body;
    const waveId = 'M' + Math.floor(10000 + Math.random() * 90000);
    waves[waveId] = {
        waveId,
        waveName,
        ownerId: deviceId,
        members: [{ id: deviceId, name: users[deviceId]?.userName || 'مستخدم', isOwner: true, online: true }]
    };
    res.json({ success: true, waveId, waveName });
});

// 4. مسار جلب بيانات الفرقة
app.get('/api/waves/:id', (req, res) => {
    const wave = waves[req.params.id.toUpperCase()];
    if (wave) res.json(wave);
    else res.status(404).json({ error: 'Wave not found' });
});

// 5. مسار توليد توكن LiveKit
app.post('/api/livekit/token', async (req, res) => {
    const { roomId, deviceId, userName } = req.body;

    const API_KEY = process.env.LIVEKIT_API_KEY; 
    const API_SECRET = process.env.LIVEKIT_API_SECRET; 

    if (!API_KEY || !API_SECRET) {
        return res.status(500).json({ error: 'Server configuration error' });
    }

    try {
        const at = new AccessToken(API_KEY, API_SECRET, {
            identity: deviceId || 'user_' + Date.now(),
            name: userName || 'مستخدم',
            ttl: '2h' 
        });

        at.addGrant({ 
            roomJoin: true, 
            room: roomId || 'default-room',
            canPublish: true, 
            canSubscribe: true 
        });

        const token = await at.toJwt();
        res.json({ token });
    } catch (error) {
        res.status(500).json({ error: 'فشل توليد التوكن' });
    }
});

// ==========================================
// إعدادات Socket.io (الرسائل + طلبات الانضمام)
// ==========================================
io.on('connection', (socket) => {
    
    socket.on('register_device', (data) => {
        socket.join(data.deviceId);
    });

    // 1. انضمام مباشر
    socket.on('wave_join', (data) => {
        socket.join(data.waveId);
        if(waves[data.waveId] && !waves[data.waveId].members.find(m => m.id === data.deviceId)) {
            waves[data.waveId].members.push({ id: data.deviceId, name: data.userName || 'مستخدم', online: true, isOwner: false });
        }
        if(waves[data.waveId]) {
            io.to(data.waveId).emit('wave_members_updated', { members: waves[data.waveId].members });
        }
    });
    
    // 2. طلب انضمام (من شخص غريب للمالك)
    socket.on('wave_join_request', (data) => {
        if (data.toDeviceId) {
            io.to(data.toDeviceId).emit('wave_join_request_received', data);
        }
    });

    // 3. رد المالك (قبول أو رفض)
    socket.on('wave_join_response', (data) => {
        if (data.accepted) {
            if (waves[data.waveId] && !waves[data.waveId].members.find(m => m.id === data.fromDeviceId)) {
                waves[data.waveId].members.push({ id: data.fromDeviceId, name: 'عضو جديد', online: true, isOwner: false });
            }
            io.to(data.fromDeviceId).emit('wave_join_response_received', { accepted: true, waveId: data.waveId });
            if (waves[data.waveId]) {
                io.to(data.waveId).emit('wave_members_updated', { members: waves[data.waveId].members });
            }
        } else {
            io.to(data.fromDeviceId).emit('wave_join_response_received', { accepted: false });
        }
    });
    
    // 4. الرسائل
    socket.on('send_direct_message', (data) => {
         io.to(data.toDeviceId).emit('new_direct_message', { conversationId: data.conversationId, message: data.message });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
