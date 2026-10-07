const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   فحص الخادم
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Radio Connect",
    livekit: !!(
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET &&
      process.env.LIVEKIT_URL
    ),
    time: new Date().toISOString()
  });
});

/* =========================
   إنشاء معرف جهاز
========================= */

function createDeviceId() {
  return (
    "DEV-" +
    crypto.randomBytes(8).toString("hex")
  );
}

/* =========================
   معلومات الجهاز
========================= */

app.get("/api/device", (req, res) => {
  const deviceId =
    req.headers["x-device-id"] ||
    createDeviceId();

  res.json({
    ok: true,
    deviceId
  });
});

/* =========================
   LiveKit Token
========================= */

app.get("/token", async (req, res) => {
  try {

    const room =
      String(req.query.room || "").trim();

    const deviceId =
      String(
        req.headers["x-device-id"] ||
        req.query.deviceId ||
        ""
      ).trim();

    if (!room) {
      return res.status(400).json({
        ok: false,
        error: "اسم الغرفة مطلوب"
      });
    }

    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET ||
      !process.env.LIVEKIT_URL
    ) {
      return res.status(500).json({
        ok: false,
        error: "LiveKit environment variables are missing"
      });
    }

    const identity =
      deviceId ||
      createDeviceId();

    const token =
      new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        {
          identity,
          name: identity,
          ttl: "2h"
        }
      );

    token.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const jwt =
      await token.toJwt();

    res.json({
      ok: true,
      token: jwt,
      url: process.env.LIVEKIT_URL,
      room,
      identity
    });

  } catch (error) {

    console.error(
      "TOKEN ERROR:",
      error
    );

    res.status(500).json({
      ok: false,
      error: "تعذر إنشاء رمز الاتصال الصوتي"
    });
  }
});

/* =========================
   الصفحة الرئيسية
========================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/* =========================
   تشغيل الخادم
========================= */

app.listen(PORT, () => {

  console.log(
    `Radio Connect server running on port ${PORT}`
  );

  console.log(
    "LiveKit URL:",
    process.env.LIVEKIT_URL
      ? "configured"
      : "MISSING"
  );

  console.log(
    "LiveKit API Key:",
    process.env.LIVEKIT_API_KEY
      ? "configured"
      : "MISSING"
  );

  console.log(
    "LiveKit API Secret:",
    process.env.LIVEKIT_API_SECRET
      ? "configured"
      : "MISSING"
  );
});
