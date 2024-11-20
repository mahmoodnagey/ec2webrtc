/**
 * WebRTC Client Configuration and Implementation
 */

// Configuration
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
        url: 'https://global.xirsys.net/_turn/MyFirstApp', // Updated URL
        ident: 'mahmoudnagy',
        secret: '1174b892-a746-11ef-ae7d-0242ac130006', // Updated secret
    },
    webrtcOptions: {
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 1
    }
};

// Global variables
let webrtcRosConnection;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 1;
const RETRY_INTERVAL = 2000;

// Get ICE servers configuration
async function getXirSysIceServers() {
    try {
        console.log('Fetching ICE servers from XirSys...');
        const auth = btoa(`${config.xirsys.ident}:${config.xirsys.secret}`);
        
        let response = await fetch(config.xirsys.url, {
            method: "PUT",
            headers: {
                "Authorization": `Basic ${auth}`,
                "Content-Type": "application/json",
            },
            // Add error handling timeout
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
            throw new Error(`XirSys error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (data.v && data.v.iceServers) {
            console.log('Successfully retrieved ICE servers:', data.v.iceServers);
            return data.v.iceServers;
        } else {
            console.warn('Unexpected XirSys response format:', data);
            throw new Error('Invalid ICE servers response format');
        }
    } catch (error) {
        console.warn('Using fallback STUN servers. Error:', error.message);
        return [
            { 
                urls: [
                    "stun:stun1.l.google.com:19302",
                    "stun:stun2.l.google.com:19302",
                ]
            }
        ];
    }
}

// Update status display
function updateStatus(message, isError = false) {
    const statusElement = document.getElementById('connection-status');
    if (statusElement) {
        statusElement.textContent = message;
        statusElement.style.color = isError ? 'red' : 'green';
    }
    console.log(`[WebRTC Status] ${message}`);
}

// Check VPN connection through health endpoint
async function checkVPNConnection() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        console.log('Testing robot connection...');
        const response = await fetch(`https://${config.ec2.address}/robot/health`, {
            signal: controller.signal,
            method: 'GET',
            headers: {
                'Accept': 'application/json'
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

// Add this before initWebRTC
function checkWebRTCAvailability() {
    if (!window.WebrtcRos) {
        throw new Error('WebrtcRos not available. Check if webrtc_ros.js is loaded correctly');
    }
    console.log('WebrtcRos is available');
}

// Update window.onload
window.addEventListener('load', async () => {
    try {
        checkWebRTCAvailability();
        await initWebRTC();
    } catch (error) {
        updateStatus(`Initialization error: ${error.message}`, true);
    }
});

// Initialize WebRTC connection
async function initWebRTC() {
    try {
        updateStatus('Initializing connection...');

        // Check VPN connection first
        await checkVPNConnection();
        updateStatus('Robot connection verified');

        // Get and verify ICE servers
        const iceServers = await getXirSysIceServers();
        if (!iceServers || !iceServers.length) {
            throw new Error('No valid ICE servers available');
        }
        updateStatus('ICE servers obtained');
        console.log('Using ICE servers configuration:', iceServers);

        // Initialize WebRTC connection with verified ICE servers
        const signalingServerPath = `wss://${config.ec2.address}/robot/webrtc`;
        console.log('Connecting to signaling server:', signalingServerPath);

        // Create connection with configuration
        webrtcRosConnection = window.WebrtcRos.createConnection(signalingServerPath, {
            ...config.webrtcOptions,
            iceServers: iceServers
        });

        if (!webrtcRosConnection) {
            throw new Error('Failed to create WebRTC connection object');
        }

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

        // Connect
        try {
            await webrtcRosConnection.connect();
            console.log('WebRTC connection established successfully');
            
            // Only set up error handlers after successful connection
            if (webrtcRosConnection.signalingChannel) {
                webrtcRosConnection.signalingChannel.onclose = (event) => {
                    const reason = event.reason || 'Unknown reason';
                    updateStatus(`Signaling channel closed: ${reason}`, !event.wasClean);
                    if (!event.wasClean) {
                        retryConnection();
                    }
                };
            }

            updateStatus('WebRTC connection established');
        } catch (error) {
            throw new Error(`Connection failed: ${error.message}`);
        }

    } catch (error) {
        console.error('WebRTC initialization error:', error);
        updateStatus(`Connection error: ${error.message}`, true);
        retryConnection();
    }
}

// Retry connection with exponential backoff
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
            '6. Verify network connections and firewalls'
        );
    }
}

// Clean up WebRTC resources
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

// Test connection function
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