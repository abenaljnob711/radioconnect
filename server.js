const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const devices = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createId(length = 16) {
  return crypto
    .randomBytes(length)
    .toString("hex")
    .slice(0, length);
}

function createRoomCode() {
  let code;

  do {
    code = "";

    const bytes = crypto.randomBytes(6);

    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
  } while (
    Array.from(rooms.values()).some(
      room => room.code === code
    )
  );

  return code;
}

function createRoomId() {
  let roomId;

  do {
    roomId =
      "RAD-" +
      crypto
        .randomBytes(4)
        .toString("hex")
        .toUpperCase();
  } while (rooms.has(roomId));

  return roomId;
}

function cleanText(value, max = 100) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, max);
}

function getDeviceId(req) {
  const value =
    req.body?.deviceId ||
    req.query?.deviceId ||
    req.headers["x-device-id"];

  return cleanText(value, 100);
}

function ensureDevice(deviceId) {
  if (!deviceId) return null;

  if (!devices.has(deviceId)) {
    devices.set(deviceId, {
      deviceId,
      favorites: [],
      createdAt: new Date().toISOString()
    });
  }

  return devices.get(deviceId);
}

function findMember(room, deviceId) {
  if (!room || !deviceId) return null;

  return room.members.find(
    member => member.deviceId === deviceId
  );
}

function findMemberByKey(room, memberKey) {
  if (!room || !memberKey) return null;

  return room.members.find(
    member => member.memberKey === memberKey
  );
}

/*
  لا نرسل deviceId إلى واجهة المستخدم.
  memberKey يستخدم داخليًا لإدارة العضو بدل كشف معرف الجهاز.
*/
function safeMember(member) {
  return {
    memberKey: member.memberKey,
    name: member.name,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt || null,
    requestedAt: member.requestedAt || null,
    approvedAt: member.approvedAt || null
  };
}

function publicRoom(room, deviceId = null) {
  const member = findMember(room, deviceId);
  const isOwner =
    deviceId === room.ownerDeviceId;

  return {
    id: room.id,
    name: room.name,

    /*
      رمز الغرفة يظهر للمشرف فقط.
      الأعضاء العاديون لا يحصلون عليه من هذا الرد.
    */
    roomCode: isOwner ? room.code : null,

    createdAt: room.createdAt,

    memberCount:
      room.members.filter(
        member =>
          member.status === "approved"
      ).length,

    pendingCount:
      room.members.filter(
        member =>
          member.status === "pending"
      ).length,

    isOwner,

    isMember:
      !!member &&
      member.status === "approved",

    isPending:
      !!member &&
      member.status === "pending",

    favorite:
      !!deviceId &&
      devices.get(deviceId)?.favorites?.includes(
        room.id
      ) === true
  };
}

function findRoomByCode(code) {
  const normalized = cleanText(
    code,
    20
  ).toUpperCase();

  return Array.from(rooms.values()).find(
    room => room.code === normalized
  );
}

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
   الجهاز
========================= */

app.post("/api/device", (req, res) => {
  let deviceId = getDeviceId(req);

  if (!deviceId) {
    deviceId =
      "DEV-" +
      createId(16);
  }

  ensureDevice(deviceId);

  /*
    المعرف يستخدم داخليًا فقط.
    لا نعتمد عليه كرمز للغرفة.
  */
  res.json({
    success: true,
    deviceReady: true
  });
});

/* =========================
   إنشاء غرفة
========================= */

app.post("/api/rooms", (req, res) => {
  try {
    const deviceId = getDeviceId(req);

    const name = cleanText(
      req.body.name,
      60
    );

    if (!deviceId) {
      return res.status(400).json({
        error: "Device ID is required"
      });
    }

    if (!name) {
      return res.status(400).json({
        error: "Room name is required"
      });
    }

    ensureDevice(deviceId);

    const roomId =
      createRoomId();

    const roomCode =
      createRoomCode();

    const ownerMember = {
      memberKey:
        "M-" + createId(12),

      deviceId,

      name:
        cleanText(
          req.body.memberName,
          50
        ) ||
        "مسؤول الغرفة",

      role: "owner",

      status: "approved",

      joinedAt:
        new Date().toISOString()
    };

    const room = {
      id: roomId,

      code: roomCode,

      name,

      ownerDeviceId:
        deviceId,

      createdAt:
        new Date().toISOString(),

      members: [
        ownerMember
      ]
    };

    rooms.set(
      roomId,
      room
    );

    res.json({
      success: true,

      room: publicRoom(
        room,
        deviceId
      ),

      roomId,

      /*
        الرمز يظهر للمشرف عند إنشاء الغرفة.
      */
      roomCode
    });

  } catch (error) {
    console.error(
      "Create room error:",
      error
    );

    res.status(500).json({
      error:
        "Failed to create room"
    });
  }
});

