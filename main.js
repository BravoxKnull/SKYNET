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
let socket = null;

// Audio elements for notifications
let userJoinedSound;
let userLeftSound;

// State
let localStream = null;
let peerConnections = {};
let isMuted = false;
let isDeafened = false;
let displayName = '';
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

// Initialize DOM elements with null checks
function initializeDOMElements() {
    // Get all required DOM elements
    displayNameInput = document.getElementById('displayName');
    joinBtn = document.getElementById('joinBtn');
    warningMessage = document.getElementById('warningMessage');
    welcomeSection = document.getElementById('welcomeSection');
    channelSection = document.getElementById('channelSection');
    usersList = document.getElementById('usersList');
    muteBtn = document.getElementById('muteBtn');
    deafenBtn = document.getElementById('deafenBtn');
    leaveBtn = document.getElementById('leaveBtn');
    friendMenu = document.getElementById('friendMenu');
    friendRequestBtn = document.getElementById('friendRequestBtn');
    friendListBtn = document.getElementById('friendListBtn');
    friendBlockBtn = document.getElementById('friendBlockBtn');
    friendNotification = document.getElementById('friendNotification');
    friendNotificationCount = document.getElementById('friendNotificationCount');
    friendNotificationList = document.getElementById('friendNotificationList');
    friendList = document.getElementById('friendList');
    blockedList = document.getElementById('blockedList');
    chatSidebar = document.getElementById('chatSidebar');
    chatToggle = document.getElementById('chatToggle');
    chatHeader = document.getElementById('chatHeader');
    messageArea = document.getElementById('messageArea');
    messageInput = document.getElementById('messageInput');
    sendMessageBtn = document.getElementById('sendMessageBtn');
    userAvatar = document.getElementById('userAvatar');
    userMenu = document.getElementById('userMenu');
    userMenuToggle = document.getElementById('userMenuToggle');
    themeToggle = document.getElementById('themeToggle');
    hamburgerMenu = document.getElementById('hamburgerMenu');
    mobileMenu = document.getElementById('mobileMenu');

    // Get references to audio elements
    userJoinedSound = document.getElementById('userJoinedSound');
    userLeftSound = document.getElementById('userLeftSound');

    // Set initial display name if user data is available
    if (currentUser && currentUser.displayName && displayNameInput) {
        displayNameInput.value = currentUser.displayName;
    }

    // Log any missing elements
    const elements = {
        displayNameInput,
        joinBtn,
        warningMessage,
        welcomeSection,
        channelSection,
        usersList,
        muteBtn,
        deafenBtn,
        leaveBtn,
        friendMenu,
        friendRequestBtn,
        friendListBtn,
        friendBlockBtn,
        friendNotification,
        friendNotificationCount,
        friendNotificationList,
        friendList,
        blockedList,
        chatSidebar,
        chatToggle,
        chatHeader,
        messageArea,
        messageInput,
        sendMessageBtn,
        userAvatar,
        userMenu,
        userMenuToggle,
        themeToggle,
        hamburgerMenu,
        mobileMenu
    };

    for (const [name, element] of Object.entries(elements)) {
        if (!element) {
            console.warn(`Element ${name} not found in DOM`);
        }
    }

    // Add mousemove listener for cursor background effect
    document.addEventListener('mousemove', (e) => {
        const cursorBackground = document.getElementById('cursor-background');
        if (cursorBackground) {
            const x = `${e.clientX}px`;
            const y = `${e.clientY}px`;
            cursorBackground.style.background = `radial-gradient(circle at ${x} ${y}, rgba(163, 112, 247, 0.15) 0%, rgba(26, 27, 38, 0) 50%)`;
        }
    });
}

