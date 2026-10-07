
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Radio Connect Voice",
    time: new Date().toISOString()
  });
});

const wss = new WebSocketServer({ server });

const rooms = new Map();

function send(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

wss.on("connection", (ws) => {
  let roomId = null;

  send(ws, {
    type: "connected"
  });

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join") {
      roomId = String(msg.room || "").trim();

      if (!roomId) {
        send(ws, {
          type: "error",
          message: "رمز الغرفة مطلوب"
        });
        return;
      }

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }

      const room = rooms.get(roomId);

      if (room.size >= 2) {
        send(ws, {
          type: "error",
          message: "الغرفة ممتلئة"
        });
        return;
      }

      const oldClients = [...room];

      room.add(ws);

      send(ws, {
        type: "joined",
        room: roomId,
        peers: room.size
      });

      for (const peer of oldClients) {
        send(peer, {
          type: "peer-joined"
        });
      }

      return;
    }

    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    for (const peer of room) {
      if (peer !== ws && peer.readyState === 1) {
        send(peer, msg);
      }
    }
  });

  ws.on("close", () => {
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.delete(ws);

    for (const peer of room) {
      send(peer, {
        type: "peer-left"
      });
    }

    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Voice server running on port ${PORT}`);
});
