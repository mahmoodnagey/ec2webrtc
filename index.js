const express = require("express");
const http = require("http");  // Changed to http since Nginx handles SSL
const socket = require("socket.io");
const app = express();

// Set port to 4000 as Nginx will proxy to this port
const port = process.env.PORT || 4000;

// Create server
const server = http.createServer(app);

// Serve static files from 'public' directory
app.use(express.static("public"));

// Socket.io setup with CORS enabled
const io = socket(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Function to get ICE servers
function getIceServers() {
    return new Promise((resolve) => {
        // Using Google's public STUN servers and custom STUN/TURN servers for IPv6
        const iceServers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:19302" }
        ];
        resolve(iceServers);
    });
}

// Socket.io connection handling
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
                    { urls: "stun:stun.l.google.com:19302" },
                    { urls: "stun:stun1.l.google.com:19302" }
                ] 
            });
        });

    // Handle room joining
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
        console.log("Rooms:", rooms);
    });

    // Handle ready signal
    socket.on("ready", function (roomName) {
        socket.broadcast.to(roomName).emit("ready");
    });

    // Handle ICE candidates
    socket.on("candidate", function (candidate, roomName) {
        console.log("Received candidate for room:", roomName);
        socket.broadcast.to(roomName).emit("candidate", candidate);
    });

    // Handle offers
    socket.on("offer", function (offer, roomName) {
        console.log("Received offer for room:", roomName);
        socket.broadcast.to(roomName).emit("offer", offer);
    });

    // Handle answers
    socket.on("answer", function (answer, roomName) {
        console.log("Received answer for room:", roomName);
        socket.broadcast.to(roomName).emit("answer", answer);
    });

    // Handle disconnection
    socket.on("disconnect", function() {
        console.log("User Disconnected:", socket.id);
    });
});

// Error handling
server.on('error', (error) => {
    console.error('Server error:', error);
});

// Start server
server.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
});

// Handle process termination
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Performing graceful shutdown...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Received SIGINT. Performing graceful shutdown...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Perform any necessary cleanup here
    process.exit(1);
});