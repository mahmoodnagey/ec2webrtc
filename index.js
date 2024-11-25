const express = require("express");
const http = require("http");
const socket = require("socket.io");
const fetch = require('node-fetch');
const app = express();

// Set port to 4000 as Nginx will proxy to this port
const port = process.env.PORT || 4000;

// Create server
const server = http.createServer(app);

// Serve static files from 'public' directory
app.use(express.static("public"));

// Health check endpoint for VPN connectivity testing
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'webrtc-server'
    });
});

// Add ROS topics endpoint
app.get('/ros/topics', async (req, res) => {
    try {
        // Forward to robot's ROS2 topic list endpoint
        const response = await fetch('http://robopave:8085/ros/topics');
        const topics = await response.json();
        res.json(topics);
    } catch (error) {
        console.error('ROS topics error:', error);
        res.status(500).json({ error: 'Failed to fetch ROS topics' });
    }
});

// Socket.io setup with CORS enabled
const io = socket(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Function to get ICE servers
async function getIceServers() {
    const xirsysConfig = {
        url: 'https://global.xirsys.net',
        ident: 'mahmoudnagy',
        secret: '4f8fb972-7b24-11ef-a87f-0242ac130002',
        channel: 'MyFirstApp'
    };

    try {
        const response = await fetch(`${xirsysConfig.url}/ice`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${xirsysConfig.ident}:${xirsysConfig.secret}`).toString('base64')
            },
            body: JSON.stringify({
                format: 'urls',
                channel: xirsysConfig.channel
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.v && data.v.iceServers) {
                console.log('Successfully retrieved XirSys ICE servers');
                return data.v.iceServers;
            }
        }
        throw new Error('Failed to get XirSys ICE servers');
    } catch (error) {
        console.warn('Falling back to public STUN servers:', error.message);
        return [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:19302" }
        ];
    }
}

// Socket.io connection handling
io.on("connection", function (socket) {
    console.log("User Connected:", socket.id);

    // Send ICE servers to the client upon connection
    getIceServers()
        .then((iceServers) => {
            socket.emit("iceServers", { iceServers: iceServers });
            console.log("ICE servers sent to client:", socket.id);
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
            console.log(`Room ${roomName} created by ${socket.id}`);
        } else if (room.size == 1) {
            socket.join(roomName);
            socket.emit("joined");
            console.log(`Client ${socket.id} joined room ${roomName}`);
        } else {
            socket.emit("full");
            console.log(`Room ${roomName} is full, client ${socket.id} cannot join`);
        }
        console.log("Current Rooms:", rooms);
    });

    // Handle WebRTC signaling
    socket.on("ready", function (roomName) {
        socket.broadcast.to(roomName).emit("ready");
    });

    socket.on("candidate", function (candidate, roomName) {
        socket.broadcast.to(roomName).emit("candidate", candidate);
    });

    socket.on("offer", function (offer, roomName) {
        socket.broadcast.to(roomName).emit("offer", offer);
    });

    socket.on("answer", function (answer, roomName) {
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
    console.log(`WebRTC signaling server running on port ${port}`);
    console.log(`Health check available at http://localhost:${port}/health`);
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
    process.exit(1);
});