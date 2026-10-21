"use strict";
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

let AccessToken;
try { const lk = require("livekit-server-sdk"); AccessToken = lk.AccessToken; } catch (e) { console.warn("⚠️ livekit-server-sdk غير مثبّت"); }

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] }, maxHttpBufferSize: 1e8 });
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

let db = { devices:{}, waves:{}, waveRequests:{}, conversations:{}, messages:{}, friendRequests:{}, friendships:{} };

function generateRadCode(){ const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let code="Q"; for(let i=0;i<5;i++) code+=chars[Math.floor(Math.random()*chars.length)]; return code; }
function generateWaveId(){ const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let code="M"; for(let i=0;i<5;i++) code+=chars[Math.floor(Math.random()*chars.length)]; return code; }
function generateConversationId(a,b){ const s=[a,b].sort(); return "conv_"+crypto.createHash('md5').update(s.join('_')).digest('hex').substring(0,16); }
function now(){ return Date.now(); }
function getDeviceByRadCode(code){ if(!code) return null; const up=code.toUpperCase(); return Object.values(db.devices).find(d=>d.radCode===up)||null; }

function loadDb(){ try{ if(fs.existsSync(DATA_FILE)){ const raw=fs.readFileSync(DATA_FILE,"utf8"); const p=JSON.parse(raw); db.devices=p.devices||{}; db.waves=p.waves||{}; db.waveRequests=p.waveRequests||{}; db.conversations=p.conversations||{}; db.messages=p.messages||{}; db.friendRequests=p.friendRequests||{}; db.friendships=p.friendships||{}; } }catch(e){} }
function saveDb(){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); }catch(e){} }
loadDb();

app.get("/", (req,res)=>{ const ip=path.join(__dirname,"public","index.html"); if(fs.existsSync(ip)) res.sendFile(ip); else res.json({status:"ok",version:"4.3"}); });
app.get("/status",(req,res)=>{ res.json({status:"ok",waves:Object.keys(db.waves).length,devices:Object.keys(db.devices).length}); });