// Initialize event listeners
function initializeEventListeners() {
    // Check if join button exists
    if (!joinBtn) {
        console.error('Join button not found');
        return;
    }

    joinBtn.addEventListener('click', async () => {
        if (!displayNameInput) {
            console.error('Display name input not found');
            return;
        }

        const name = displayNameInput.value.trim();
        if (!name) {
            if (warningMessage) {
                warningMessage.textContent = 'Please enter your display name';
            }
            return;
        }

        if (!currentUser) {
            if (warningMessage) {
                warningMessage.textContent = 'User data not found. Please log in again.';
            }
            return;
        }

        joinBtn.classList.add('loading');
        joinBtn.innerHTML = '<i class="fas fa-spinner"></i> Connecting...';
        joinBtn.disabled = true;

        try {
            const webRTCInitialized = await initializeWebRTC();
            if (!webRTCInitialized) {
                if (warningMessage) {
                    warningMessage.textContent = 'Error accessing microphone';
                }
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

            if (welcomeSection) {
                welcomeSection.classList.add('hidden');
            }
            if (channelSection) {
                channelSection.classList.remove('hidden');
                channelSection.classList.add('visible');
            }

            if (socket) {
                socket.emit('joinChannel', {
                    id: currentUser.id,
                    displayName: displayName,
                    avatar_url: data?.avatar_url || null
                });
            }

            const userData = {
                id: currentUser.id,
                displayName: displayName,
                avatar_url: data?.avatar_url || null
            };
            users = [userData];
            updateUsersList(users);

            if (displayNameInput) {
                displayNameInput.disabled = true;
            }
            if (warningMessage) {
                warningMessage.textContent = '';
            }
            
            joinBtn.classList.remove('loading');
            joinBtn.innerHTML = '<i class="fas fa-check"></i> Connected';
            joinBtn.disabled = true;

        } catch (error) {
            console.error('Error joining channel:', error);
            if (warningMessage) {
                warningMessage.textContent = 'Failed to join channel. Please try again.';
            }
            joinBtn.classList.remove('loading');
            joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
            joinBtn.disabled = false;
        }
    });

    // Add mute button event listener if it exists
    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            isMuted = !isMuted;
            if (localStream) {
                localStream.getAudioTracks().forEach(track => {
                    track.enabled = !isMuted;
                });
            }
            const icon = muteBtn.querySelector('i');
            const text = muteBtn.querySelector('span');
            if (icon) {
                icon.className = isMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
            }
            if (text) {
                text.textContent = isMuted ? 'Unmute' : 'Mute';
            }

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
    }

    // Add deafen button event listener if it exists
    if (deafenBtn) {
        deafenBtn.addEventListener('click', () => {
            isDeafened = !isDeafened;
            document.querySelectorAll('audio').forEach(audio => {
                audio.muted = isDeafened;
            });
            const icon = deafenBtn.querySelector('i');
            const text = deafenBtn.querySelector('span');
            if (icon) {
                icon.className = isDeafened ? 'fas fa-volume-up' : 'fas fa-volume-mute';
            }
            if (text) {
                text.textContent = isDeafened ? 'Undeafen' : 'Deafen';
            }

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
    }

    // Add leave button event listener if it exists
    if (leaveBtn) {
        leaveBtn.addEventListener('click', () => {
            if (channelSection) {
                channelSection.classList.remove('visible');
                channelSection.classList.add('hidden');
            }

            setTimeout(() => {
                if (displayNameInput) {
                    displayNameInput.disabled = false;
                }
                if (joinBtn) {
                    joinBtn.disabled = false;
                    joinBtn.classList.remove('loading');
                    joinBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Join DUNE PC';
                }
                if (usersList) {
                    usersList.innerHTML = '';
                }
                if (warningMessage) {
                    warningMessage.textContent = '';
                }

                if (welcomeSection) {
                    welcomeSection.classList.remove('hidden');
                }

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
}

// Initialize WebRTC with simplified constraints
async function initializeWebRTC() {
    try {
        console.log('Initializing WebRTC...');
        
        // Simplified audio constraints
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });
        
        console.log('Audio stream obtained successfully');

        // Initialize audio context
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
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

        // Start voice activity detection
        startVoiceActivityDetection();

        console.log('Audio context and analyser initialized successfully');
        return true;
    } catch (error) {
        console.error('Error initializing WebRTC:', error);
        warningMessage.textContent = 'Error accessing microphone. Please check your permissions.';
        return false;
    }
}

// Add voice activity detection
function startVoiceActivityDetection() {
    if (!analyser || !audioContext) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let lastSpeakingState = false;

    function checkVoiceActivity() {
        if (!analyser || !audioContext) return;

        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        const isSpeaking = average > speakingThreshold;

        if (isSpeaking !== lastSpeakingState) {
            lastSpeakingState = isSpeaking;
            if (socket && socket.connected) {
                socket.emit(isSpeaking ? 'userSpeaking' : 'userStoppedSpeaking', {
                    userId: currentUser.id,
                    displayName: currentUser.displayName
                });
            }
        }

        requestAnimationFrame(checkVoiceActivity);
    }

    checkVoiceActivity();
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

        // Enhanced ICE server configuration
    const configuration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls: 'turn:relay1.expressturn.com:3480',
                username: '000000002064061488',
                credential: 'Y4KkTGe7+4T5LeMWjkXn5T5Zv54='
            }
        ],
            iceTransportPolicy: 'all',
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
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

        // Queue for ICE candidates
        peerConnection.queuedIceCandidates = [];

        // Add local stream with explicit audio track handling
    if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                console.log('Adding audio track to peer connection:', {
                    enabled: audioTrack.enabled,
                    muted: audioTrack.muted,
                    readyState: audioTrack.readyState
                });
                peerConnection.addTrack(audioTrack, localStream);
            } else {
                console.error('No audio track found in local stream');
                return null;
            }
        } else {
            console.error('No local stream available');
            return null;
        }

        // Enhanced ICE candidate handling with deduplication
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
                console.log('Sending ICE candidate to:', userId, event.candidate);
            socket.emit('ice-candidate', {
                    targetUserId: userId,
                candidate: event.candidate
            });
        }
    };

        // Enhanced track handling with verification
        peerConnection.ontrack = (event) => {
            console.log('Received tracks event:', event);
            console.log('Number of streams:', event.streams.length);
            
            if (event.streams && event.streams.length > 0) {
                const stream = event.streams[0];
                const tracks = stream.getTracks();
                console.log('Stream tracks:', tracks.map(t => ({
                    kind: t.kind,
                    enabled: t.enabled,
                    muted: t.muted,
                    readyState: t.readyState
                })));

                // Remove any existing audio element for this user
                const existingAudio = document.getElementById(`audio-${userId}`);
                if (existingAudio) {
                    console.log('Removing existing audio element');
                    existingAudio.remove();
                }

                const audioElement = document.createElement('audio');
                audioElement.id = `audio-${userId}`;
                audioElement.srcObject = stream;
                audioElement.autoplay = true;
                audioElement.muted = isDeafened;
                audioElement.volume = 1.0;
                
                // Add event listeners for debugging
                audioElement.onloadedmetadata = () => {
                    console.log(`Audio element loaded metadata for ${userId}`);
                    audioElement.play().catch(e => console.error('Error playing audio:', e));
                };
                
                audioElement.onplay = () => console.log(`Audio started playing for ${userId}`);
                audioElement.onpause = () => console.log(`Audio paused for ${userId}`);
                audioElement.onended = () => console.log(`Audio ended for ${userId}`);
                audioElement.onerror = (e) => console.error(`Audio error for ${userId}:`, e);
                
                document.body.appendChild(audioElement);
                console.log('Audio element created and added to DOM:', {
                    id: audioElement.id,
                    muted: audioElement.muted,
                    volume: audioElement.volume,
                    readyState: audioElement.readyState,
                    srcObject: !!audioElement.srcObject
                });

                // Force play the audio
                audioElement.play().catch(e => {
                    console.error('Error playing audio:', e);
                    // Try to recover by recreating the audio element
                    audioElement.remove();
                    const newAudioElement = document.createElement('audio');
                    newAudioElement.id = `audio-${userId}`;
                    newAudioElement.srcObject = stream;
                    newAudioElement.autoplay = true;
                    newAudioElement.muted = isDeafened;
                    newAudioElement.volume = 1.0;
                    document.body.appendChild(newAudioElement);
                    newAudioElement.play().catch(e => console.error('Error playing recovered audio:', e));
                });
            } else {
                console.error('No streams in track event');
            }
        };

        // Enhanced connection state monitoring with automatic recovery
    peerConnection.onconnectionstatechange = () => {
            console.log(`Connection state for ${userId}:`, peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                console.log(`Connection established with ${userId}, checking audio tracks...`);
                peerConnection.getReceivers().forEach(receiver => {
                    console.log('Receiver track:', {
                        kind: receiver.track.kind,
                        enabled: receiver.track.enabled,
                        muted: receiver.track.muted,
                        readyState: receiver.track.readyState
                    });
                });
            }
        if (peerConnection.connectionState === 'failed') {
                console.log(`Connection failed for ${userId}, attempting to restart ICE`);
            peerConnection.restartIce();
                setTimeout(async () => {
                    if (peerConnection.connectionState === 'failed') {
                        console.log(`Recreating connection to ${userId}`);
                        await createPeerConnection(userId, isInitiator);
                    }
                }, 2000);
            }
        };

        // Enhanced ICE connection state monitoring
    peerConnection.oniceconnectionstatechange = () => {
            console.log(`ICE connection state for ${userId}:`, peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'connected') {
                console.log(`ICE connection established with ${userId}`);
            }
        if (peerConnection.iceConnectionState === 'failed') {
                console.log(`ICE connection failed for ${userId}, attempting to restart ICE`);
            peerConnection.restartIce();
                setTimeout(async () => {
                    if (peerConnection.iceConnectionState === 'failed') {
                        console.log(`Recreating ICE connection to ${userId}`);
                        await createPeerConnection(userId, isInitiator);
                    }
                }, 2000);
            }
        };

        // Enhanced ICE gathering state monitoring
        peerConnection.onicegatheringstatechange = () => {
            console.log(`ICE gathering state for ${userId}:`, peerConnection.iceGatheringState);
        };

        // Enhanced ICE candidate error handling with reduced logging
        peerConnection.onicecandidateerror = (event) => {
            // Only log if it's not a common UDP transport error
            if (event.errorCode !== 701) {
                console.error(`ICE candidate error for ${userId}:`, event);
            }
        };

        // Enhanced signaling state monitoring
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
                    voiceActivityDetection: true,
                    iceRestart: true
            });
            await peerConnection.setLocalDescription(offer);
                console.log('Sending offer:', offer);
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

