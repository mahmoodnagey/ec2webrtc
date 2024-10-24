const express = require("express");
const socket = require("socket.io");
const https = require("https");
const app = express();

const port = process.env.PORT || 4000;

let server = app.listen(port, function () {
  console.log("Server is running on port", port);
});

app.use(express.static("public"));

// Function to get ICE servers from Xirsys
function getIceServers() {
  return new Promise((resolve, reject) => {
    const xirsysOptions = {
      host: "global.xirsys.net",
      path: "/_turn/MyFirstApp",
      method: "PUT",
      headers: {
        "Authorization": "Basic " + Buffer.from("mahmoudnagy:4f8fb972-7b24-11ef-a87f-0242ac130002").toString("base64"),
        "Content-Type": "application/json",
      }
    };

    const req = https.request(xirsysOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const iceServers = JSON.parse(data).v.iceServers;
          console.log("ICE servers fetched:", iceServers);
          resolve(iceServers);
        } catch (error) {
          console.error("Error parsing ICE servers:", error);
          reject(error);
        }
      });
    });

    req.on("error", (error) => {
      console.error("Error fetching ICE servers:", error);
      reject(error);
    });

    req.end();
  });
}

let io = socket(server);

io.on("connection", function (socket) {
  console.log("User Connected:", socket.id);

  // Send ICE servers to the client upon connection
  getIceServers()
    .then((iceServers) => {
      socket.emit("iceServers", { iceServers: iceServers });
    })
    .catch((error) => {
      console.error("Failed to get ICE servers:", error);
      socket.emit("iceServers", { 
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" }
        ] 
      });
    });

  socket.on("join", function (roomName) {
    let rooms = io.sockets.adapter.rooms;
    let room = rooms.get(roomName);

    if (room == undefined) {
      socket.join(roomName);
      socket.emit("created");
    } else if (room.size == 1) {
      socket.join(roomName);
      socket.emit("joined");
    } else {
      socket.emit("full");
    }
    console.log(rooms);
  });

  socket.on("ready", function (roomName) {
    socket.broadcast.to(roomName).emit("ready");
  });

  socket.on("candidate", function (candidate, roomName) {
    console.log("Candidate:", candidate);
    socket.broadcast.to(roomName).emit("candidate", candidate);
  });

  socket.on("offer", function (offer, roomName) {
    socket.broadcast.to(roomName).emit("offer", offer);
  });

  socket.on("answer", function (answer, roomName) {
    socket.broadcast.to(roomName).emit("answer", answer);
  });
});