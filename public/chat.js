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
        port: 8085,
        nginxPort: 8080
    },
    xirsys: {
        url: 'https://global.xirsys.net/_turn/MyFirstApp',
        ident: 'mahmoudnagy',
        secret: '1174b892-a746-11ef-ae7d-0242ac130006',
    },
    webrtcOptions: {
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 1
    }
};

// Constants
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000;
const STREAM_STALL_THRESHOLD = 3000; // 3 seconds
const QUALITY_CHECK_INTERVAL = 5000;
const HIGH_PACKET_LOSS_THRESHOLD = 10; // 10%

// Global variables
let webrtcRosConnection = null;
let connectionAttempts = 0;
let qualityCheckInterval = null;
let streamMonitorInterval = null;

// Utility functions
function updateStatus(message, isError = false) {
    const statusElement = document.getElementById('connection-status');
    if (statusElement) {
        statusElement.textContent = message;
        statusElement.style.color = isError ? 'red' : 'green';
    }
    console.log(`[WebRTC Status] ${message}`);
}

// Clean up function
async function cleanupWebRTC() {
    console.log('Starting cleanup...');
    
    // Clear monitoring intervals
    if (qualityCheckInterval) {
        clearInterval(qualityCheckInterval);
        qualityCheckInterval = null;
    }
    if (streamMonitorInterval) {
        clearInterval(streamMonitorInterval);
        streamMonitorInterval = null;
    }

    // Clean up video element
    const videoElement = document.getElementById('robot-video');
    if (videoElement) {
        if (videoElement.srcObject) {
            videoElement.srcObject.getTracks().forEach(track => {
                track.stop();
                console.log(`Stopped track: ${track.kind}`);
            });
            videoElement.srcObject = null;
        }
        videoElement.removeAttribute('src');
        videoElement.load();
    }

    // Close WebRTC connection
    if (webrtcRosConnection) {
        try {
            await webrtcRosConnection.close();
            webrtcRosConnection = null;
            console.log('WebRTC connection closed');
        } catch (error) {
            console.error('Error during WebRTC cleanup:', error);
        }
    }
    
    updateStatus('Connection cleaned up');
}


// ICE Server configuration
async function getXirSysIceServers() {
    try {
        console.log('Fetching ICE servers from XirSys...');
        const auth = btoa(`${config.xirsys.ident}:${config.xirsys.secret}`);
        
        const response = await fetch(config.xirsys.url, {
            method: "PUT",
            headers: {
                "Authorization": `Basic ${auth}`,
                "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
            throw new Error(`XirSys error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (data.v && data.v.iceServers) {
            console.log('Successfully retrieved ICE servers');
            return data.v.iceServers;
        }
        throw new Error('Invalid ICE servers response');
    } catch (error) {
        console.warn('Using fallback STUN servers:', error);
        return [{
            urls: [
                "stun:stun1.l.google.com:19302",
                "stun:stun2.l.google.com:19302"
            ]
        }];
    }
}

// Connection verification
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

// ROS Topic verification
async function verifyRosTopic() {
    try {
        const response = await fetch(`https://${config.ec2.address}/robot/ros/topics`);
        const topics = await response.json();
        
        if (!topics.includes('/image_raw')) {
            throw new Error('Camera topic not found');
        }
        return true;
    } catch (error) {
        console.error('ROS topic verification failed:', error);
        return false;
    }
}

// Stream quality monitoring
function monitorStreamQuality(videoElement) {
    if (!videoElement) return;
    
    if (streamMonitorInterval) {
        clearInterval(streamMonitorInterval);
    }
    
    let lastFrameTime = Date.now();
    let frameCounter = 0;
    let lastFrameCount = 0;
    
    videoElement.addEventListener('timeupdate', () => {
        lastFrameTime = Date.now();
        frameCounter++;
    });

    streamMonitorInterval = setInterval(() => {
        // Check if video is stalled
        const timeSinceLastFrame = Date.now() - lastFrameTime;
        if (timeSinceLastFrame > STREAM_STALL_THRESHOLD) {
            updateStatus('Video stream stalled', true);
            retryConnection();
            return;
        }

        // Calculate FPS
        const fps = frameCounter - lastFrameCount;
        lastFrameCount = frameCounter;
        
        if (fps < 10) { // Alert on low FPS
            console.warn(`Low FPS detected: ${fps}`);
        }

        // Check video element state
        if (videoElement.paused || videoElement.ended) {
            updateStatus('Video stream stopped', true);
            retryConnection();
        }
    }, 1000);
}

// Connection quality monitoring
function monitorConnectionQuality() {
    if (qualityCheckInterval) {
        clearInterval(qualityCheckInterval);
    }

    qualityCheckInterval = setInterval(async () => {
        if (!webrtcRosConnection?.peerConnection) return;
        
        try {
            const stats = await webrtcRosConnection.peerConnection.getStats();
            
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    // Calculate packet loss
                    const packetsLost = report.packetsLost || 0;
                    const packetsReceived = report.packetsReceived || 0;
                    const total = packetsLost + packetsReceived;
                    
                    if (total > 0) {
                        const lossRate = (packetsLost / total) * 100;
                        if (lossRate > HIGH_PACKET_LOSS_THRESHOLD) {
                            updateStatus(`High packet loss: ${lossRate.toFixed(1)}%`, true);
                        }
                    }

                    // Monitor other metrics
                    if (report.jitter > 50) {
                        console.warn(`High jitter detected: ${report.jitter}ms`);
                    }
                    
                    if (report.frameWidth && report.frameHeight) {
                        console.log(`Resolution: ${report.frameWidth}x${report.frameHeight}`);
                    }
                }
            });
        } catch (error) {
            console.error('Stats collection error:', error);
        }
    }, QUALITY_CHECK_INTERVAL);
}

// Connection retry mechanism
async function retryConnection() {
    if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
        updateStatus('Max reconnection attempts reached', true);
        return;
    }

    connectionAttempts++;
    const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, connectionAttempts - 1), 10000);
    
    updateStatus(`Reconnecting (${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delay/1000}s...`);
    
    await cleanupWebRTC();
    
    setTimeout(async () => {
        try {
            await initWebRTC();
        } catch (error) {
            console.error('Reconnection attempt failed:', error);
            retryConnection();
        }
    }, delay);
}