// Initialize Socket.io with null checks
function initializeSocket() {
    if (!socket) {
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
            if (warningMessage) {
                warningMessage.textContent = '';
            }
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
                users.push(userData);
                updateUsersList(users);
                if (userData.id !== currentUser.id && !peerConnections[userData.id]) {
                    await createPeerConnection(userData.id, true);
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
            users = usersList.filter(user => user.id !== currentUser.id);
            if (!users.some(user => user.id === currentUser.id)) {
                users.unshift(currentUser);
            }
            updateUsersList(users);

            usersList.forEach(async user => {
                if (user.id !== currentUser.id && !peerConnections[user.id]) {
                    await createPeerConnection(user.id, true);
                }
            });
        });

        socket.on('offer', async (data) => {
            console.log('Received offer:', data);
            try {
                let peerConnection = peerConnections[data.senderId];
                const isInitiator = false; // When receiving an offer, this client acts as answerer

                // If a peer connection for this sender doesn't exist, create one as the answerer
            if (!peerConnection) {
                    console.log(`No existing peer connection for ${data.senderId}, creating a new one as answerer`);
                    peerConnection = await createPeerConnection(data.senderId, isInitiator);
                } else {
                    console.log(`Existing peer connection found for ${data.senderId} in state: ${peerConnection.signalingState}`);

                    // Glare handling: If we receive an offer and we are already in 'have-local-offer' state,
                    // it means both sides sent offers simultaneously. We need to decide who wins.
                    // A common strategy is to compare user IDs. The client with the lexicographically smaller ID wins.
                    if (peerConnection.signalingState === 'have-local-offer') {
                        console.log(`Glare detected with user ${data.senderId}. Current state: have-local-offer. Resolving conflict...`);
                        // Compare user IDs to resolve glare
                        if (currentUser.id < data.senderId) {
                            console.log(`Winning glare resolution, processing offer from ${data.senderId}`);
                            // This client wins, proceed to set remote offer and send answer
                        } else {
                            console.log(`Losing glare resolution, ignoring offer from ${data.senderId}.`);
                            // This client loses, ignore the incoming offer and wait for the other side's answer to our offer
                return;
                        }
                    }
                     // If state is stable, it's likely the initial offer, proceed.
                     // If state is neither 'have-local-offer' nor 'stable' (and not invalid), log a warning.
                     else if (peerConnection.signalingState !== 'stable') {
                         console.warn(`Received offer for ${data.senderId} in state ${peerConnection.signalingState}. Proceeding with caution.`);
                     }

                     // If state is invalid for setting a remote offer, ignore.
                     if (peerConnection.signalingState === 'have-remote-offer' || peerConnection.signalingState === 'closed') {
                          console.log(`Ignoring received offer for ${data.senderId} in invalid signaling state: ${peerConnection.signalingState}.`);
                          return; // Ignore offer if state is invalid for setting a remote offer
                     }
                }

                if (peerConnection) {
                    // Proceed to set remote description and create/send answer
                    try {
                        console.log(`Setting remote description (offer) for ${data.senderId} in state: ${peerConnection.signalingState}`);
                        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
                        
                        // Create and send answer only after setting remote offer
                        console.log(`Creating answer for ${data.senderId}`);
                        const answer = await peerConnection.createAnswer();
                        await peerConnection.setLocalDescription(answer);
                        console.log('Sending answer:', answer);
                        socket.emit('answer', {
                            targetUserId: data.senderId,
                            answer: answer
                        });
                    } catch (error) {
                        console.error('Error handling offer (setting remote description or creating answer):', error);
                        // Close connection on error to prevent hanging states
                        peerConnection.close(); 
                        delete peerConnections[data.senderId];
                    }
                } else {
                     console.error('Failed to create or find peer connection for offer processing');
                }
            } catch (error) {
                console.error('Error handling received offer event:', error);
            }
        });

        socket.on('answer', async (data) => {
            console.log('Received answer:', data);
            try {
                const peerConnection = peerConnections[data.senderId];
                if (peerConnection) {
                    // Check signaling state before setting remote description
                    // An answer should typically be received when the state is 'have-local-offer'
                    if (peerConnection.signalingState === 'have-local-offer') {
                        try {
                            console.log(`Setting remote description (answer) for ${data.senderId} in state: ${peerConnection.signalingState}`);
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));

                            // Process any queued ICE candidates
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
                            // Close connection on error to prevent hanging states
                            peerConnection.close();
                            delete peerConnections[data.senderId];
                        }
                    } else {
                        console.warn(`Received answer in unexpected signaling state: ${peerConnection.signalingState} for user ${data.senderId}. Ignoring answer.`);
                        // If we receive an answer in a state like 'stable', it likely means the offer/answer 
                        // exchange is already complete or in a confused state. Ignoring it is safer than 
                        // attempting to set it, which causes the InvalidStateError.
                    }
                } else {
                    console.warn(`Received answer for unknown or closed peer connection with user ${data.senderId}.`);
                }
            } catch (error) {
                console.error('Error handling received answer event:', error);
            }
        });

        socket.on('ice-candidate', async (data) => {
            console.log('Received ICE candidate:', data);
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
                        // Queue the ICE candidate if remote description is not set yet
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

        // Listen for sound notification events (assuming server sends these)
        socket.on('userJoinedSound', () => {
            console.log('Received userJoinedSound event');
            if (userJoinedSound) {
                userJoinedSound.play().catch(error => console.error('Error playing userJoinedSound:', error));
            }
        });

        socket.on('userLeftSound', () => {
            console.log('Received userLeftSound event');
            if (userLeftSound) {
                userLeftSound.play().catch(error => console.error('Error playing userLeftSound:', error));
            }
        });
    }
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

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // First check if user is authenticated
        if (!initializeUserData()) {
            console.error('Failed to initialize user data');
            return;
        }

        // Initialize DOM elements
        initializeDOMElements();
        
        // Initialize socket connection first
        initializeSocket();
        
        // Wait for socket to be ready
        await new Promise((resolve) => {
            if (socket && socket.connected) {
                resolve();
            } else {
                socket.on('connect', resolve);
            }
        });
        
        // Then initialize event listeners
        initializeEventListeners();
        
        // Initialize friend system after socket is ready
        initializeFriendSystem();
        
        // Initialize WebRTC last
        await initializeWebRTC();
        
        console.log('Application initialized successfully');
    } catch (error) {
        console.error('Error initializing application:', error);
        if (warningMessage) {
            warningMessage.textContent = 'Error initializing application. Please refresh the page.';
        }
    }
});

