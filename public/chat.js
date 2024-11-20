const config = {
    ec2: {
        address: '3.84.28.236',
        port: 443
    },
    robot: {
        address: 'robopave',
        port: 8080,
    },
    xirsys: {
        url: 'https://global.xirsys.net',
        ident: 'mahmoudnagy',
        secret: '4f8fb972-7b24-11ef-a87f-0242ac130002',
        channel: 'MyFirstApp'
    },
    webrtcOptions: {
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 1
    }
};

let webrtcRosConnection;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;
const RETRY_INTERVAL = 2000;

async function getXirSysIceServers() {
    try {
        const response = await fetch(`${config.xirsys.url}/ice`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + btoa(`${config.xirsys.ident}:${config.xirsys.secret}`)
            },
            body: JSON.stringify({
                format: 'urls',
                channel: config.xirsys.channel
            })
        });

        if (!response.ok) {
            throw new Error(`XirSys HTTP error: ${response.status}`);
        }

        const data = await response.json();
        if (data.v && data.v.iceServers) {
            console.log('Successfully retrieved XirSys ICE servers');
            return data.v.iceServers;
        } else {
            throw new Error('Invalid XirSys response format');
        }
    } catch (error) {
        console.error('Error fetching XirSys ICE servers:', error);
        return [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" }
        ];
    }
}

function updateStatus(message, isError = false) {
    const statusElement = document.getElementById('connection-status');
    if (statusElement) {
        statusElement.textContent = message;
        statusElement.style.color = isError ? 'red' : 'green';
    }
    console.log(`[WebRTC Status] ${message}`);
}

async function checkVPNConnection() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        console.log('Testing robot connection...');
        const response = await fetch("https://robopave:8080/health", {
        // const response = await fetch(`https://${config.robot.address}:${config.robot.port}/health`, {
            signal: controller.signal,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Origin': `https://${config.ec2.address}`
            }
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Robot health check response:', data);
        return true;
    } catch (error) {
        console.error('Robot health check failed:', error);
        throw error;
    }
}

async function initWebRTC() {
    try {
        updateStatus('Initializing connection...');

        // Check VPN connection first
        await checkVPNConnection();
        updateStatus('Robot connection verified');

        // Get XirSys ICE servers
        const iceServers = await getXirSysIceServers();
        updateStatus('ICE servers obtained');

        // Initialize WebRTC connection
        const signalingServerPath = `wss://${config.robot.address}:${config.robot.port}/webrtc`;
        console.log('Connecting to signaling server:', signalingServerPath);

        webrtcRosConnection = window.WebrtcRos.createConnection(signalingServerPath, {
            ...config.webrtcOptions,
            iceServers: iceServers,
        });

        // Handle ICE connection states
        webrtcRosConnection.oniceconnectionstatechange = (event) => {
            const state = webrtcRosConnection.iceConnectionState;
            updateStatus(`ICE Connection: ${state}`);
            
            switch (state) {
                case 'checking':
                    console.log('Establishing ICE connection...');
                    break;
                case 'connected':
                case 'completed':
                    console.log('ICE connection established');
                    break;
                case 'failed':
                    console.error('ICE connection failed');
                    retryConnection();
                    break;
                case 'disconnected':
                    console.warn('ICE connection disconnected');
                    break;
            }
        };

        // Configure video stream
        webrtcRosConnection.onConfigurationNeeded = async function() {
            updateStatus('Setting up video stream...');
            try {
                const event = await webrtcRosConnection.addRemoteStream({
                    video: {
                        id: 'subscribed_video',
                        src: 'ros_image:/image_raw'
                    }
                });

                const videoElement = document.getElementById('robot-video');
                if (!videoElement) {
                    throw new Error('Video element not found');
                }

                videoElement.srcObject = event.stream;
                await videoElement.play();
                
                updateStatus('Video stream active');
                connectionAttempts = 0;

                // Monitor video stream health
                const videoTrack = event.stream.getVideoTracks()[0];
                if (videoTrack) {
                    videoTrack.onended = () => {
                        updateStatus('Video track ended', true);
                        retryConnection();
                    };
                    videoTrack.onmute = () => {
                        updateStatus('Video track muted', true);
                    };
                    videoTrack.onunmute = () => {
                        updateStatus('Video track active');
                    };
                }

            } catch (error) {
                throw new Error(`Stream setup failed: ${error.message}`);
            }

            webrtcRosConnection.sendConfigure();
        };

        // WebSocket error handling
        webrtcRosConnection.signalingChannel.onerror = function(error) {
            updateStatus(`Signaling error: ${error.message}`, true);
            console.error('WebSocket error:', error);
        };

        webrtcRosConnection.signalingChannel.onclose = function(event) {
            const reason = event.reason || 'Unknown reason';
            updateStatus(`Signaling channel closed: ${reason}`, !event.wasClean);
            if (!event.wasClean) {
                retryConnection();
            }
        };

        await webrtcRosConnection.connect();
        updateStatus('WebRTC connection established');

    } catch (error) {
        updateStatus(`Connection error: ${error.message}`, true);
        retryConnection();
    }
}

async function retryConnection() {
    if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        connectionAttempts++;
        const delay = Math.min(RETRY_INTERVAL * Math.pow(1.5, connectionAttempts - 1), 10000);
        
        updateStatus(`Retrying connection ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS} in ${delay/1000}s...`);
        
        await cleanupWebRTC();
        setTimeout(initWebRTC, delay);
    } else {
        updateStatus('Connection failed after maximum attempts', true);
        console.error(
            'Troubleshooting guide:\n',
            '1. Verify Husarnet VPN status:\n',
            `   husarnet status\n`,
            '2. Check robot connectivity:\n',
            `   ping ${config.robot.address}\n`,
            '3. Verify WebRTC service on robot:\n',
            `   sudo systemctl status webrtc-service\n`,
            '4. Check ROS2 camera node:\n',
            '   ros2 topic list\n',
            '   ros2 topic echo /image_raw\n',
            '5. Review WebRTC logs:\n',
            '   browser console (F12)\n',
            '   robot webrtc service logs\n',
            '6. Verify XirSys credentials and service status'
        );
    }
}

async function cleanupWebRTC() {
    if (webrtcRosConnection) {
        try {
            const videoElement = document.getElementById('robot-video');
            if (videoElement && videoElement.srcObject) {
                videoElement.srcObject.getTracks().forEach(track => {
                    track.stop();
                    console.log(`Stopped track: ${track.kind}`);
                });
                videoElement.srcObject = null;
            }
            
            await webrtcRosConnection.close();
            webrtcRosConnection = null;
            updateStatus('Connection cleaned up');
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }
}

async function testConnection() {
    try {
        updateStatus('Testing robot connection...');
        await checkVPNConnection();
        updateStatus('Robot connection test successful!');
    } catch (error) {
        updateStatus(`Connection test failed: ${error.message}`, true);
    }
}

// Event Listeners
document.addEventListener('visibilitychange', async function() {
    if (document.hidden) {
        updateStatus('Page hidden, cleaning up...');
        await cleanupWebRTC();
    } else {
        updateStatus('Page visible, reconnecting...');
        initWebRTC();
    }
});

// Initialize on page load
window.addEventListener('load', initWebRTC);

// Cleanup on page unload
window.addEventListener('beforeunload', cleanupWebRTC);

// Make functions globally available
window.initWebRTC = initWebRTC;
window.cleanupWebRTC = cleanupWebRTC;
window.testConnection = testConnection;