// Initialize WebRTC connection
async function initWebRTC() {
    try {
        updateStatus('Initializing connection...');

        // Verify connections
        await checkVPNConnection();
        updateStatus('Robot connection verified');

        if (!await verifyRosTopic()) {
            throw new Error('Required ROS topics not available');
        }

        // Get ICE servers
        const iceServers = await getXirSysIceServers();
        if (!iceServers || !iceServers.length) {
            throw new Error('No valid ICE servers available');
        }
        updateStatus('ICE servers obtained');

        // Initialize WebRTC connection
        const signalingServerPath = `https://${config.ec2.address}/robot/webrtc`;
        console.log('Connecting to signaling server:', signalingServerPath);

        webrtcRosConnection = window.WebrtcRos.createConnection(signalingServerPath, {
            ...config.webrtcOptions,
            iceServers: iceServers
        });

        if (!webrtcRosConnection) {
            throw new Error('Failed to create WebRTC connection');
        }

        // Set up ICE connection monitoring
        webrtcRosConnection.peerConnection.oniceconnectionstatechange = () => {
            const state = webrtcRosConnection.peerConnection.iceConnectionState;
            console.log('ICE Connection State:', state);
            
            switch(state) {
                case 'checking':
                    updateStatus('Establishing connection...');
                    break;
                case 'connected':
                    updateStatus('Connection established');
                    connectionAttempts = 0; // Reset counter on successful connection
                    break;
                case 'disconnected':
                    updateStatus('Connection lost', true);
                    retryConnection();
                    break;
                case 'failed':
                    updateStatus('Connection failed', true);
                    retryConnection();
                    break;
                case 'closed':
                    updateStatus('Connection closed');
                    break;
            }
        };

        // Configure video stream
        webrtcRosConnection.onConfigurationNeeded = async function() {
            try {
                updateStatus('Setting up video stream...');
                
                const streamConfig = {
                    video: {
                        id: 'subscribed_video',
                        src: 'ros_image:/image_raw'
                    }
                };
                
                const event = await webrtcRosConnection.addRemoteStream(streamConfig);
                if (!event || !event.stream) {
                    throw new Error('No stream received');
                }

                const videoElement = document.getElementById('robot-video');
                if (!videoElement) {
                    throw new Error('Video element not found');
                }

                videoElement.srcObject = event.stream;
                videoElement.onloadedmetadata = () => {
                    console.log('Video metadata loaded');
                    videoElement.play().catch(console.error);
                };

                // Start monitoring
                monitorStreamQuality(videoElement);
                monitorConnectionQuality();

                webrtcRosConnection.sendConfigure();
                updateStatus('Video stream configured');
                
            } catch (error) {
                console.error('Stream setup error:', error);
                updateStatus('Stream setup failed', true);
                throw error;
            }
        };

        await webrtcRosConnection.connect();
        console.log('WebRTC connection established');

    } catch (error) {
        console.error('WebRTC initialization error:', error);
        updateStatus(`Connection error: ${error.message}`, true);
        throw error;
    }
}

// Test connection
async function testConnection() {
    try {
        updateStatus('Testing connection...');
        await checkVPNConnection();
        updateStatus('Connection test successful!');
    } catch (error) {
        updateStatus(`Connection test failed: ${error.message}`, true);
    }
}

// Event listeners
window.addEventListener('load', initWebRTC);

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        cleanupWebRTC();
    } else {
        initWebRTC();
    }
});

// Export functions for global access
window.initWebRTC = initWebRTC;
window.testConnection = testConnection;