// Theme Toggle
const themeToggle = document.getElementById('themeToggle');
if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });
}

// Load saved theme
const savedTheme = localStorage.getItem('theme');
if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
}

// Enhanced User Status Updates
function updateUserStatus(userId, status) {
    const userItem = document.querySelector(`[data-user-id="${userId}"]`);
    if (userItem) {
        const statusIndicator = userItem.querySelector('.avatar-status');
        if (statusIndicator) {
            statusIndicator.className = 'avatar-status';
            statusIndicator.classList.add(`status-${status.toLowerCase()}`);
        }
    }
}

// Enhanced Audio Controls
function setupAudioControls() {
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
        audio.addEventListener('play', () => {
            const userItem = audio.closest('.user-item');
            if (userItem) {
                userItem.classList.add('speaking');
            }
        });

        audio.addEventListener('pause', () => {
            const userItem = audio.closest('.user-item');
            if (userItem) {
                userItem.classList.remove('speaking');
            }
        });
    });
}

// Enhanced Error Handling with UI Feedback
function showError(message, duration = 3000) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);

    setTimeout(() => {
        errorDiv.classList.add('fade-out');
        setTimeout(() => errorDiv.remove(), 500);
    }, duration);
}

// Enhanced Connection Status Updates
function updateConnectionStatus(status) {
    const statusIndicator = document.querySelector('.connection-status');
    if (statusIndicator) {
        statusIndicator.className = 'connection-status';
        statusIndicator.classList.add(`status-${status.toLowerCase()}`);
        statusIndicator.textContent = status;
    }
}

