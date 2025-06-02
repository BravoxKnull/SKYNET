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
let users = [];
let socketInitialized = false;

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

        joinBtn.classList.add('loading');
        joinBtn.innerHTML = '<i class="fas fa-spinner"></i> Connecting...';
        joinBtn.disabled = true;

        try {
            const webRTCInitialized = await initializeWebRTC();
            if (!webRTCInitialized) {
                warningMessage.textContent = 'Error accessing microphone';
                joinBtn.classList.remove('loading');
                joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
                joinBtn.disabled = false;
                return;
            }

            displayName = name;
            
            if (!socket) {
                initializeSocket();
            }

            const { data, error } = await supabase
                .from('users')
                .select('avatar_url')
                .eq('id', currentUser.id)
                .single();

            if (error) {
                console.error('Error fetching user avatar:', error);
            }

            welcomeSection.classList.add('hidden');
            channelSection.classList.remove('hidden');
            channelSection.classList.add('visible');

            socket.emit('joinChannel', {
                id: currentUser.id,
                displayName: displayName,
                avatar_url: data?.avatar_url || null
            });

            const userData = {
                id: currentUser.id,
                displayName: displayName,
                avatar_url: data?.avatar_url || null
            };
            users = [userData];
            updateUsersList(users);

            displayNameInput.disabled = true;
            warningMessage.textContent = '';
            
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

        // Broadcast mute status to all users
        if (socket && socket.connected) {
            const muteData = {
                userId: currentUser.id,
                isMuted: isMuted,
                displayName: currentUser.displayName
            };
            console.log('Broadcasting mute status to server:', muteData);
            try {
                socket.emit('userMuteStatus', muteData);
            } catch (error) {
                console.error('Error emitting mute status:', error);
            }
        } else {
            console.warn('Socket not connected, cannot broadcast mute status');
        }

        // Update local UI
        updateUserMuteStatus(currentUser.id, isMuted);
    });

    deafenBtn.addEventListener('click', () => {
        isDeafened = !isDeafened;
        document.querySelectorAll('audio').forEach(audio => {
            audio.muted = isDeafened;
        });
        deafenBtn.querySelector('i').className = isDeafened ? 'fas fa-volume-up' : 'fas fa-volume-mute';
        deafenBtn.querySelector('span').textContent = isDeafened ? 'Undeafen' : 'Deafen';

        // Broadcast deafen status to all users
        if (socket && socket.connected) {
            const deafenData = {
                userId: currentUser.id,
                isDeafened: isDeafened,
                displayName: currentUser.displayName
            };
            console.log('Broadcasting deafen status to server:', deafenData);
            try {
                socket.emit('userDeafenStatus', deafenData);
            } catch (error) {
                console.error('Error emitting deafen status:', error);
            }
        } else {
            console.warn('Socket not connected, cannot broadcast deafen status');
        }

        // Update local UI
        updateUserDeafenStatus(currentUser.id, isDeafened);
    });

    leaveBtn.addEventListener('click', () => {
        channelSection.classList.remove('visible');
        channelSection.classList.add('hidden');

        setTimeout(() => {
            displayNameInput.disabled = false;
            joinBtn.disabled = false;
            joinBtn.classList.remove('loading');
            joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
            usersList.innerHTML = '';
            warningMessage.textContent = '';

            welcomeSection.classList.remove('hidden');

            Object.keys(peerConnections).forEach(userId => {
                closePeerConnection(userId);
            });
            peerConnections = {};

            if (socket) {
                socket.disconnect();
                socket = null;
            }

            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
                localStream = null;
            }

            if (audioContext) {
                audioContext.close();
                audioContext = null;
            }
        }, 500);
    });
}

// Initialize WebRTC
async function initializeWebRTC() {
    try {
        console.log('Initializing WebRTC...');
        
        // Request audio permissions with specific constraints
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000
            },
            video: false
        });
        
        console.log('Audio stream obtained successfully');

        // Initialize audio context with specific sample rate
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 48000
        });
        
        // Create and configure analyser
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        
        // Connect audio stream to analyser
        const source = audioContext.createMediaStreamSource(localStream);
        source.connect(analyser);
        
        // Start audio context if it's suspended
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        console.log('Audio context and analyser initialized successfully');
        return true;
    } catch (error) {
        console.error('Error initializing WebRTC:', error);
        warningMessage.textContent = 'Error accessing microphone. Please check your permissions.';
        return false;
    }
}

