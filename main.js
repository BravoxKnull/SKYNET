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
let currentUser = null;

// Initialize user data
function initializeUserData() {
    try {
        const userData = localStorage.getItem('user');
        if (!userData) {
            console.error('No user data found');
            window.location.href = 'auth.html';
            return false;
        }
        currentUser = JSON.parse(userData);
        return true;
    } catch (error) {
        console.error('Error parsing user data:', error);
        window.location.href = 'auth.html';
        return false;
    }
}

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

    // Set initial display name if user data is available
    if (currentUser && currentUser.displayName) {
        displayNameInput.value = currentUser.displayName;
    }
}

// Initialize event listeners
function initializeEventListeners() {
    joinBtn.addEventListener('click', async () => {
        const name = displayNameInput.value.trim();
        if (!name) {
            warningMessage.textContent = 'Please enter your display name';
            return;
        }

        if (!currentUser) {
            warningMessage.textContent = 'User data not found. Please log in again.';
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
                joinBtn.classList.remove('loading');
                joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
                joinBtn.disabled = false;
                return;
            }

            displayName = name;
            
            // Initialize socket if not already initialized
            if (!socket) {
                initializeSocket();
            }

            // Get user's avatar before joining
            const { data, error } = await supabase
                .from('users')
                .select('avatar_url')
                .eq('id', currentUser.id)
                .single();

            if (error) {
                console.error('Error fetching user avatar:', error);
            }

            // Show channel section
            welcomeSection.classList.add('hidden');
            channelSection.classList.remove('hidden');
            channelSection.classList.add('visible');

            // Join the channel with avatar
            socket.emit('joinChannel', {
                id: currentUser.id,
                displayName: displayName,
                avatar_url: data?.avatar_url || null
            });

            // Add current user to the list immediately
            const userData = {
                id: currentUser.id,
                displayName: displayName,
                avatar_url: data?.avatar_url || null
            };
            users = [userData];
            updateUsersList(users);

            // Update UI
            displayNameInput.disabled = true;
            warningMessage.textContent = '';
            
            // Update button state
            joinBtn.classList.remove('loading');
            joinBtn.innerHTML = '<i class="fas fa-check"></i> Connected';
            joinBtn.disabled = true;

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
            Object.keys(peerConnections).forEach(userId => {
                closePeerConnection(userId);
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

            // Reset audio context
            if (audioContext) {
                audioContext.close();
                audioContext = null;
            }
        }, 500);
    });
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    if (!initializeUserData()) {
        return;
    }
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
        // Check if connection already exists
        if (peerConnections[userId]) {
            console.log(`Connection to ${userId} already exists`);
            return peerConnections[userId];
        }

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
                console.log(`Connection failed for ${userId}, attempting to restart ICE`);
                peerConnection.restartIce();
            }
        };

        // Handle ICE connection state changes
        peerConnection.oniceconnectionstatechange = () => {
            console.log(`ICE connection state for ${userId}:`, peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'failed') {
                console.log(`ICE connection failed for ${userId}, attempting to restart ICE`);
                peerConnection.restartIce();
            }
        };

        // Handle signaling state changes
        peerConnection.onsignalingstatechange = () => {
            console.log(`Signaling state for ${userId}:`, peerConnection.signalingState);
        };

        if (isInitiator) {
            try {
                console.log(`Creating offer for ${userId}`);
                const offer = await peerConnection.createOffer({
                    offerToReceiveAudio: true,
                    voiceActivityDetection: true
                });
                await peerConnection.setLocalDescription(offer);
                socket.emit('offer', {
                    targetUserId: userId,
                    offer: offer
                });
            } catch (error) {
                console.error('Error creating offer:', error);
            }
        }

        return peerConnection;
    } catch (error) {
        console.error('Error creating peer connection:', error);
        return null;
    }
}

// Close peer connection
function closePeerConnection(userId) {
    const peerConnection = peerConnections[userId];
    if (peerConnection) {
        peerConnection.close();
        delete peerConnections[userId];
    }
}