// Enhanced Welcome Section Transitions
function showWelcomeSection() {
    const welcomeSection = document.querySelector('.welcome-section');
    if (welcomeSection) {
        welcomeSection.style.display = 'flex';
        setTimeout(() => welcomeSection.classList.add('visible'), 50);
    }
}

function hideWelcomeSection() {
    const welcomeSection = document.querySelector('.welcome-section');
    if (welcomeSection) {
        welcomeSection.classList.remove('visible');
        setTimeout(() => welcomeSection.style.display = 'none', 500);
    }
}

// Enhanced Channel Section Transitions
function showChannelSection() {
    const channelSection = document.querySelector('.channel-section');
    if (channelSection) {
        channelSection.style.display = 'flex';
        setTimeout(() => channelSection.classList.add('visible'), 50);
    }
}

function hideChannelSection() {
    const channelSection = document.querySelector('.channel-section');
    if (channelSection) {
        channelSection.classList.remove('visible');
        setTimeout(() => channelSection.style.display = 'none', 500);
    }
}

// Enhanced User List Updates
function updateUserList(users) {
    const usersGrid = document.querySelector('.users-grid');
    if (usersGrid) {
        usersGrid.innerHTML = '';
        users.forEach(user => {
            const userItem = createUserItem(user);
            usersGrid.appendChild(userItem);
        });
    }
}