app.post("/api/users/register",(req,res)=>{
  try{
    const {deviceId,userName}=req.body; if(!deviceId) return res.status(400).json({error:"deviceId مطلوب"});
    if(!db.devices[deviceId]){ db.devices[deviceId]={id:deviceId,name:userName||"مستخدم",radCode:generateRadCode(),waveId:null,conversations:[],createdAt:now()}; saveDb(); }
    else{ if(userName) db.devices[deviceId].name=userName; if(!db.devices[deviceId].radCode||db.devices[deviceId].radCode.startsWith("RAD-")){ db.devices[deviceId].radCode=generateRadCode(); saveDb(); } }
    res.json({success:true,deviceId,radCode:db.devices[deviceId].radCode,userName:db.devices[deviceId].name,waveId:db.devices[deviceId].waveId});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ✅ دعم البحث بطريقتين: /:radCode و ?code=
app.get("/api/users/search", (req,res)=>{
  const code=(req.query.code||req.query.q||"").toUpperCase();
  if(!code) return res.status(400).json({error:"كود مطلوب"});
  const user=Object.values(db.devices).find(u=>u.radCode===code);
  const wave=db.waves[code]||Object.values(db.waves).find(w=>w.id===code);
  if(!user && !wave) return res.status(404).json({error:"غير موجود"});
  res.json({user: user?{deviceId:user.id,name:user.name,radCode:user.radCode}:null, wave: wave?{id:wave.id,name:wave.name,code:wave.id}:null});
});
app.get("/api/users/search/:radCode",(req,res)=>{
  const code=req.params.radCode.toUpperCase();
  const user=Object.values(db.devices).find(u=>u.radCode===code);
  const wave=db.waves[code];
  if(!user && !wave) return res.status(404).json({error:"لا يوجد"});
  if(user) return res.json({deviceId:user.id,userName:user.name,radCode:user.radCode,waveId:user.waveId,user:{deviceId:user.id,name:user.name,radCode:user.radCode}});
  if(wave) return res.json({wave:{id:wave.id,name:wave.name,code:wave.id}});
});

app.get("/api/friends/requests/:deviceId",(req,res)=>{
  try{ const requests=Object.values(db.friendRequests).filter(r=>r.toDeviceId===req.params.deviceId && r.status==="pending"); res.json({requests}); }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/conversations/start",(req,res)=>{
  try{
    const {myDeviceId,otherDeviceId}=req.body; if(!myDeviceId||!otherDeviceId) return res.status(400).json({error:"ناقص"});
    const convId=generateConversationId(myDeviceId,otherDeviceId);
    if(!db.conversations[convId]){ db.conversations[convId]={id:convId,participants:[myDeviceId,otherDeviceId],createdAt:now(),lastMessageAt:now()}; db.messages[convId]=[]; if(!db.devices[myDeviceId].conversations) db.devices[myDeviceId].conversations=[]; if(!db.devices[otherDeviceId].conversations) db.devices[otherDeviceId].conversations=[]; if(!db.devices[myDeviceId].conversations.includes(convId)) db.devices[myDeviceId].conversations.push(convId); if(!db.devices[otherDeviceId].conversations.includes(convId)) db.devices[otherDeviceId].conversations.push(convId); saveDb(); }
    res.json({success:true,conversationId:convId,otherUser:{deviceId:otherDeviceId,userName:db.devices[otherDeviceId]?.name,radCode:db.devices[otherDeviceId]?.radCode}});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get("/api/conversations/list/:deviceId",(req,res)=>{
  try{
    const deviceId=req.params.deviceId; const user=db.devices[deviceId]; if(!user) return res.json({conversations:[]});
    const convList=(user.conversations||[]).map(convId=>{ const conv=db.conversations[convId]; if(!conv) return null; const otherId=conv.participants.find(p=>p!==deviceId); const other=db.devices[otherId]; const messages=db.messages[convId]||[]; const lastMsg=messages[messages.length-1]; return {conversationId:convId,otherUser:{deviceId:otherId,userName:other?other.name:"مستخدم",radCode:other?other.radCode:"—"},lastMessage:lastMsg?{text:lastMsg.type==='voice'?'🎤 رسالة صوتية':lastMsg.text||'',time:lastMsg.time,sender:lastMsg.sender}:null,lastMessageAt:conv.lastMessageAt||conv.createdAt}; }).filter(c=>c!==null);
    convList.sort((a,b)=>b.lastMessageAt-a.lastMessageAt); res.json({conversations:convList});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get("/api/conversations/:convId/messages",(req,res)=>{ try{ res.json({messages:db.messages[req.params.convId]||[]}); }catch(e){ res.status(500).json({error:e.message}); } });

app.post("/api/waves/create",(req,res)=>{
  try{
    const {deviceId,waveName}=req.body; if(!deviceId) return res.status(400).json({error:"deviceId مطلوب"});
    if(db.devices[deviceId]?.waveId && db.waves[db.devices[deviceId].waveId]){ return res.json({success:true,waveId:db.devices[deviceId].waveId,waveName:db.waves[db.devices[deviceId].waveId].name,isNew:false}); }
    let waveId; do{ waveId=generateWaveId(); }while(db.waves[waveId]);
    db.waves[waveId]={id:waveId,name:waveName||"فرقتي",ownerDevice:deviceId,createdAt:now(),members:{},onlineNow:{}};
    if(!db.devices[deviceId]) db.devices[deviceId]={id:deviceId,conversations:[]}; db.devices[deviceId].waveId=waveId;
    db.waves[waveId].members[deviceId]={id:deviceId,name:db.devices[deviceId].name||"المالك",isOwner:true,addedAt:now()}; saveDb();
    res.json({success:true,waveId,waveName:db.waves[waveId].name,isNew:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get("/api/waves/:waveId",(req,res)=>{ const wave=db.waves[req.params.waveId]; if(!wave) return res.status(404).json({error:"الموجة غير موجودة"}); const members=Object.values(wave.members||{}).map(m=>({id:m.id,name:m.name,isOwner:m.isOwner||false,online:!!(wave.onlineNow&&wave.onlineNow[m.id])})); res.json({waveId:wave.id,waveName:wave.name,listenersCount:members.filter(m=>m.online).length,totalMembers:members.length,members,ownerDevice:wave.ownerDevice}); });
app.post("/api/waves/join",(req,res)=>{
  try{
    const {waveId,deviceId,userName}=req.body; const wave=db.waves[waveId]; if(!wave) return res.status(404).json({error:"الموجة غير موجودة"});
    if(!wave.members) wave.members={}; wave.members[deviceId]={id:deviceId,name:userName||"مستخدم",isOwner:false,addedAt:now()};
    if(db.devices[deviceId]) db.devices[deviceId].waveId=waveId; saveDb(); res.json({success:true,waveId});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/livekit/token", async (req,res)=>{
  try{
    const {roomId,deviceId,userName}=req.body; if(!LIVEKIT_API_KEY||!LIVEKIT_API_SECRET||!LIVEKIT_URL) return res.status(500).json({error:"LiveKit غير مهيّأ"}); if(!roomId||!deviceId) return res.status(400).json({error:"ناقص"}); if(!AccessToken) return res.status(500).json({error:"مكتبة LiveKit غير مثبتة"});
    const at=new AccessToken(LIVEKIT_API_KEY,LIVEKIT_API_SECRET,{identity:deviceId,name:userName||deviceId,ttl:"6h"}); at.addGrant({roomJoin:true,room:roomId,canPublish:true,canSubscribe:true,canPublishData:true}); const token=await at.toJwt(); res.json({success:true,token,url:LIVEKIT_URL,room:roomId});
  }catch(e){ console.error("LiveKit:",e); res.status(500).json({error:e.message}); }
});

io.on("connection",(socket)=>{
  console.log("🔌 متصل:",socket.id);

  socket.on("register_device",({deviceId,userName,radCode})=>{
    if(deviceId){
      socket.data.deviceId=deviceId; socket.data.userName=userName; deviceSockets[deviceId]=socket.id;
      if(!db.devices[deviceId]){ db.devices[deviceId]={id:deviceId,name:userName||"مستخدم",radCode:radCode||generateRadCode(),waveId:null,conversations:[],createdAt:now()}; saveDb(); }
      const waveId=db.devices[deviceId].waveId;
      if(waveId&&db.waves[waveId]){
        socket.join("wave_"+waveId); db.waves[waveId].onlineNow=db.waves[waveId].onlineNow||{}; db.waves[waveId].onlineNow[deviceId]=true; saveDb();
        io.to("wave_"+waveId).emit("wave_members_updated",{members:Object.values(db.waves[waveId].members).map(m=>({id:m.id,name:m.name,isOwner:m.isOwner||false,online:!!(db.waves[waveId].onlineNow&&db.waves[waveId].onlineNow[m.id])}))});
      }
      // ✅ إرسال طلبات الصداقة المعلقة فور الاتصال
      const pending=Object.values(db.friendRequests).filter(r=>r.toDeviceId===deviceId && r.status==="pending");
      pending.forEach(r=>{ socket.emit("friend_request_received",{requestId:r.id,fromDeviceId:r.fromDeviceId,fromUserName:r.fromUserName,fromCode:r.fromCode}); });
    }
  });

  socket.on("wave_join",({waveId,deviceId,userName})=>{
    socket.join("wave_"+waveId); socket.data.waveId=waveId; socket.data.deviceId=deviceId;
    if(!db.waves[waveId]) db.waves[waveId]={id:waveId,name:waveId,ownerDevice:null,createdAt:now(),members:{},onlineNow:{}};
    if(!db.waves[waveId].members) db.waves[waveId].members={}; if(!db.waves[waveId].onlineNow) db.waves[waveId].onlineNow={};
    if(!db.waves[waveId].members[deviceId]) db.waves[waveId].members[deviceId]={id:deviceId,name:userName||"مستخدم",isOwner:false,addedAt:now()};
    db.waves[waveId].onlineNow[deviceId]=true; saveDb();
    io.to("wave_"+waveId).emit("wave_members_updated",{members:Object.values(db.waves[waveId].members).map(m=>({id:m.id,name:m.name,isOwner:m.isOwner||false,online:!!(db.waves[waveId].onlineNow&&db.waves[waveId].onlineNow[m.id])}))});
  });

  socket.on("wave_broadcast_start",({waveId,deviceId,userName})=>{ socket.to("wave_"+waveId).emit("wave_broadcast_start",{deviceId,userName}); });
  socket.on("wave_broadcast_stop",({waveId,deviceId})=>{ socket.to("wave_"+waveId).emit("wave_broadcast_stop",{deviceId}); });

  // ✅ نظام الصداقة - يدعم toCode و toDeviceId معاً
  socket.on("friend_request", (data)=>{
    try{
      let {fromDeviceId,fromUserName,fromCode,toDeviceId,toCode}=data||{};
      if(!fromDeviceId) return;
      if(!toDeviceId && toCode){ const dev=getDeviceByRadCode(toCode); if(dev) toDeviceId=dev.id; }
      if(!toDeviceId) return socket.emit("friend_error",{error:"المستخدم غير موجود"});
      if(fromDeviceId===toDeviceId) return;
      const friendshipKey=[fromDeviceId,toDeviceId].sort().join("_");
      if(db.friendships[friendshipKey]) return socket.emit("friend_error",{error:"أنتما صديقان بالفعل"});
      const existingReq=Object.values(db.friendRequests).find(r=>r.fromDeviceId===fromDeviceId && r.toDeviceId===toDeviceId && r.status==="pending");
      if(existingReq) return socket.emit("friend_error",{error:"أرسلت طلباً بالفعل"});

      const requestId="fr_"+crypto.randomBytes(6).toString("hex");
      db.friendRequests[requestId]={id:requestId,fromDeviceId,fromUserName:fromUserName||db.devices[fromDeviceId]?.name||"مستخدم",fromCode:fromCode||db.devices[fromDeviceId]?.radCode||"—",toDeviceId,status:"pending",createdAt:now()}; saveDb();

      const toSocketId=deviceSockets[toDeviceId];
      if(toSocketId){
        io.to(toSocketId).emit("friend_request_received",{requestId,fromDeviceId,fromUserName:db.friendRequests[requestId].fromUserName,fromCode:db.friendRequests[requestId].fromCode});
        console.log(`📤 طلب صداقة ${fromDeviceId} -> ${toDeviceId} وصل`);
      } else {
        console.log(`💾 طلب صداقة ${fromDeviceId} -> ${toDeviceId} محفوظ (غير متصل)`);
      }
      socket.emit("friend_request_sent",{requestId,toDeviceId});
    }catch(e){ console.error("friend_request:",e); }
  });

  // دعم أسماء قديمة
  socket.on("send_friend_request",(d)=>{ io.sockets.emit("friend_request",d); socket.emit("friend_request",d); });
  socket.on("friend_request_send",(d)=>{ const toDev=d.toCode?getDeviceByRadCode(d.toCode)?.id:d.toDeviceId; socket.emit("friend_request",{fromDeviceId:d.fromDeviceId||socket.data.deviceId,fromUserName:d.fromName||socket.data.userName,fromCode:db.devices[d.fromDeviceId||socket.data.deviceId]?.radCode,toDeviceId:toDev,toCode:d.toCode}); });

  socket.on("friend_accept",({fromDeviceId,toDeviceId})=>{
    try{
      const entry=Object.entries(db.friendRequests).find(([id,r])=>r.fromDeviceId===fromDeviceId && r.toDeviceId===toDeviceId && r.status==="pending"); if(!entry) return;
      const [requestId,request]=entry; request.status="accepted"; request.acceptedAt=now();
      const friendshipKey=[fromDeviceId,toDeviceId].sort().join("_"); db.friendships[friendshipKey]={deviceA:fromDeviceId,deviceB:toDeviceId,since:now()}; saveDb();
      const fromSocketId=deviceSockets[fromDeviceId]; if(fromSocketId){ const toUser=db.devices[toDeviceId]; io.to(fromSocketId).emit("friend_accepted",{byDeviceId:toDeviceId,byName:toUser?toUser.name:"مستخدم",byCode:toUser?toUser.radCode:"—"}); }
      socket.emit("friend_accept_success",{withDeviceId:fromDeviceId});
    }catch(e){ console.error(e); }
  });
  socket.on("friend_reject",({fromDeviceId,toDeviceId})=>{
    try{
      const entry=Object.entries(db.friendRequests).find(([id,r])=>r.fromDeviceId===fromDeviceId && r.toDeviceId===toDeviceId && r.status==="pending"); if(!entry) return;
      const [requestId,request]=entry; request.status="rejected"; request.rejectedAt=now(); saveDb();
      const fromSocketId=deviceSockets[fromDeviceId]; if(fromSocketId) io.to(fromSocketId).emit("friend_rejected",{byDeviceId:toDeviceId});
    }catch(e){ console.error(e); }
  });

  socket.on("disconnect",()=>{
    const {deviceId,waveId}=socket.data; if(deviceId && deviceSockets[deviceId]===socket.id) delete deviceSockets[deviceId];
    if(deviceId&&waveId&&db.waves[waveId]?.onlineNow){ delete db.waves[waveId].onlineNow[deviceId]; saveDb(); io.to("wave_"+waveId).emit("wave_members_updated",{members:Object.values(db.waves[waveId].members||{}).map(m=>({id:m.id,name:m.name,isOwner:m.isOwner||false,online:!!(db.waves[waveId].onlineNow&&db.waves[waveId].onlineNow[m.id])}))}); }
    console.log("❌ غادر:",socket.id);
  });
});

server.listen(PORT,()=>{ console.log(`🚀 Server v4.4 FIXED على ${PORT}`); });
