const express = require("express");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Radio Connect is running!");
});

app.get("/token", async (req, res) => {
  try {
    const identity = req.query.identity || "radio-user";

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: identity,
      }
    );

    token.addGrant({
      roomJoin: true,
      room: "radio-room",
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    res.json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to create LiveKit token",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Radio Connect running on port ${PORT}`);
});