/* =========================
   قائمة الغرف
========================= */

app.get("/api/rooms", (req, res) => {
  const deviceId =
    getDeviceId(req);

  const result =
    Array.from(
      rooms.values()
    ).map(room =>
      publicRoom(
        room,
        deviceId
      )
    );

  res.json({
    success: true,
    rooms: result
  });
});

/* =========================
   غرفة بواسطة ID
========================= */

app.get(
  "/api/rooms/:roomId",
  (req, res) => {
    const roomId =
      cleanText(
        req.params.roomId,
        64
      );

    const deviceId =
      getDeviceId(req);

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        error:
          "Room not found"
      });
    }

    res.json({
      success: true,

      room:
        publicRoom(
          room,
          deviceId
        )
    });
  }
);

/* =========================
   العثور على غرفة بواسطة الرمز
========================= */

app.post(
  "/api/rooms/lookup",
  (req, res) => {
    const code =
      cleanText(
        req.body.code,
        20
      ).toUpperCase();

    if (!code) {
      return res.status(400).json({
        error:
          "Room code is required"
      });
    }

    const room =
      findRoomByCode(code);

    if (!room) {
      return res.status(404).json({
        error:
          "Invalid room code"
      });
    }

    res.json({
      success: true,

      room: {
        id: room.id,
        name: room.name,
        memberCount:
          room.members.filter(
            member =>
              member.status ===
              "approved"
          ).length
      }
    });
  }
);

/* =========================
   طلب الانضمام بواسطة الرمز
========================= */

app.post(
  "/api/rooms/join",
  (req, res) => {
    const deviceId =
      getDeviceId(req);

    const code =
      cleanText(
        req.body.code,
        20
      ).toUpperCase();

    const memberName =
      cleanText(
        req.body.memberName,
        50
      ) ||
      "جهاز جديد";

    if (!deviceId) {
      return res.status(400).json({
        error:
          "Device ID is required"
      });
    }

    if (!code) {
      return res.status(400).json({
        error:
          "Room code is required"
      });
    }

    const room =
      findRoomByCode(code);

    if (!room) {
      return res.status(404).json({
        error:
          "Invalid room code"
      });
    }

    ensureDevice(deviceId);

    if (
      deviceId ===
      room.ownerDeviceId
    ) {
      return res.json({
        success: true,

        status:
          "approved",

        roomId:
          room.id,

        message:
          "Owner access granted"
      });
    }

    let member =
      findMember(
        room,
        deviceId
      );

    if (member) {
      return res.json({
        success: true,

        status:
          member.status,

        roomId:
          room.id,

        message:
          member.status ===
          "approved"
            ? "Already approved"
            : "Waiting for owner approval"
      });
    }

    member = {
      memberKey:
        "M-" + createId(12),

      deviceId,

      name:
        memberName,

      role:
        "member",

      status:
        "pending",

      requestedAt:
        new Date().toISOString()
    };

    room.members.push(
      member
    );

    res.json({
      success: true,

      status:
        "pending",

      roomId:
        room.id,

      message:
        "Join request sent to room owner"
    });
  }
);

/* =========================
   حالة طلب الانضمام
========================= */

app.get(
  "/api/rooms/:roomId/status",
  (req, res) => {
    const roomId =
      cleanText(
        req.params.roomId,
        64
      );

    const deviceId =
      getDeviceId(req);

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        error:
          "Room not found"
      });
    }

    const member =
      findMember(
        room,
        deviceId
      );

    res.json({
      success: true,

      status:
        member
          ? member.status
          : "not_requested",

      isOwner:
        deviceId ===
        room.ownerDeviceId
    });
  }
);

/* =========================
   أعضاء الغرفة
========================= */

