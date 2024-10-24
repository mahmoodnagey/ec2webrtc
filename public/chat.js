// let robotAddress = 'localhost';  // Change this to your robot's IP if not running locally
let robotAddress = '192.168.1.155';  // Change this to your robot's IP if not running locally

let robotPort = '8080';

let webrtcRosConnection;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;

function updateStatus(message) {
    document.getElementById('connection-status').textContent = message;
    console.log(message);
}

function initWebRTC() {
    updateStatus('Initializing WebRTC connection...');
    
    const signalingServerPath = `ws://${robotAddress}:${robotPort}/webrtc`;
    webrtcRosConnection = window.WebrtcRos.createConnection(signalingServerPath);

    webrtcRosConnection.onConfigurationNeeded = function() {
        updateStatus('Configuration needed, requesting video stream');
        webrtcRosConnection.addRemoteStream({
            video: {
                id: 'subscribed_video',
                src: 'ros_image:/image_raw'
            }
        }).then(function(event) {
            updateStatus('Remote stream added');
            const videoElement = document.getElementById('robot-video');
            videoElement.srcObject = event.stream;
            videoElement.onloadedmetadata = function(e) {
                videoElement.play().catch(function(error) {
                    console.error('Error playing video:', error);
                });
            };
        }).catch(function(error) {
            updateStatus('Error adding remote stream: ' + error);
            retryConnection();
        });

        webrtcRosConnection.sendConfigure();
    };

    webrtcRosConnection.connect();
    console.log('WebRTC connection initiated');

    webrtcRosConnection.signalingChannel.onerror = function(error) {
        console.error('WebSocket error:', error);
        retryConnection();
    };

    webrtcRosConnection.signalingChannel.onclose = function(event) {
        console.log('WebSocket connection closed:', event);
        retryConnection();
    };
}

function retryConnection() {
    if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        connectionAttempts++;
        updateStatus(`Connection attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}...`);
        setTimeout(initWebRTC, 2000);  // Wait 2 seconds before retrying
    } else {
        updateStatus('Max connection attempts reached. Please refresh the page to try again.');
    }
}

// Call initWebRTC when the page loads
window.onload = function() {
    updateStatus('Page loaded, initializing WebRTC...');
    initWebRTC();
};