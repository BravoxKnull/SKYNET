// DOM Elements
let displayNameInput;
let joinBtn;
let warningMessage;
let welcomeSection;
let channelSection;
let usersList;
let muteBtn;
let deafenBtn;
let leaveBtn;

// State
let localStream = null;
let peerConnections = {};
let isMuted = false;
let isDeafened = false;
let displayName = '';
let socket = null;
let audioContext = null;
let analyser = null;
let speakingThreshold = -50; // dB
let isSpeaking = false;
let speakingTimeout = null;

// Initialize DOM elements
function initializeDOMElements() {
    displayNameInput = document.getElementById('displayName');
    joinBtn = document.getElementById('joinBtn');
    warningMessage = document.getElementById('warningMessage');
    welcomeSection = document.getElementById('welcomeSection');
    channelSection = document.getElementById('channelSection');
    usersList = document.getElementById('usersList');
    muteBtn = document.getElementById('muteBtn');
    deafenBtn = document.getElementById('deafenBtn');
    leaveBtn = document.getElementById('leaveBtn');
}

// Initialize event listeners
function initializeEventListeners() {
    joinBtn.addEventListener('click', async () => {
        const name = displayNameInput.value.trim();
        if (!name) {
            warningMessage.textContent = 'Please enter your display name';
            return;
        }

        // Add loading state to button
        joinBtn.classList.add('loading');
        joinBtn.innerHTML = '<i class="fas fa-spinner"></i> Connecting...';
        joinBtn.disabled = true;

        try {
            // Initialize WebRTC first
            const webRTCInitialized = await initializeWebRTC();
            if (!webRTCInitialized) {
                warningMessage.textContent = 'Error accessing microphone';
                return;
            }

            displayName = name;
            initializeSocket();

            // Show channel section
            welcomeSection.classList.add('hidden');
            channelSection.classList.remove('hidden');
            channelSection.classList.add('visible');

            // Update UI
            displayNameInput.disabled = true;
            warningMessage.textContent = '';
        } catch (error) {
            console.error('Error joining channel:', error);
            warningMessage.textContent = 'Failed to join channel. Please try again.';
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
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    initializeDOMElements();
    initializeEventListeners();
});

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
        
        // Initialize audio context for voice detection
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(localStream);
        source.connect(analyser);
        analyser.fftSize = 256;
        
        console.log('Audio stream initialized successfully');
        return true;
    } catch (error) {
        console.error('Error accessing microphone:', error);
        return false;
    }
}

// Create peer connection
async function createPeerConnection(userId, isInitiator) {
    try {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                {
                    urls: 'turn:relay1.expressturn.com:3480',
                    username: '000000002064061488',
                    credential: 'Y4KkTGe7+4T5LeMWjkXn5T5Zv54='
                }
            ]
        };

        const peerConnection = new RTCPeerConnection(configuration);
        peerConnections[userId] = peerConnection;

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
                    targetUserId: userId,
                    candidate: event.candidate
                });
            }
        };

        // Handle incoming tracks
        peerConnection.ontrack = (event) => {
            console.log('Received remote track from:', userId);
            const audioElement = document.createElement('audio');
            audioElement.id = `audio-${userId}`;
            audioElement.srcObject = event.streams[0];
            audioElement.autoplay = true;
            audioElement.muted = isDeafened;
            document.body.appendChild(audioElement);
        };

        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
            console.log(`Connection state for ${userId}:`, peerConnection.connectionState);
            if (peerConnection.connectionState === 'failed') {
                peerConnection.restartIce();
            }
        };

        if (isInitiator) {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', {
                targetUserId: userId,
                offer: offer
            });
        }

        return peerConnection;
    } catch (error) {
        console.error('Error creating peer connection:', error);
        return null;
    }
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

    socket.on('duplicateConnection', () => {
        console.log('Duplicate connection detected');
        // Clean up existing connections
        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};
        
        // Show warning to user
        warningMessage.textContent = 'You are already connected in another tab/window';
        
        // Disconnect and reconnect
        socket.disconnect();
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    });

    socket.on('userJoined', async (userData) => {
        console.log('User joined:', userData);
        // Check if user already exists
        if (!users.some(user => user.id === userData.id)) {
            users = [...users, userData];
            updateUsersList(users);
            // Create peer connection with new user
            await createPeerConnection(userData.id, true);
        }
    });

    socket.on('userLeft', (userId) => {
        console.log('User left:', userId);
        users = users.filter(user => user.id !== userId);
        updateUsersList(users);
        
        // Close peer connection
        if (peerConnections[userId]) {
            peerConnections[userId].close();
            delete peerConnections[userId];
        }
        
        // Remove audio element
        const audioElement = document.getElementById(`audio-${userId}`);
        if (audioElement) {
            audioElement.remove();
        }
    });

    socket.on('usersList', (usersList) => {
        console.log('Received users list:', usersList);
        // Filter out duplicates and current user
        const uniqueUsers = usersList.filter(user => 
            user.id !== window.user.id && 
            !users.some(existingUser => existingUser.id === user.id)
        );
        users = [...users, ...uniqueUsers];
        updateUsersList(users);
    });

    socket.on('offer', async (data) => {
        console.log('Received offer from:', data.senderId);
        const peerConnection = await createPeerConnection(data.senderId, false);
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('answer', {
                targetUserId: data.senderId,
                answer: answer
            });
        }
    });

    socket.on('answer', async (data) => {
        console.log('Received answer from:', data.senderId);
        const peerConnection = peerConnections[data.senderId];
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    });

    socket.on('ice-candidate', async (data) => {
        console.log('Received ICE candidate from:', data.senderId);
        const peerConnection = peerConnections[data.senderId];
        if (peerConnection) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (error) {
                console.error('Error adding ICE candidate:', error);
            }
        }
    });

    // Handle voice activity
    socket.on('userSpeaking', (data) => {
        const userItem = document.querySelector(`[data-user-id="${data.userId}"]`);
        if (userItem) {
            const indicator = userItem.querySelector('.user-status-indicator');
            const status = userItem.querySelector('.user-status');
            indicator.className = 'user-status-indicator speaking';
            status.textContent = 'Speaking...';
        }
    });

    socket.on('userStoppedSpeaking', (data) => {
        const userItem = document.querySelector(`[data-user-id="${data.userId}"]`);
        if (userItem) {
            const indicator = userItem.querySelector('.user-status-indicator');
            const status = userItem.querySelector('.user-status');
            indicator.className = 'user-status-indicator';
            status.textContent = 'Online';
        }
    });
}
