const express = require("express");
const path = require("path");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// تشغيل واجهة التطبيق الموجودة داخل public
app.use(express.static(path.join(__dirname, "public")));

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// إنشاء LiveKit Token
app.get("/token", async (req, res) => {
  try {
    const identity = req.query.identity || "radio-user";
    const requestedRoom = req.query.room || "radio-7F3A";

    // حماية بسيطة لاسم الغرفة
    const room = String(requestedRoom)
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 64);

    if (!room) {
      return res.status(400).json({
        error: "Invalid room name",
      });
    }

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: String(identity).slice(0, 64),
      }
    );

    token.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    res.json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
      room: room,
    });

  } catch (error) {
    console.error("Token error:", error);

    res.status(500).json({
      error: "Failed to create LiveKit token",
    });
  }
});

// فحص حالة الخادم
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Radio Connect",
  });
});

app.listen(PORT, () => {
  console.log(`Radio Connect running on port ${PORT}`);
});