function createUserItem(user) {
    const userItem = document.createElement('div');
    userItem.className = 'user-item';
    userItem.setAttribute('data-user-id', user.id);

    userItem.innerHTML = `
        <div class="avatar-wrapper">
            <img src="${user.avatar || 'default-avatar.png'}" alt="${user.name}" class="user-avatar">
            <div class="avatar-status status-${user.status.toLowerCase()}"></div>
        </div>
        <span class="user-name">${user.name}</span>
        <span class="user-status">${user.status}</span>
        <audio id="audio-${user.id}" autoplay></audio>
    `;

    return userItem;
}

// Initialize UI
document.addEventListener('DOMContentLoaded', () => {
    setupAudioControls();
    showWelcomeSection();
});

// Function to get saved cursor style from localStorage
// Note: Logic to select and save cursor style needs to be implemented on the profile page.
// The profile page script should save the chosen style string (e.g., 'cursor-pointer-custom')
// to localStorage with the key 'cursorStyle'.

// Friend System
function initializeFriendSystem() {
    if (!socket || !socket.connected) {
        console.warn('Socket not initialized or not connected, friend system may not work properly');
        return;
    }

    // Initialize friend menu if it exists
    if (friendMenu) {
        friendMenu.style.display = 'none';
    }

    // Initialize friend notification if it exists
    if (friendNotification) {
        friendNotification.style.display = 'none';
    }

    // Initialize chat sidebar if it exists
    if (chatSidebar) {
        chatSidebar.style.display = 'none';
    }

    // Handle friend menu clicks
    document.addEventListener('click', (e) => {
        const friendMenuBtn = e.target.closest('.friend-menu-btn');
        if (friendMenuBtn) {
            const menu = friendMenuBtn.nextElementSibling;
            if (menu) {
                const allMenus = document.querySelectorAll('.friend-menu');
                
                // Close all other menus
                allMenus.forEach(m => {
                    if (m !== menu) m.classList.remove('active');
                });
                
                menu.classList.toggle('active');
                e.stopPropagation();
            }
        } else if (!e.target.closest('.friend-menu')) {
            // Close all menus when clicking outside
            document.querySelectorAll('.friend-menu').forEach(menu => {
                menu.classList.remove('active');
            });
        }
    });

    // Handle friend actions
    document.addEventListener('click', async (e) => {
        const action = e.target.closest('.friend-action');
        if (!action) return;

        const userCard = action.closest('.user-card');
        if (!userCard) return;

        const targetUserId = userCard.dataset.userId;
        if (!targetUserId || !currentUser) return;

        if (action.classList.contains('add-friend')) {
            await sendFriendRequest(targetUserId);
        } else if (action.classList.contains('remove-friend')) {
            await removeFriend(targetUserId);
        } else if (action.classList.contains('block-user')) {
            await blockUser(targetUserId);
        }
    });

    // Set up socket event listeners for friend system
    socket.on('friendRequest', async (data) => {
        if (data.receiverId === currentUser.id) {
            showFriendRequestNotification(data);
        }
    });

    socket.on('friendRequestResponse', async (data) => {
        if (data.userId === currentUser.id) {
            const userCard = document.querySelector(`[data-user-id="${data.senderId}"]`);
            if (userCard) {
                const addFriendBtn = userCard.querySelector('.add-friend');
                const removeFriendBtn = userCard.querySelector('.remove-friend');
                if (data.status === 'accepted') {
                    addFriendBtn.classList.add('hidden');
                    removeFriendBtn.classList.remove('hidden');
                }
            }
        }
    });
}

