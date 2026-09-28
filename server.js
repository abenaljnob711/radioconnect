const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Radio Connect is running!");
});

app.listen(PORT, () => {
  console.log(`Radio Connect running on port ${PORT}`);
});