// Create peer connection with improved configuration
async function createPeerConnection(userId, isInitiator) {
    try {
        console.log(`Creating peer connection for ${userId}, isInitiator: ${isInitiator}`);

        // Close existing connection if any
        if (peerConnections[userId]) {
            console.log(`Closing existing connection to ${userId}`);
            peerConnections[userId].close();
            delete peerConnections[userId];
        }

        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' },
                {
                    urls: 'turn:relay1.expressturn.com:3480',
                    username: '000000002064061488',
                    credential: 'Y4KkTGe7+4T5LeMWjkXn5T5Zv54='
                }
            ],
            iceCandidatePoolSize: 10,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            sdpSemantics: 'unified-plan'
        };

        const peerConnection = new RTCPeerConnection(configuration);
        peerConnections[userId] = peerConnection;

        // Add local stream
        if (localStream) {
            localStream.getTracks().forEach(track => {
                console.log('Adding track to peer connection:', track.kind);
                peerConnection.addTrack(track, localStream);
            });
        } else {
            console.error('No local stream available');
            return null;
        }

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate to:', userId);
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
            if (peerConnection.signalingState === 'closed') {
                console.log(`Connection to ${userId} closed, cleaning up`);
                delete peerConnections[userId];
            }
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
                peerConnection.close();
                delete peerConnections[userId];
                return null;
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
            socket.connect();
        }
    });

    socket.on('reconnect_attempt', (attemptNumber) => {
        console.log('Attempting to reconnect:', attemptNumber);
        warningMessage.textContent = `Reconnecting to server... (Attempt ${attemptNumber})`;
    });

    socket.on('reconnect', () => {
        console.log('Socket reconnected, broadcasting current status');
        if (socket && socket.connected) {
            // Broadcast current status after reconnection
            const muteData = {
                userId: currentUser.id,
                isMuted: isMuted,
                displayName: currentUser.displayName
            };
            socket.emit('userMuteStatus', muteData);

            const deafenData = {
                userId: currentUser.id,
                isDeafened: isDeafened,
                displayName: currentUser.displayName
            };
            socket.emit('userDeafenStatus', deafenData);
        }
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
        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};
        warningMessage.textContent = 'You are already connected in another tab/window';
        socket.disconnect();
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    });

    socket.on('userJoined', async (userData) => {
        console.log('User joined:', userData);
        if (!users.some(user => user.id === userData.id)) {
            users = [...users, userData];
            updateUsersList(users);
            await createPeerConnection(userData.id, true);
            
            // Send current status to new user
            if (socket && socket.connected) {
                // Broadcast current mute status
                const muteData = {
                    userId: currentUser.id,
                    isMuted: isMuted,
                    displayName: currentUser.displayName
                };
                console.log('Broadcasting initial mute status to new user:', muteData);
                socket.emit('userMuteStatus', muteData);

                // Broadcast current deafen status
                const deafenData = {
                    userId: currentUser.id,
                    isDeafened: isDeafened,
                    displayName: currentUser.displayName
                };
                console.log('Broadcasting initial deafen status to new user:', deafenData);
                socket.emit('userDeafenStatus', deafenData);
            }
        }
    });

    socket.on('userLeft', (userId) => {
        console.log('User left:', userId);
        users = users.filter(user => user.id !== userId);
        updateUsersList(users);
        
        if (peerConnections[userId]) {
            peerConnections[userId].close();
            delete peerConnections[userId];
        }
        
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
            const peerConnection = await createPeerConnection(data.senderId, false);
            if (peerConnection) {
                try {
                    console.log(`Setting remote description for ${data.senderId}`);
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    socket.emit('answer', {
                        targetUserId: data.senderId,
                        answer: answer
                    });
                } catch (error) {
                    console.error('Error handling offer:', error);
                    peerConnection.close();
                    delete peerConnections[data.senderId];
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
                try {
                    console.log(`Setting remote description (answer) for ${data.senderId}`);
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
                    
                    if (peerConnection.queuedIceCandidates && peerConnection.queuedIceCandidates.length > 0) {
                        console.log(`Processing ${peerConnection.queuedIceCandidates.length} queued ICE candidates for ${data.senderId}`);
                        for (const candidate of peerConnection.queuedIceCandidates) {
                            try {
                                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                            } catch (error) {
                                console.warn('Error adding queued ICE candidate:', error);
                            }
                        }
                        peerConnection.queuedIceCandidates = [];
                    }
                } catch (error) {
                    console.error('Error setting remote description:', error);
                    peerConnection.close();
                    delete peerConnections[data.senderId];
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
                if (peerConnection.remoteDescription) {
                    try {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                    } catch (error) {
                        console.warn('Error adding ICE candidate:', error);
                    }
                } else {
                    if (!peerConnection.queuedIceCandidates) {
                        peerConnection.queuedIceCandidates = [];
                    }
                    const isDuplicate = peerConnection.queuedIceCandidates.some(
                        existing => existing.candidate === data.candidate.candidate
                    );
                    if (!isDuplicate) {
                        peerConnection.queuedIceCandidates.push(data.candidate);
                    }
                }
            }
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
    });

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

    // Update the mute status event handler
    socket.on('userMuteStatus', (data) => {
        console.log('Received mute status update from server:', data);
        if (data.userId) {
            // Force a UI update
            requestAnimationFrame(() => {
                updateUserMuteStatus(data.userId, data.isMuted);
            });
        }
    });

    // Update the deafen status event handler
    socket.on('userDeafenStatus', (data) => {
        console.log('Received deafen status update from server:', data);
        if (data.userId) {
            // Force a UI update
            requestAnimationFrame(() => {
                updateUserDeafenStatus(data.userId, data.isDeafened);
            });
        }
    });
}

// Function to create user list item
function createUserListItem(userData) {
    const userItem = document.createElement('div');
    userItem.className = 'user-item';
    userItem.setAttribute('data-user-id', userData.id);
    userItem.setAttribute('data-username', userData.displayName);

    const defaultAvatar = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNjY2IiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSI4IiByPSI1Ii8+PHBhdGggZD0iTTIwIDIxYTggOCAwIDAgMC0xNiAwIi8+PC9zdmc+';

    const avatarUrl = userData.avatar_url || defaultAvatar;

    userItem.innerHTML = `
        <div class="user-avatar-container">
            <img src="${avatarUrl}"
                 alt="${userData.displayName}'s avatar"
                 class="user-avatar"
                 onerror="this.onerror=null; this.src='${defaultAvatar}'">
            <div class="user-status-indicator"></div>
        </div>
        <div class="user-details">
            <span class="user-name">${userData.displayName}</span>
            <span class="user-status">Online</span>
            <div class="user-device-status">
                <div class="device-status mic-status" title="Microphone Status">
                    <i class="fas fa-microphone"></i>
                    <span class="status-text">Active</span>
                </div>
                <div class="device-status speaker-status" title="Speaker Status">
                    <i class="fas fa-volume-up"></i>
                    <span class="status-text">Active</span>
                </div>
            </div>
        </div>
    `;

    return userItem;
}

// Function to update users list
async function updateUsersList(users) {
    const usersList = document.getElementById('usersList');
    if (!usersList) return;
    
    const uniqueUsers = new Map();
    users.forEach(user => {
        if (!uniqueUsers.has(user.id)) {
            uniqueUsers.set(user.id, user);
        }
    });

    usersList.innerHTML = '';

    for (const userData of uniqueUsers.values()) {
        try {
            const userItem = createUserListItem(userData);
            usersList.appendChild(userItem);

            if (!userData.avatar_url) {
                const { data, error } = await supabase
                    .from('users')
                    .select('avatar_url')
                    .eq('id', userData.id)
                    .single();

                if (!error && data && data.avatar_url) {
                    const img = userItem.querySelector('.user-avatar');
                    if (img) {
                        img.src = data.avatar_url;
                    }
                }
            }
        } catch (error) {
            console.error('Error processing user:', error);
        }
    }
}

// Function to update user mute status in UI
function updateUserMuteStatus(userId, isMuted) {
    console.log('Updating mute status for user:', userId, 'isMuted:', isMuted);
    const userItem = document.querySelector(`[data-user-id="${userId}"]`);
    if (userItem) {
        // Update data attribute for CSS targeting
        userItem.setAttribute('data-muted', isMuted);
        
        const status = userItem.querySelector('.user-status');
        const indicator = userItem.querySelector('.user-status-indicator');
        const micStatus = userItem.querySelector('.mic-status');
        
        if (isMuted) {
            if (status) status.textContent = 'Muted';
            if (indicator) {
                indicator.className = 'user-status-indicator muted';
                indicator.style.backgroundColor = '#f44336';
            }
            if (micStatus) {
                micStatus.innerHTML = '<i class="fas fa-microphone-slash"></i><span class="status-text">Muted</span>';
                micStatus.classList.add('inactive');
                micStatus.style.backgroundColor = 'rgba(255, 77, 77, 0.1)';
            }
        } else {
            if (status) status.textContent = 'Online';
            if (indicator) {
                indicator.className = 'user-status-indicator';
                indicator.style.backgroundColor = '#4CAF50';
            }
            if (micStatus) {
                micStatus.innerHTML = '<i class="fas fa-microphone"></i><span class="status-text">Active</span>';
                micStatus.classList.remove('inactive');
                micStatus.style.backgroundColor = 'rgba(100, 255, 218, 0.1)';
            }
        }
    } else {
        console.warn('User item not found for ID:', userId);
        // Try to find the user in the users array and update the list
        const user = users.find(u => u.id === userId);
        if (user) {
            console.log('Found user in array, updating list...');
            updateUsersList(users);
            // Try updating again after a short delay
            setTimeout(() => {
                updateUserMuteStatus(userId, isMuted);
            }, 100);
        }
    }
}

// Function to update user deafen status in UI
function updateUserDeafenStatus(userId, isDeafened) {
    console.log('Updating deafen status for user:', userId, 'isDeafened:', isDeafened);
    const userItem = document.querySelector(`[data-user-id="${userId}"]`);
    if (userItem) {
        // Update data attribute for CSS targeting
        userItem.setAttribute('data-deafened', isDeafened);
        
        const status = userItem.querySelector('.user-status');
        const indicator = userItem.querySelector('.user-status-indicator');
        const speakerStatus = userItem.querySelector('.speaker-status');
        
        if (isDeafened) {
            if (status) status.textContent = 'Deafened';
            if (indicator) {
                indicator.className = 'user-status-indicator deafened';
                indicator.style.backgroundColor = '#9c27b0';
            }
            if (speakerStatus) {
                speakerStatus.innerHTML = '<i class="fas fa-volume-mute"></i><span class="status-text">Deafened</span>';
                speakerStatus.classList.add('inactive');
                speakerStatus.style.backgroundColor = 'rgba(156, 39, 176, 0.1)';
            }
        } else {
            if (status) status.textContent = 'Online';
            if (indicator) {
                indicator.className = 'user-status-indicator';
                indicator.style.backgroundColor = '#4CAF50';
            }
            if (speakerStatus) {
                speakerStatus.innerHTML = '<i class="fas fa-volume-up"></i><span class="status-text">Active</span>';
                speakerStatus.classList.remove('inactive');
                speakerStatus.style.backgroundColor = 'rgba(100, 255, 218, 0.1)';
            }
        }
    } else {
        console.warn('User item not found for ID:', userId);
        // Try to find the user in the users array and update the list
        const user = users.find(u => u.id === userId);
        if (user) {
            console.log('Found user in array, updating list...');
            updateUsersList(users);
            // Try updating again after a short delay
            setTimeout(() => {
                updateUserDeafenStatus(userId, isDeafened);
            }, 100);
        }
    }
}

// Theme Management
function initializeTheme() {
    // Get saved theme preference
    const savedTheme = localStorage.getItem('theme') || 'dark';
    applyTheme(savedTheme);

    // Initialize theme switch
    const themeSwitch = document.getElementById('themeSwitch');
    if (themeSwitch) {
        themeSwitch.checked = savedTheme === 'light';
        themeSwitch.addEventListener('change', (e) => {
            const newTheme = e.target.checked ? 'light' : 'dark';
            applyTheme(newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.classList.add('theme-transition');
    setTimeout(() => {
        document.body.classList.remove('theme-transition');
    }, 300);
}

// Add theme switch to the appearance section
function createThemeSwitch() {
    const appearanceSection = document.querySelector('.appearance-section');
    if (appearanceSection) {
        const themeSwitchContainer = document.createElement('div');
        themeSwitchContainer.className = 'theme-switch-container';
        themeSwitchContainer.innerHTML = `
            <span class="theme-switch-label">Dark Theme</span>
            <label class="theme-switch">
                <input type="checkbox" id="themeSwitch">
                <span class="theme-slider">
                    <i class="fas fa-sun theme-icon sun"></i>
                    <i class="fas fa-moon theme-icon moon"></i>
                </span>
            </label>
            <span class="theme-switch-label">Light Theme</span>
        `;
        appearanceSection.appendChild(themeSwitchContainer);

        // Add theme preview
        const themePreview = document.createElement('div');
        themePreview.className = 'theme-preview';
        themePreview.innerHTML = `
            <div class="preview-item">
                <h4>Primary Elements</h4>
                <p>Buttons, links, and important actions</p>
                <button class="control-btn">Sample Button</button>
            </div>
            <div class="preview-item">
                <h4>Text & Background</h4>
                <p>Main content and text elements</p>
                <div class="input-field">Sample Input</div>
            </div>
            <div class="preview-item">
                <h4>Cards & Containers</h4>
                <p>UI containers and cards</p>
                <div class="user-item">Sample Card</div>
            </div>
        `;
        appearanceSection.appendChild(themePreview);
    }
}

// Initialize theme when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    initializeTheme();
    createThemeSwitch();
    
    // Rest of your initialization code...
    if (!initializeUserData()) {
        return;
    }
    initializeDOMElements();
    initializeEventListeners();
});