// Send friend request
async function sendFriendRequest(targetUserId) {
    if (!currentUser) return;
    
    try {
        const { data, error } = await supabase
            .from('friend_requests')
            .insert([
                {
                    sender_id: currentUser.id,
                    receiver_id: targetUserId,
                    status: 'pending'
                }
            ]);

        if (error) throw error;

        // Emit socket event for real-time notification
        socket.emit('friendRequest', {
            senderId: currentUser.id,
            receiverId: targetUserId,
            senderName: currentUser.displayName
        });

        showMessage('Friend request sent!', 'success');
    } catch (error) {
        console.error('Error sending friend request:', error);
        showMessage('Failed to send friend request', 'error');
    }
}

// Show friend request notification
function showFriendRequestNotification(data) {
    const notification = document.createElement('div');
    notification.className = 'friend-notification';
    notification.innerHTML = `
        <div class="avatar-wrapper">
            <img src="${data.senderAvatar || 'assets/images/default-avatar.svg'}" alt="User Avatar">
        </div>
        <div class="notification-content">
            <strong>${data.senderName}</strong> sent you a friend request
        </div>
        <div class="notification-actions">
            <button class="accept-btn" data-request-id="${data.requestId}">Accept</button>
            <button class="reject-btn" data-request-id="${data.requestId}">Reject</button>
        </div>
    `;

    document.body.appendChild(notification);

    // Handle accept/reject
    notification.querySelector('.accept-btn').addEventListener('click', async () => {
        await handleFriendRequest(data.requestId, 'accepted');
        notification.remove();
    });

    notification.querySelector('.reject-btn').addEventListener('click', async () => {
        await handleFriendRequest(data.requestId, 'rejected');
        notification.remove();
    });

    // Auto remove after 30 seconds
    setTimeout(() => {
        notification.remove();
    }, 30000);
}

