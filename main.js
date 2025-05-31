// DOM Elements
const displayNameInput = document.getElementById('displayName');
const joinBtn = document.getElementById('joinBtn');
const warningMessage = document.getElementById('warningMessage');
const welcomeSection = document.getElementById('welcomeSection');
const channelSection = document.getElementById('channelSection');
const usersList = document.getElementById('usersList');
const muteBtn = document.getElementById('muteBtn');
const deafenBtn = document.getElementById('deafenBtn');
const leaveBtn = document.getElementById('leaveBtn');

// State
let localStream = null;
let peerConnections = {};
let isMuted = false;
let isDeafened = false;
let displayName = '';
let socket = null;

// Initialize WebRTC
async function initializeWebRTC() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        setupAudioContext();
    } catch (error) {
        showWarning('Error accessing microphone. Please check your permissions.');
        console.error('Error accessing microphone:', error);
    }
}

// Setup Audio Context for voice activity detection
function setupAudioContext() {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(localStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function checkVoiceActivity() {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / bufferLength;
        
        if (average > 30 && !isMuted) {
            socket.emit('speaking', { displayName });
        }
        
        requestAnimationFrame(checkVoiceActivity);
    }

    checkVoiceActivity();
}

// Initialize Socket.io
function initializeSocket() {
    socket = io(window.location.origin, {
        path: '/socket.io/',
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });

    socket.on('connect', () => {
        console.log('Connected to signaling server');
    });

    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        showWarning('Failed to connect to server. Please try again later.');
    });

    socket.on('user-joined', async (data) => {
        console.log('User joined:', data);
        addUserToList(data.displayName);
        await createPeerConnection(data.socketId, true);
    });

    socket.on('existing-users', async (users) => {
        console.log('Existing users:', users);
        for (const user of users) {
            addUserToList(user.displayName);
            await createPeerConnection(user.socketId, true);
        }
    });

    socket.on('user-left', (data) => {
        console.log('User left:', data);
        removeUserFromList(data.displayName);
        closePeerConnection(data.socketId);
    });

    socket.on('offer', async (data) => {
        console.log('Received offer:', data);
        await handleOffer(data);
    });

    socket.on('answer', async (data) => {
        console.log('Received answer:', data);
        await handleAnswer(data);
    });

    socket.on('ice-candidate', async (data) => {
        console.log('Received ICE candidate:', data);
        await handleIceCandidate(data);
    });

    socket.on('speaking', (data) => {
        updateUserSpeakingStatus(data.displayName, true);
    });

    socket.on('stopped-speaking', (data) => {
        updateUserSpeakingStatus(data.displayName, false);
    });
}

// WebRTC Peer Connection
async function createPeerConnection(socketId, isInitiator) {
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    };

    const peerConnection = new RTCPeerConnection(configuration);
    peerConnections[socketId] = peerConnection;

    // Add local stream
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                socketId,
                candidate: event.candidate
            });
        }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
        console.log(`Connection state for ${socketId}:`, peerConnection.connectionState);
    };

    // Handle ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
        console.log(`ICE connection state for ${socketId}:`, peerConnection.iceConnectionState);
    };

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
        console.log('Received remote track:', event);
        const audioElement = document.createElement('audio');
        audioElement.id = `audio-${socketId}`;
        audioElement.srcObject = event.streams[0];
        audioElement.autoplay = true;
        audioElement.muted = isDeafened;
        document.body.appendChild(audioElement);
    };

    if (isInitiator) {
        try {
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true
            });
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', {
                socketId,
                offer
            });
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    return peerConnection;
}

async function handleOffer(data) {
    try {
        const peerConnection = await createPeerConnection(data.socketId, false);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.createAnswer({
            offerToReceiveAudio: true
        });
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', {
            socketId: data.socketId,
            answer
        });
    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

async function handleAnswer(data) {
    const peerConnection = peerConnections[data.socketId];
    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }
}

async function handleIceCandidate(data) {
    const peerConnection = peerConnections[data.socketId];
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
    }
}

function closePeerConnection(socketId) {
    const peerConnection = peerConnections[socketId];
    if (peerConnection) {
        peerConnection.close();
        delete peerConnections[socketId];
    }
}

// UI Functions
function showWarning(message) {
    warningMessage.textContent = message;
    warningMessage.style.opacity = '1';
    setTimeout(() => {
        warningMessage.style.opacity = '0';
    }, 3000);
}

function addUserToList(name) {
    const userItem = document.createElement('div');
    userItem.className = 'user-item';
    userItem.innerHTML = `
        <div class="user-status"></div>
        <span>${name}</span>
    `;
    userItem.dataset.name = name;
    usersList.appendChild(userItem);
}

function removeUserFromList(name) {
    const userItem = usersList.querySelector(`[data-name="${name}"]`);
    if (userItem) {
        userItem.remove();
    }
}

function updateUserSpeakingStatus(name, isSpeaking) {
    const userItem = usersList.querySelector(`[data-name="${name}"]`);
    if (userItem) {
        const statusIndicator = userItem.querySelector('.user-status');
        if (isSpeaking) {
            statusIndicator.classList.add('speaking');
        } else {
            statusIndicator.classList.remove('speaking');
        }
    }
}

// Event Listeners
joinBtn.addEventListener('click', async () => {
    displayName = displayNameInput.value.trim();
    
    if (!displayName) {
        showWarning('Please enter a display name');
        return;
    }

    try {
        await initializeWebRTC();
        initializeSocket();
        
        // Wait for socket connection before joining room
        socket.on('connect', () => {
            socket.emit('join-room', { displayName });
            welcomeSection.classList.add('hidden');
            channelSection.classList.remove('hidden');
            addUserToList(displayName);
        });
    } catch (error) {
        showWarning('Error joining room. Please try again.');
        console.error('Error joining room:', error);
    }
});

muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
    });
    muteBtn.querySelector('i').className = isMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
    muteBtn.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
});

deafenBtn.addEventListener('click', () => {
    isDeafened = !isDeafened;
    document.querySelectorAll('audio').forEach(audio => {
        audio.muted = isDeafened;
    });
    deafenBtn.querySelector('i').className = isDeafened ? 'fas fa-volume-up' : 'fas fa-volume-mute';
    deafenBtn.querySelector('span').textContent = isDeafened ? 'Undeafen' : 'Deafen';
});

leaveBtn.addEventListener('click', () => {
    if (socket) {
        socket.disconnect();
    }
    
    Object.keys(peerConnections).forEach(socketId => {
        closePeerConnection(socketId);
        const audioElement = document.getElementById(`audio-${socketId}`);
        if (audioElement) {
            audioElement.remove();
        }
    });
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    welcomeSection.classList.remove('hidden');
    channelSection.classList.add('hidden');
    usersList.innerHTML = '';
    displayNameInput.value = '';
    
    localStream = null;
    peerConnections = {};
    isMuted = false;
    isDeafened = false;
    displayName = '';
    socket = null;
}); 