// Configuration
const config = {
    ec2: {
        address: '3.84.28.236',
        port: 443
    },
    robot: {
        address: 'robopave',  // Using hostname instead of IPv6
        port: 8080
    }
};

let webrtcRosConnection;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;
const RETRY_INTERVAL = 2000; // 2 seconds

function updateStatus(message, isError = false) {
    const statusElement = document.getElementById('connection-status');
    statusElement.textContent = message;
    if (isError) {
        statusElement.style.color = 'red';
    } else {
        statusElement.style.color = 'initial';
    }
    console.log(message);
}

function validateHostname(hostname) {
    // Basic hostname validation
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    return hostnameRegex.test(hostname);
}

async function checkHostAvailability(hostname, port) {
    try {
        const signalingServerPath = `ws://${hostname}:${port}/webrtc`;
        const ws = new WebSocket(signalingServerPath);
        
        return new Promise((resolve, reject) => {
            ws.onopen = () => {
                ws.close();
                resolve(true);
            };
            
            ws.onerror = (error) => {
                reject(new Error(`Failed to connect to ${hostname}:${port}`));
            };

            // Timeout after 5 seconds
            setTimeout(() => {
                ws.close();
                reject(new Error('Connection timeout'));
            }, 5000);
        });
    } catch (error) {
        throw new Error(`Failed to connect to ${hostname}:${port}: ${error.message}`);
    }
}

async function initWebRTC() {
    try {
        updateStatus('Validating connection parameters...');

        // Validate hostname
        if (!validateHostname(config.robot.address)) {
            throw new Error('Invalid hostname format');
        }

        // Check if host is available
        try {
            await checkHostAvailability(config.robot.address, config.robot.port);
            updateStatus('Host is available, establishing WebRTC connection...');
        } catch (error) {
            throw new Error(`Host availability check failed: ${error.message}`);
        }

        // Using secure WebSocket with hostname
        const signalingServerPath = `wss://${config.robot.address}:${config.robot.port}/webrtc`;
        console.log('Connecting to:', signalingServerPath);

        webrtcRosConnection = window.WebrtcRos.createConnection(signalingServerPath);

        // Configure WebRTC connection
        webrtcRosConnection.onConfigurationNeeded = async function() {
            updateStatus('Requesting video stream...');
            try {
                const event = await webrtcRosConnection.addRemoteStream({
                    video: {
                        id: 'subscribed_video',
                        src: 'ros_image:/image_raw'
                    }
                });

                updateStatus('Video stream connected successfully');
                const videoElement = document.getElementById('robot-video');
                videoElement.srcObject = event.stream;
                
                try {
                    await videoElement.play();
                    updateStatus('Video playback started');
                    // Reset connection attempts on successful connection
                    connectionAttempts = 0;
                } catch (error) {
                    throw new Error(`Video playback failed: ${error.message}`);
                }
            } catch (error) {
                throw new Error(`Failed to add remote stream: ${error.message}`);
            }

            webrtcRosConnection.sendConfigure();
        };

        // Set up WebSocket error handling
        webrtcRosConnection.signalingChannel.onerror = function(error) {
            throw new Error(`WebSocket error: ${error.message}`);
        };

        webrtcRosConnection.signalingChannel.onclose = function(event) {
            if (!event.wasClean) {
                throw new Error(`WebSocket connection closed unexpectedly: ${event.reason}`);
            }
        };

        // Initiate connection
        await webrtcRosConnection.connect();
        updateStatus('WebRTC connection established');

    } catch (error) {
        updateStatus(`Connection error: ${error.message}`, true);
        retryConnection();
    }
}

function retryConnection() {
    if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        connectionAttempts++;
        const message = `Connection attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}...`;
        updateStatus(message);
        
        // Exponential backoff for retry delays
        const delay = Math.min(RETRY_INTERVAL * Math.pow(1.5, connectionAttempts - 1), 10000);
        setTimeout(initWebRTC, delay);
    } else {
        updateStatus('Maximum connection attempts reached. Please check the following:', true);
        console.log('Troubleshooting steps:');
        console.log('1. Verify that the hostname "robopave" is properly configured in your DNS or hosts file');
        console.log('2. Ensure the robot is powered on and connected to the network');
        console.log('3. Check if the WebRTC service is running on the robot');
        console.log('4. Verify that port 8080 is open and accessible');
        console.log('5. Check SSL certificate configuration for WSS connection');
    }
}

// Clean up function for proper resource management
function cleanupWebRTC() {
    if (webrtcRosConnection) {
        try {
            webrtcRosConnection.close();
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }
}

// Initialize connection when page loads
window.onload = function() {
    updateStatus('Initializing connection...');
    initWebRTC();
};

// Cleanup on page unload
window.onbeforeunload = cleanupWebRTC;

// Handle visibility changes to manage connection
document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        updateStatus('Page hidden, cleaning up resources...');
        cleanupWebRTC();
    } else {
        updateStatus('Page visible, re-initializing connection...');
        initWebRTC();
    }
});