// Handle friend request response
async function handleFriendRequest(requestId, status) {
    if (!currentUser) return;
    
    try {
        const { data, error } = await supabase
            .from('friend_requests')
            .update({ status })
            .eq('id', requestId);

        if (error) throw error;

        // Emit socket event for real-time update
        socket.emit('friendRequestResponse', {
            requestId,
            status,
            userId: currentUser.id
        });

        if (status === 'accepted') {
            showMessage('Friend request accepted!', 'success');
        }
    } catch (error) {
        console.error('Error handling friend request:', error);
        showMessage('Failed to process friend request', 'error');
    }
}

// Remove friend
async function removeFriend(targetUserId) {
    if (!currentUser) return;
    
    try {
        const { data, error } = await supabase
            .from('friend_relationships')
            .delete()
            .or(`user_id.eq.${currentUser.id},friend_id.eq.${currentUser.id}`)
            .or(`user_id.eq.${targetUserId},friend_id.eq.${targetUserId}`);

        if (error) throw error;

        // Update UI
        const userCard = document.querySelector(`[data-user-id="${targetUserId}"]`);
        if (userCard) {
            const addFriendBtn = userCard.querySelector('.add-friend');
            const removeFriendBtn = userCard.querySelector('.remove-friend');
            addFriendBtn.classList.remove('hidden');
            removeFriendBtn.classList.add('hidden');
        }

        showMessage('Friend removed', 'success');
    } catch (error) {
        console.error('Error removing friend:', error);
        showMessage('Failed to remove friend', 'error');
    }
}

// Block user
async function blockUser(targetUserId) {
    if (!currentUser) return;
    
    try {
        const { data, error } = await supabase
            .from('blocked_users')
            .insert([
                {
                    user_id: currentUser.id,
                    blocked_user_id: targetUserId
                }
            ]);

        if (error) throw error;

        // Update UI
        const userCard = document.querySelector(`[data-user-id="${targetUserId}"]`);
        if (userCard) {
            userCard.style.opacity = '0.5';
        }

        showMessage('User blocked', 'success');
    } catch (error) {
        console.error('Error blocking user:', error);
        showMessage('Failed to block user', 'error');
    }
}

// Helper function to show messages
function showMessage(message, type = 'info') {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    messageDiv.textContent = message;
    document.body.appendChild(messageDiv);

    setTimeout(() => {
        messageDiv.classList.add('fade-out');
        setTimeout(() => messageDiv.remove(), 500);
    }, 3000);
}