app.get(
  "/api/rooms/:roomId/members",
  (req, res) => {
    const roomId =
      cleanText(
        req.params.roomId,
        64
      );

    const deviceId =
      getDeviceId(req);

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        error:
          "Room not found"
      });
    }

    const currentMember =
      findMember(
        room,
        deviceId
      );

    if (
      deviceId !==
        room.ownerDeviceId &&
      (!currentMember ||
        currentMember.status !==
          "approved")
    ) {
      return res.status(403).json({
        error:
          "Access denied"
      });
    }

    /*
      لا نرسل deviceId إطلاقًا.
    */
    res.json({
      success: true,

      members:
        room.members.map(
          safeMember
        )
    });
  }
);

/* =========================
   الموافقة على عضو
========================= */

app.post(
  "/api/rooms/:roomId/members/:memberKey/approve",
  (req, res) => {
    const roomId =
      cleanText(
        req.params.roomId,
        64
      );

    const memberKey =
      cleanText(
        req.params.memberKey,
        100
      );

    const ownerDeviceId =
      getDeviceId(req);

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        error:
          "Room not found"
      });
    }

    if (
      room.ownerDeviceId !==
      ownerDeviceId
    ) {
      return res.status(403).json({
        error:
          "Only room owner can approve members"
      });
    }

    const member =
      findMemberByKey(
        room,
        memberKey
      );

    if (!member) {
      return res.status(404).json({
        error:
          "Member not found"
      });
    }

    member.status =
      "approved";

    member.approvedAt =
      new Date().toISOString();

    res.json({
      success: true,

      message:
        "Member approved"
    });
  }
);

/* =========================
   رفض عضو
========================= */

app.post(
  "/api/rooms/:roomId/members/:memberKey/reject",
  (req, res) => {
    const roomId =
      cleanText(
        req.params.roomId,
        64
      );

    const memberKey =
      cleanText(
        req.params.memberKey,
        100
      );

    const ownerDeviceId =
      getDeviceId(req);

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        error:
          "Room not found"
      });
    }

    if (
      room.ownerDeviceId !==
      ownerDeviceId
    ) {
      return res.status(403).json({
        error:
          "Only room owner can reject members"
      });
    }

    const index =
      room.members.findIndex(
        member =>
          member.memberKey ===
          memberKey
      );

    if (index === -1) {
      return res.status(404).json({
        error:
          "Member not found"
      });
    }

    if (
      room.members[index].role ===
      "owner"
    ) {
      return res.status(400).json({
        error:
          "Owner cannot be removed"
      });
    }

    room.members.splice(
      index,
      1
    );

    res.json({
      success: true,

      message:
        "Join request rejected"
    });
  }
);

/* =========================
   حذف عضو
========================= */

app.delete(
  "/api/rooms/:roomId/members/:memberKey",
  (req, res) => {
    const roomId =
      cleanText(
        req.params.roomId,
        64
      );

    const memberKey =
      cleanText(
        req.params.memberKey,
        100
      );

    const ownerDeviceId =
      getDeviceId(req);

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        error:
          "Room not found"
      });
    }

    if (
      room.ownerDeviceId !==
      ownerDeviceId
    ) {
      return res.status(403).json({
        error:
          "Only room owner can remove members"
      });
    }

    const index =
      room.members.findIndex(
        member =>
          member.memberKey ===
          memberKey
      );

    if (index === -1) {
      return res.status(404).json({
        error:
          "Member not found"
      });
    }

    if (
      room.members[index].role ===
      "owner"
    ) {
      return res.status(400).json({
        error:
          "Owner cannot be removed"
      });
    }

    room.members.splice(
      index,
      1
    );

    res.json({
      success: true,

      message:
        "Member removed"
    });
  }
);

/* =========================
   حذف الغرفة
========================= */

app.delete(
  "/api/rooms/:roomId",
  (req, res) => {
    const roomId =
      cleanText(
        req.params.roomId,
        64
      );

    const deviceId =
      getDeviceId(req);

    const room =
      rooms.get(roomId);

    if (!room) {
      return res.status(404).json({
        error:
          "Room not found"
      });
    }

    if (
      room.ownerDeviceId !==
      deviceId
    ) {
      return res.status(403).json({
        error:
          "Only room owner can delete the room"
      });
    }

    rooms.delete(
      roomId
    );

    for (
      const device
      of devices.values()
    ) {
      device.favorites =
        device.favorites.filter(
          id =>
            id !== roomId
        );
    }

    res.json({
      success: true,

      message:
        "Room deleted"
    });
  }
);

