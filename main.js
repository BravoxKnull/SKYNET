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
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });
        setupAudioContext();
        console.log('Audio stream initialized:', localStream.getAudioTracks()[0].label);
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
        socket.emit('join-room', { displayName });
        
        joinBtn.classList.remove('loading');
        joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Connected';
        joinBtn.disabled = true;
    });

    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        showWarning('Failed to connect to server. Please try again later.');
        joinBtn.classList.remove('loading');
        joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
        joinBtn.disabled = false;
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
            await createPeerConnection(user.socketId, false);
        }
    });

    socket.on('user-left', (data) => {
        console.log('User left:', data);
        removeUserFromList(data.displayName);
        closePeerConnection(data.socketId);
        const audioElement = document.getElementById(`audio-${data.socketId}`);
        if (audioElement) {
            audioElement.remove();
        }
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
            {
                urls: 'turn:relay1.expressturn.com:3480',
                username: '000000002064061488',
                credential: 'Y4KkTGe7+4T5LeMWjkXn5T5Zv54='
            }
        ],
        iceCandidatePoolSize: 10
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
        if (peerConnection.connectionState === 'failed') {
            peerConnection.restartIce();
        }
    };

    // Handle ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
        console.log(`ICE connection state for ${socketId}:`, peerConnection.iceConnectionState);
        if (peerConnection.iceConnectionState === 'failed') {
            peerConnection.restartIce();
        }
    };

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind, event.track.enabled);
        const audioElement = document.createElement('audio');
        audioElement.id = `audio-${socketId}`;
        audioElement.srcObject = event.streams[0];
        audioElement.autoplay = true;
        audioElement.muted = isDeafened;
        
        audioElement.onloadedmetadata = () => {
            audioElement.play().catch(error => {
                console.error('Error playing audio:', error);
            });
        };
        
        document.body.appendChild(audioElement);
    };

    if (isInitiator) {
        try {
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                voiceActivityDetection: true
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
        let peerConnection = peerConnections[data.socketId];
        if (!peerConnection) {
            peerConnection = await createPeerConnection(data.socketId, false);
        }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', {
            socketId: data.socketId,
            answer
        });

        if (peerConnection.queuedIceCandidates) {
            for (const candidate of peerConnection.queuedIceCandidates) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
            peerConnection.queuedIceCandidates = [];
        }

    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

async function handleAnswer(data) {
    try {
        const peerConnection = peerConnections[data.socketId];
        if (!peerConnection) {
            console.error('No peer connection found for:', data.socketId);
            return;
        }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));

        if (peerConnection.queuedIceCandidates) {
            for (const candidate of peerConnection.queuedIceCandidates) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
            peerConnection.queuedIceCandidates = [];
        }

    } catch (error) {
        console.error('Error handling answer:', error);
    }
}

async function handleIceCandidate(data) {
    try {
        const peerConnection = peerConnections[data.socketId];
        if (!peerConnection) {
            console.error('No peer connection found for:', data.socketId);
            return;
        }

        if (peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
            if (!peerConnection.queuedIceCandidates) {
                peerConnection.queuedIceCandidates = [];
            }
            peerConnection.queuedIceCandidates.push(data.candidate);
        }
    } catch (error) {
        console.error('Error handling ICE candidate:', error);
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
    userItem.dataset.name = name;
    userItem.innerHTML = `
        <div class="user-status"></div>
        <span>${name}</span>
    `;
    usersList.appendChild(userItem);
}

function removeUserFromList(name) {
    const userItems = usersList.getElementsByClassName('user-item');
    for (const item of userItems) {
        if (item.textContent.trim() === name) {
            item.style.opacity = '0';
            item.style.transform = 'translateX(20px)';
            setTimeout(() => item.remove(), 300);
            break;
        }
    }
}

function updateUserSpeakingStatus(name, isSpeaking) {
    const userItems = usersList.getElementsByClassName('user-item');
    for (const item of userItems) {
        if (item.dataset.name === name) {
            const statusIndicator = item.querySelector('.user-status');
            if (isSpeaking) {
                statusIndicator.classList.add('speaking');
            } else {
                statusIndicator.classList.remove('speaking');
            }
            break;
        }
    }
}

// Event Listeners
joinBtn.addEventListener('click', async () => {
    const name = displayNameInput.value.trim();
    if (!name) {
        showWarning('Please enter your display name');
        return;
    }

    // Add loading state to button
    joinBtn.classList.add('loading');
    joinBtn.innerHTML = '<i class="fas fa-spinner"></i> Connecting...';
    joinBtn.disabled = true;

    try {
        // Initialize WebRTC and Socket.io
        await initializeWebRTC();
        displayName = name;
        initializeSocket();

        // Animate welcome section out
        welcomeSection.classList.add('hidden');
        
        // Wait for animation to complete
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Show channel section
        channelSection.classList.remove('hidden');
        channelSection.classList.add('visible');

        // Add current user to the list
        addUserToList(displayName);

        // Update UI
        displayNameInput.disabled = true;
        warningMessage.textContent = '';
    } catch (error) {
        console.error('Error joining channel:', error);
        showWarning('Failed to join channel. Please try again.');
        joinBtn.classList.remove('loading');
        joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
        joinBtn.disabled = false;
    }
});

muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });
    }
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
    // Animate channel section out
    channelSection.classList.remove('visible');
    channelSection.classList.add('hidden');

    // Wait for animation to complete
    setTimeout(() => {
        // Reset UI
        displayNameInput.disabled = false;
        joinBtn.disabled = false;
        joinBtn.classList.remove('loading');
        joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
        usersList.innerHTML = '';
        warningMessage.textContent = '';

        // Show welcome section
        welcomeSection.classList.remove('hidden');

        // Clean up connections
        Object.keys(peerConnections).forEach(socketId => {
            closePeerConnection(socketId);
        });
        peerConnections = {};

        // Disconnect socket
        if (socket) {
            socket.disconnect();
            socket = null;
        }

        // Stop local stream
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
    }, 500);
});