// Initialize Socket.io
function initializeSocket() {
    socket = io('https://skynet-mdy7.onrender.com', {
        path: '/socket.io/',
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 10000,
        forceNew: true,
        withCredentials: true
    });

    socket.on('connect', () => {
        console.log('Connected to signaling server');
        socketInitialized = true;
        warningMessage.textContent = '';
    });

    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        warningMessage.textContent = 'Failed to connect to server. Please try again.';
        joinBtn.classList.remove('loading');
        joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
        joinBtn.disabled = false;
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        if (reason === 'io server disconnect') {
            // Server initiated disconnect, try to reconnect
            socket.connect();
        }
    });

    socket.on('reconnect_attempt', (attemptNumber) => {
        console.log('Attempting to reconnect:', attemptNumber);
        warningMessage.textContent = `Reconnecting to server... (Attempt ${attemptNumber})`;
    });

    socket.on('reconnect', (attemptNumber) => {
        console.log('Reconnected to server after', attemptNumber, 'attempts');
        warningMessage.textContent = '';
    });

    socket.on('reconnect_error', (error) => {
        console.error('Reconnection error:', error);
        warningMessage.textContent = 'Failed to reconnect to server. Please refresh the page.';
    });

    socket.on('reconnect_failed', () => {
        console.error('Failed to reconnect to server');
        warningMessage.textContent = 'Failed to reconnect to server. Please refresh the page.';
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
        if (!currentUser) {
            console.error('Current user not initialized');
            return;
        }
        // Filter out duplicates and current user
        const uniqueUsers = usersList.filter(user => 
            user.id !== currentUser.id && 
            !users.some(existingUser => existingUser.id === user.id)
        );
        users = [...users, ...uniqueUsers];
        updateUsersList(users);
    });

    socket.on('offer', async (data) => {
        console.log('Received offer from:', data.senderId);
        try {
            let peerConnection = peerConnections[data.senderId];
            
            // If connection exists but is in wrong state, close it
            if (peerConnection && peerConnection.signalingState !== 'stable') {
                console.log(`Closing existing connection to ${data.senderId} due to wrong state`);
                peerConnection.close();
                delete peerConnections[data.senderId];
                peerConnection = null;
            }

            if (!peerConnection) {
                peerConnection = await createPeerConnection(data.senderId, false);
            }

            if (peerConnection) {
                if (peerConnection.signalingState === 'stable') {
                    console.log(`Setting remote description for ${data.senderId}`);
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    socket.emit('answer', {
                        targetUserId: data.senderId,
                        answer: answer
                    });
                } else {
                    console.log(`Ignoring offer from ${data.senderId} - wrong signaling state: ${peerConnection.signalingState}`);
                }
            }
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    });

    socket.on('answer', async (data) => {
        console.log('Received answer from:', data.senderId);
        try {
            const peerConnection = peerConnections[data.senderId];
            if (peerConnection) {
                if (peerConnection.signalingState === 'have-local-offer') {
                    console.log(`Setting remote description (answer) for ${data.senderId}`);
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
                    
                    // Process any queued ICE candidates
                    if (peerConnection.queuedIceCandidates && peerConnection.queuedIceCandidates.length > 0) {
                        console.log(`Processing ${peerConnection.queuedIceCandidates.length} queued ICE candidates for ${data.senderId}`);
                        for (const candidate of peerConnection.queuedIceCandidates) {
                            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                        }
                        peerConnection.queuedIceCandidates = [];
                    }
                } else {
                    console.log(`Ignoring answer from ${data.senderId} - wrong signaling state: ${peerConnection.signalingState}`);
                }
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    });

    socket.on('ice-candidate', async (data) => {
        console.log('Received ICE candidate from:', data.senderId);
        try {
            const peerConnection = peerConnections[data.senderId];
            if (peerConnection) {
                // Only add ICE candidates if we have a remote description
                if (peerConnection.remoteDescription) {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                } else {
                    // Store the candidate for later
                    if (!peerConnection.queuedIceCandidates) {
                        peerConnection.queuedIceCandidates = [];
                    }
                    peerConnection.queuedIceCandidates.push(data.candidate);
                }
            }
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
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