/* =========================
   المفضلة
========================= */

app.post(
  "/api/rooms/:roomId/favorite",
  (req, res) => {
    const roomId =
      cleanText(
        req.params.roomId,
        64
      );

    const deviceId =
      getDeviceId(req);

    if (!deviceId) {
      return res.status(400).json({
        error:
          "Device ID is required"
      });
    }

    if (!rooms.has(roomId)) {
      return res.status(404).json({
        error:
          "Room not found"
      });
    }

    const device =
      ensureDevice(
        deviceId
      );

    const index =
      device.favorites.indexOf(
        roomId
      );

    if (index === -1) {
      device.favorites.push(
        roomId
      );

      return res.json({
        success: true,
        favorite: true
      });
    }

    device.favorites.splice(
      index,
      1
    );

    res.json({
      success: true,
      favorite: false
    });
  }
);

app.get(
  "/api/favorites",
  (req, res) => {
    const deviceId =
      getDeviceId(req);

    if (!deviceId) {
      return res.status(400).json({
        error:
          "Device ID is required"
      });
    }

    const device =
      devices.get(deviceId);

    if (!device) {
      return res.json({
        success: true,
        rooms: []
      });
    }

    const favoriteRooms =
      device.favorites
        .map(
          roomId =>
            rooms.get(roomId)
        )
        .filter(Boolean)
        .map(
          room =>
            publicRoom(
              room,
              deviceId
            )
        );

    res.json({
      success: true,

      rooms:
        favoriteRooms
    });
  }
);

/* =========================
   LiveKit Token
========================= */

app.get(
  "/token",
  async (req, res) => {
    try {
      const identity =
        cleanText(
          req.query.identity ||
            "",
          64
        );

      const roomId =
        cleanText(
          req.query.room ||
            "",
          64
        );

      const deviceId =
        cleanText(
          req.query.deviceId ||
            identity,
          100
        );

      if (!identity) {
        return res.status(400).json({
          error:
            "Identity is required"
        });
      }

      if (!roomId) {
        return res.status(400).json({
          error:
            "Room is required"
        });
      }

      const room =
        rooms.get(roomId);

      if (!room) {
        return res.status(404).json({
          error:
            "Room not found"
        });
      }

      const member =
        findMember(
          room,
          deviceId
        );

      const isOwner =
        deviceId ===
        room.ownerDeviceId;

      const isApproved =
        member &&
        member.status ===
          "approved";

      if (
        !isOwner &&
        !isApproved
      ) {
        return res.status(403).json({
          error:
            "You are not approved to join this room"
        });
      }

      if (
        !process.env.LIVEKIT_API_KEY ||
        !process.env.LIVEKIT_API_SECRET ||
        !process.env.LIVEKIT_URL
      ) {
        return res.status(500).json({
          error:
            "LiveKit environment variables are missing"
        });
      }

      const token =
        new AccessToken(
          process.env.LIVEKIT_API_KEY,
          process.env.LIVEKIT_API_SECRET,
          {
            identity
          }
        );

      token.addGrant({
        roomJoin: true,

        room:
          roomId,

        canPublish:
          true,

        canSubscribe:
          true
      });

      const jwt =
        await token.toJwt();

      res.json({
        success: true,

        token: jwt,

        url:
          process.env.LIVEKIT_URL,

        room:
          roomId,

        identity
      });

    } catch (error) {
      console.error(
        "Token error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to create LiveKit token"
      });
    }
  }
);

/* =========================
   Health
========================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",

      service:
        "جهاز لاسلكي",

      rooms:
        rooms.size,

      uptime:
        process.uptime(),

      time:
        new Date().toISOString()
    });
  }
);

/* =========================
   الأخطاء
========================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "Server error:",
      err
    );

    res.status(500).json({
      error:
        "Internal server error"
    });
  }
);

/* =========================
   تشغيل الخادم
========================= */

app.listen(
  PORT,
  () => {
    console.log(
      "================================="
    );

    console.log(
      "جهاز لاسلكي"
    );

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      "================================="
    );
  }
);
