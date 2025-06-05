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

// Audio elements for notifications
let userJoinedSound;
let userLeftSound;

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

// --- UNREAD MESSAGE BADGES AND SORTING FOR SIDEBAR FRIENDS ---
let sidebarUnreadCounts = {};

// --- LIVE UPDATE UNREAD COUNTS WITH SUPABASE REALTIME (RELIABLE) ---
let sidebarUnreadChannel = null;
async function subscribeSidebarUnreadRealtime() {
    if (sidebarUnreadChannel) {
        await supabase.removeChannel(sidebarUnreadChannel);
        sidebarUnreadChannel = null;
    }
    sidebarUnreadChannel = supabase.channel('sidebar-unread-messages')
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'user_messages',
        }, payload => {
            updateSidebarUnreadCounts();
        });
    await sidebarUnreadChannel.subscribe();
}
subscribeSidebarUnreadRealtime();
// Remove polling interval for unread counts (rely on realtime)
if (window.sidebarUnreadInterval) clearInterval(window.sidebarUnreadInterval);

// --- LIVE UPDATE FRIENDS LIST IN SIDEBAR ---
let sidebarFriendsChannel = null;
async function subscribeSidebarFriendsRealtime() {
    if (sidebarFriendsChannel) {
        await supabase.removeChannel(sidebarFriendsChannel);
        sidebarFriendsChannel = null;
    }
    sidebarFriendsChannel = supabase.channel('sidebar-friends')
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'user_friends',
        }, payload => {
            renderFriendsSidebarList();
        });
    await sidebarFriendsChannel.subscribe();
}
subscribeSidebarFriendsRealtime();

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

    // Get references to audio elements
    userJoinedSound = document.getElementById('userJoinedSound');
    userLeftSound = document.getElementById('userLeftSound');

    // Set initial display name if user data is available
    if (currentUser && currentUser.displayName) {
        displayNameInput.value = currentUser.displayName;
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

    // Listen for soundboard events from others (moved here to ensure socket is initialized)
    socket.on('soundboard', ({ fileUrl }) => {
        if (!soundboardEnabled) return;
        const audio = new Audio(fileUrl);
        audio.play();
    });

    // --- SCREEN SHARE STATE HANDLERS ---
    socket.on('screenShareState', data => {
        console.log('[ScreenShare] Received screenShareState event:', data);
        if (data.state === 'start') {
            screenShareOwnerId = data.userId;
            updateScreenShareIconOnUserCards();
        } else if (data.state === 'stop') {
            screenShareOwnerId = null;
            hideScreenShareView();
            updateScreenShareIconOnUserCards();
        }
    });
    // Listen for screen share stream requests
    socket.on('requestScreenShareStream', ({ ownerId, viewerId }) => {
        if (currentUser.id === ownerId && screenShareStream) {
            // Send stream to viewer (peer-to-peer logic assumed)
            // In mesh, viewer will renegotiate and get the video track
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
                    .limit(1);
                if (!error && data && data.length > 0 && data[0].avatar_url) {
                    const img = userItem.querySelector('.user-avatar');
                    if (img) {
                        img.src = data[0].avatar_url;
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

// Initialize particles.js
document.addEventListener('DOMContentLoaded', () => {
    if (typeof particlesJS !== 'undefined') {
        particlesJS('particles-js', {
            particles: {
                number: {
                    value: 80,
                    density: {
                        enable: true,
                        value_area: 800
                    }
                },
                color: {
                    value: '#00ff9d'
                },
                shape: {
                    type: 'circle'
                },
                opacity: {
                    value: 0.5,
                    random: false
                },
                size: {
                    value: 3,
                    random: true
                },
                line_linked: {
                    enable: true,
                    distance: 150,
                    color: '#00ff9d',
                    opacity: 0.4,
                    width: 1
                },
                move: {
                    enable: true,
                    speed: 2,
                    direction: 'none',
                    random: false,
                    straight: false,
                    out_mode: 'out',
                    bounce: false
                }
            },
            interactivity: {
                detect_on: 'canvas',
                events: {
                    onhover: {
                        enable: true,
                        mode: 'grab'
                    },
                    onclick: {
                        enable: true,
                        mode: 'push'
                    },
                    resize: true
                },
                modes: {
                    grab: {
                        distance: 140,
                        line_linked: {
                            opacity: 1
                        }
                    },
                    push: {
                        particles_nb: 4
                    }
                }
            },
            retina_detect: true
        });
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

// Friend system and notifications

// --- FRIEND REQUEST SYSTEM ---

// Helper: Get current user from localStorage
function getCurrentUser() {
    return JSON.parse(localStorage.getItem('user'));
}

// --- SAFE EVENT LISTENER ASSIGNMENTS ---
function safeAddEventListener(id, event, handler) {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener(event, handler);
    } else {
        console.warn('Element not found for event listener:', id);
    }
}
function safeSetOnClick(id, handler) {
    const el = document.getElementById(id);
    if (el) {
        el.onclick = handler;
    } else {
        console.warn('Element not found for onclick:', id);
    }
}
// Use safeAddEventListener and safeSetOnClick for all event listeners
safeSetOnClick('soundboardBtn', openSoundboardModal);
safeSetOnClick('closeSoundboardModal', closeSoundboardModal);
safeAddEventListener('soundboardModalOverlay', 'click', function(e) {
    if (e.target === this) closeSoundboardModal();
});
safeAddEventListener('soundboardToggle', 'change', function(e) {
    soundboardEnabled = e.target.checked;
});
safeSetOnClick('screenshareBtn', function() {
    alert('Screenshare coming soon!');
});

// Helper: Get friendship status between current user and another user
async function getFriendshipStatus(currentUserId, otherUserId) {
    if (!currentUserId || !otherUserId) return null;
    try {
        // Check for accepted or pending friendship in either direction
        const { data, error } = await supabase
            .from('user_friends')
            .select('user_id, friend_id, status')
            .or(`and(user_id.eq.${currentUserId},friend_id.eq.${otherUserId}),and(user_id.eq.${otherUserId},friend_id.eq.${currentUserId})`);
        if (error) {
            console.error('getFriendshipStatus error:', error);
            return null;
        }
        if (!data || data.length === 0) return null;
        // If any row is accepted, return 'accepted'
        if (data.some(row => row.status === 'accepted')) return 'accepted';
        // If any row is pending and you sent it
        if (data.some(row => row.status === 'pending' && row.user_id === currentUserId)) return 'pending';
        // If any row is pending and they sent it
        if (data.some(row => row.status === 'pending' && row.user_id === otherUserId)) return 'incoming';
        return null;
    } catch (err) {
        console.error('getFriendshipStatus exception:', err);
        return null;
    }
}

// Helper: Send friend request
async function sendFriendRequest(currentUserId, otherUserId, otherDisplayName) {
    if (!currentUserId || !otherUserId) {
        console.error('sendFriendRequest: Missing user IDs', currentUserId, otherUserId);
        return;
    }
    if (typeof currentUserId !== 'string' || typeof otherUserId !== 'string') {
        console.error('sendFriendRequest: IDs must be strings', currentUserId, otherUserId);
        return;
    }
    console.log('Sending friend request with friend_id:', otherUserId, 'status: pending');
    if (!otherUserId || typeof otherUserId !== 'string') {
        console.error('Invalid friendId for user_friends upsert:', otherUserId);
        return;
    }
    await supabase.from('user_friends').upsert([
        { user_id: currentUserId, friend_id: otherUserId, status: 'pending' }
    ]);
    await supabase.from('user_notifications').insert([
        {
            user_id: otherUserId,
            type: 'friend_request',
            message: `${getCurrentUser().displayName} sent you a friend request!`,
            is_read: false
        }
    ]);
}

// Helper: Accept friend request
async function acceptFriendRequest(currentUserId, otherUserId) {
    // Update both directions to accepted
    await supabase.from('user_friends')
        .update({ status: 'accepted' })
        .or(`and(user_id.eq.${currentUserId},friend_id.eq.${otherUserId}),and(user_id.eq.${otherUserId},friend_id.eq.${currentUserId})`);
    // Optionally, mark notification as read
    await supabase.from('user_notifications')
        .update({ is_read: true })
        .eq('user_id', currentUserId)
        .eq('type', 'friend_request');
}

// Helper: Decline friend request
async function declineFriendRequest(currentUserId, otherUserId) {
    await supabase.from('user_friends')
        .delete()
        .or(`and(user_id.eq.${otherUserId},friend_id.eq.${currentUserId}),and(user_id.eq.${currentUserId},friend_id.eq.${otherUserId})`);
    await supabase.from('user_notifications')
        .update({ is_read: true })
        .eq('user_id', currentUserId)
        .eq('type', 'friend_request');
}

// Helper: Show push notification for friend requests
function showFriendRequestNotification(fromUserId, fromDisplayName) {
    // Create notification element
    const notif = document.createElement('div');
    notif.className = 'friend-request-toast';
    notif.innerHTML = `
        <span>${fromDisplayName} sent you a friend request!</span>
        <button class="accept-btn">Accept</button>
        <button class="decline-btn">Decline</button>
    `;
    document.body.appendChild(notif);
    // Accept
    notif.querySelector('.accept-btn').onclick = async () => {
        await acceptFriendRequest(getCurrentUser().id, fromUserId);
        notif.remove();
        updateUsersList(users); // Refresh UI
        renderFriendsSidebarList(); // Also refresh sidebar
    };
    // Decline
    notif.querySelector('.decline-btn').onclick = async () => {
        await declineFriendRequest(getCurrentUser().id, fromUserId);
        notif.remove();
        updateUsersList(users); // Refresh UI
        renderFriendsSidebarList(); // Also refresh sidebar
    };
    setTimeout(() => notif.remove(), 10000);
}

// Poll for new friend request notifications
setInterval(async () => {
    const currentUser = getCurrentUser();
    if (!currentUser) return;
    const { data, error } = await supabase
        .from('user_notifications')
        .select('*')
        .eq('user_id', currentUser.id)
        .eq('type', 'friend_request')
        .eq('is_read', false);
    if (data && data.length > 0) {
        for (const notif of data) {
            // Find who sent the request
            const { data: friendRows } = await supabase
                .from('user_friends')
                .select('user_id')
                .eq('friend_id', currentUser.id)
                .eq('status', 'pending')
                .limit(1);
            if (friendRows && friendRows.length > 0) {
                // Get sender's display name
                const { data: senderRows } = await supabase
                    .from('users')
                    .select('display_name')
                    .eq('id', friendRows[0].user_id)
                    .limit(1);
                showFriendRequestNotification(friendRows[0].user_id, senderRows && senderRows.length > 0 ? senderRows[0].display_name : 'Someone');
            }
        }
    }
}, 5000);

// --- PATCH createUserListItem to add friend button ---
const origCreateUserListItem = createUserListItem;
createUserListItem = function(userData) {
    const userItem = origCreateUserListItem(userData);
    const currentUser = getCurrentUser();
    if (!currentUser || userData.id === currentUser.id) return userItem;
    // Add friend button
    const friendBtn = document.createElement('button');
    friendBtn.className = 'friend-btn';
    // Check friendship status
    getFriendshipStatus(currentUser.id, userData.id).then(status => {
        if (status === 'accepted') {
            friendBtn.textContent = 'You are friends';
            friendBtn.disabled = true;
        } else if (status === 'pending') {
            friendBtn.textContent = 'Request Sent';
            friendBtn.disabled = true;
        } else if (status === 'incoming') {
            friendBtn.textContent = 'Accept Request';
            friendBtn.disabled = false;
            friendBtn.onclick = async (e) => {
                e.stopPropagation();
                await acceptFriendRequest(currentUser.id, userData.id);
                friendBtn.textContent = 'You are friends';
                friendBtn.disabled = true;
            };
            return;
        } else {
            friendBtn.textContent = 'Add Friend';
            friendBtn.disabled = false;
        }
    });
    friendBtn.onclick = async (e) => {
        e.stopPropagation();
        await sendFriendRequest(currentUser.id, userData.id, userData.displayName);
        friendBtn.textContent = 'Request Sent';
        friendBtn.disabled = true;
    };
    userItem.appendChild(friendBtn);
    return userItem;
};

// --- Minimal CSS for friend button and notification ---
const friendStyle = document.createElement('style');
friendStyle.textContent = `
.friend-btn {
  margin-top: 8px;
  padding: 6px 14px;
  border-radius: 6px;
  background: var(--primary-color, #a370f7);
  color: #fff;
  border: none;
  cursor: pointer;
  font-size: 0.95rem;
  transition: background 0.2s;
}
.friend-btn[disabled] {
  background: #aaa;
  cursor: not-allowed;
}
.friend-request-toast {
  position: fixed;
  bottom: 30px;
  right: 30px;
  background: #222;
  color: #fff;
  padding: 18px 24px;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 16px;
}
.friend-request-toast .accept-btn, .friend-request-toast .decline-btn {
  margin-left: 10px;
  padding: 6px 12px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-weight: bold;
}
.friend-request-toast .accept-btn { background: #2ecc71; color: #fff; }
.friend-request-toast .decline-btn { background: #e74c3c; color: #fff; }
`;
document.head.appendChild(friendStyle);

// --- REMOVE CHAT SECTION FROM SIDEBAR, SHOW ONLY FRIENDS LIST ---
// Patch: Remove chat-section logic and DOM refs
// Sidebar now only shows friends list

// --- PATCH: Ensure unread badge always appears and is styled correctly ---
(function injectSidebarUnreadBadgeCSS() {
    if (!document.getElementById('sidebar-unread-badge-style')) {
        const style = document.createElement('style');
        style.id = 'sidebar-unread-badge-style';
        style.textContent = `
        .sidebar-friend-unread {
            background: #e74c3c;
            color: #fff;
            border-radius: 50%;
            font-size: 0.78rem;
            min-width: 20px;
            height: 20px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-left: 8px;
            font-weight: bold;
            box-shadow: 0 1px 4px rgba(0,0,0,0.12);
            position: relative;
            top: 0;
            right: 0;
        }
        `;
        document.head.appendChild(style);
    }
})();
// PATCH renderFriendsSidebarList to always append badge
async function renderFriendsSidebarList() {
    const user = getCurrentUser();
    if (!user) return;
    const sidebarList = document.getElementById('friendsSidebarList');
    if (!sidebarList) return;
    // Get all accepted friends
    const { data, error } = await supabase
        .from('user_friends')
        .select('user_id, friend_id, status')
        .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`)
        .eq('status', 'accepted');
    if (error) return;
    const friendIds = data
        .map(row => row.user_id === user.id ? row.friend_id : row.user_id)
        .filter(id => id !== user.id);
    if (friendIds.length === 0) {
        sidebarList.innerHTML = '<div style="color:#aaa;padding:10px;">No friends yet.</div>';
        return;
    }
    const { data: friends } = await supabase
        .from('users')
        .select('id, display_name, avatar_url')
        .in('id', friendIds);
    // Sort: friends with unread messages first, then by name
    friends.sort((a, b) => {
        const aUnread = sidebarUnreadCounts[a.id] || 0;
        const bUnread = sidebarUnreadCounts[b.id] || 0;
        if (aUnread !== bUnread) return bUnread - aUnread;
        return a.display_name.localeCompare(b.display_name);
    });
    sidebarList.innerHTML = '';
    // Debug log for unread counts
    console.log('sidebarUnreadCounts:', sidebarUnreadCounts);
    friends.forEach(friend => {
        const div = document.createElement('div');
        div.className = 'sidebar-friend';
        div.innerHTML = `<img src="${friend.avatar_url || 'assets/images/default-avatar.svg'}" class="sidebar-friend-avatar"><span class="sidebar-friend-name">${friend.display_name}</span>`;
        if (sidebarUnreadCounts[friend.id] > 0) {
            const badge = document.createElement('span');
            badge.className = 'sidebar-friend-unread';
            badge.textContent = sidebarUnreadCounts[friend.id];
            div.appendChild(badge);
        }
        div.onclick = () => openChatModal(friend);
        div.dataset.friendId = friend.id;
        sidebarList.appendChild(div);
    });
}

// --- CHAT MODAL LOGIC ---
let chatModalCurrentFriend = null;

function openChatModal(friend) {
    chatModalCurrentFriend = friend;
    const overlay = document.getElementById('chatModalOverlay');
    overlay.style.display = 'flex';
    setTimeout(() => overlay.classList.add('active'), 10);
    renderChatModalFriends(friend.id);
    renderChatModalHeader(friend);
    loadChatModalMessages(friend.id);
}

function closeChatModal() {
    const overlay = document.getElementById('chatModalOverlay');
    overlay.classList.remove('active');
    setTimeout(() => { overlay.style.display = 'none'; }, 320);
    chatModalCurrentFriend = null;
}

// Render friends list in modal (for quick switching)
async function renderChatModalFriends(selectedId) {
    const user = getCurrentUser();
    if (!user) return;
    const modalFriends = document.getElementById('chatModalFriends');
    if (!modalFriends) return;
    const { data, error } = await supabase
        .from('user_friends')
        .select('user_id, friend_id, status')
        .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`)
        .eq('status', 'accepted');
    if (error) return;
    const friendIds = data
        .map(row => row.user_id === user.id ? row.friend_id : row.user_id)
        .filter(id => id !== user.id);
    if (friendIds.length === 0) {
        modalFriends.innerHTML = '<div style="color:#aaa;padding:10px;">No friends yet.</div>';
        return;
    }
    const { data: friends } = await supabase
        .from('users')
        .select('id, display_name, avatar_url')
        .in('id', friendIds);
    modalFriends.innerHTML = '';
    friends.forEach(friend => {
        const div = document.createElement('div');
        div.className = 'modal-friend' + (friend.id === selectedId ? ' selected' : '');
        div.innerHTML = `<img src="${friend.avatar_url || 'assets/images/default-avatar.svg'}" class="modal-friend-avatar"><span class="modal-friend-name">${friend.display_name}</span>`;
        div.onclick = () => openChatModal(friend);
        div.dataset.friendId = friend.id;
        modalFriends.appendChild(div);
    });
}

function renderChatModalHeader(friend) {
    document.getElementById('chatModalHeader').textContent = friend.display_name;
}

async function loadChatModalMessages(friendId) {
    const user = getCurrentUser();
    if (!user) return;
    const { data, error } = await supabase
        .from('user_messages')
        .select('*')
        .or(`and(sender_id.eq.${user.id},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${user.id})`)
        .order('created_at', { ascending: true })
        .limit(50);
    if (error) return;
    renderChatModalMessages(data || [], user.id);
}

// --- PATCH: Animate new chat messages ---
(function injectChatMessageAnimationCSS() {
    if (!document.getElementById('chat-message-animate-style')) {
        const style = document.createElement('style');
        style.id = 'chat-message-animate-style';
        style.textContent = `
        .chat-message-animate {
            animation: chatMessageFadeIn 0.45s cubic-bezier(0.23, 1, 0.32, 1);
        }
        @keyframes chatMessageFadeIn {
            0% { opacity: 0; transform: translateY(24px) scale(0.98); }
            60% { opacity: 1; transform: translateY(-4px) scale(1.01); }
            100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        `;
        document.head.appendChild(style);
    }
})();
// PATCH renderChatModalMessages to animate only the newest message
let lastMessageCount = 0;
function renderChatModalMessages(messages, myId) {
    const chatModalMessages = document.getElementById('chatModalMessages');
    chatModalMessages.innerHTML = '';
    if (!messages.length) {
        chatModalMessages.innerHTML = '<div class="chat-modal-messages-empty">No messages yet. Say hello!</div>';
        lastMessageCount = 0;
        return;
    }
    messages.forEach((msg, idx) => {
        const div = document.createElement('div');
        div.className = 'chat-message' + (msg.sender_id === myId ? ' me' : '');
        div.innerHTML = `<div class=\"msg-bubble\">${escapeHtml(msg.message)}</div><div class=\"msg-meta\">${formatTime(msg.created_at)}</div>`;
        // Animate only the newest message
        if (idx === messages.length - 1 && messages.length > lastMessageCount) {
            div.classList.add('chat-message-animate');
        }
        chatModalMessages.appendChild(div);
    });
    lastMessageCount = messages.length;
    chatModalMessages.scrollTop = chatModalMessages.scrollHeight;
}

// Send message in modal
function patchChatModalSend() {
    const chatModalInputForm = document.getElementById('chatModalInputForm');
    if (!chatModalInputForm) return;
    chatModalInputForm.onsubmit = async (e) => {
        e.preventDefault();
        const input = document.getElementById('chatModalInput');
        const msg = input.value.trim();
        if (!msg || !chatModalCurrentFriend) return;
        const user = getCurrentUser();
        await supabase.from('user_messages').insert([
            { sender_id: user.id, receiver_id: chatModalCurrentFriend.id, message: msg }
        ]);
        input.value = '';
        loadChatModalMessages(chatModalCurrentFriend.id);
    };
    // Enter key sends message
    document.getElementById('chatModalInput').onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatModalInputForm.dispatchEvent(new Event('submit', { cancelable: true }));
        }
    };
}

// Modal close logic
function setupChatModalClose() {
    document.getElementById('closeChatModal').onclick = closeChatModal;
    document.getElementById('chatModalOverlay').onclick = function(e) {
        if (e.target === this) closeChatModal();
    };
}

// On DOMContentLoaded, initialize sidebar friends and modal logic
const origDOMContentLoaded2 = document.onreadystatechange;
document.onreadystatechange = function() {
    if (origDOMContentLoaded2) origDOMContentLoaded2();
    if (document.readyState === 'complete') {
        renderFriendsSidebarList();
        patchChatModalSend();
        setupChatModalClose();
    }
};

// --- CSS for modal and friends list ---
(function injectChatModalOverlayCSS() {
    if (!document.getElementById('chat-modal-overlay-style')) {
        const style = document.createElement('style');
        style.id = 'chat-modal-overlay-style';
        style.textContent = `
        .chat-modal-overlay {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(30,32,44,0.85);
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(2.5px);
            transition: opacity 0.32s cubic-bezier(0.23, 1, 0.32, 1);
        }
        .chat-modal {
            background: #23243a;
            border-radius: 18px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 1.5px 8px rgba(163,112,247,0.08);
            min-width: 340px;
            max-width: 98vw;
            width: 540px;
            min-height: 420px;
            max-height: 90vh;
            display: flex;
            flex-direction: column;
            position: relative;
            overflow: hidden;
        }
        .close-chat-modal {
            position: absolute;
            top: 14px;
            right: 18px;
            background: none;
            border: none;
            color: #fff;
            font-size: 2.1rem;
            cursor: pointer;
            z-index: 2;
            transition: color 0.18s;
        }
        .close-chat-modal:hover {
            color: #a370f7;
        }
        `;
        document.head.appendChild(style);
    }
})();

(function injectSidebarFriendCSS() {
    if (!document.getElementById('sidebar-friend-style')) {
        const style = document.createElement('style');
        style.id = 'sidebar-friend-style';
        style.textContent = `
        .sidebar-friend {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            padding: 7px 10px;
            border-radius: 7px;
            cursor: pointer;
            transition: background 0.2s;
            margin-bottom: 2px;
        }
        .sidebar-friend:hover {
            background: #23243a;
        }
        .sidebar-friend-avatar {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            object-fit: cover;
            border: 2px solid #a370f7;
        }
        .sidebar-friend-name {
            font-size: 0.98rem;
            color: #fff;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        `;
        document.head.appendChild(style);
    }
})();

(function injectChatModalAnimationCSS() {
    if (!document.getElementById('chat-modal-anim-style')) {
        const style = document.createElement('style');
        style.id = 'chat-modal-anim-style';
        style.textContent = `
        .chat-modal-overlay {
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.32s cubic-bezier(0.23, 1, 0.32, 1);
        }
        .chat-modal-overlay.active {
            opacity: 1;
            pointer-events: auto;
        }
        .chat-modal {
            transform: scale(0.92) translateY(32px);
            opacity: 0;
            transition: transform 0.32s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.32s cubic-bezier(0.23, 1, 0.32, 1);
        }
        .chat-modal-overlay.active .chat-modal {
            transform: scale(1) translateY(0);
            opacity: 1;
        }
        `;
        document.head.appendChild(style);
    }
})();

(function injectChatModalAvatarSizeCSS() {
    const styleId = 'chat-modal-avatar-size-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
        .modal-friend-avatar {
            width: 28px !important;
            height: 28px !important;
        }
        .modal-friend {
            gap: 0.5rem;
            padding: 6px 10px;
        }
        `;
        document.head.appendChild(style);
    }
})();

// Poll for unread messages and update sidebar
async function updateSidebarUnreadCounts() {
    const user = getCurrentUser();
    if (!user) return;
    // Get all accepted friends
    const { data, error } = await supabase
        .from('user_friends')
        .select('user_id, friend_id, status')
        .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`)
        .eq('status', 'accepted');
    if (error) return;
    const friendIds = data
        .map(row => row.user_id === user.id ? row.friend_id : row.user_id)
        .filter(id => id !== user.id);
    if (friendIds.length === 0) return;
    // Get unread messages sent to the user (from any friend)
    const { data: unreadMsgs } = await supabase
        .from('user_messages')
        .select('sender_id, receiver_id, is_read')
        .eq('receiver_id', user.id)
        .eq('is_read', false);
    sidebarUnreadCounts = {};
    friendIds.forEach(fid => { sidebarUnreadCounts[fid] = 0; });
    unreadMsgs?.forEach(msg => {
        if (friendIds.includes(msg.sender_id)) {
            sidebarUnreadCounts[msg.sender_id] = (sidebarUnreadCounts[msg.sender_id] || 0) + 1;
        }
    });
    renderFriendsSidebarList();
}

// Patch: Mark messages as read when opening chat
async function markMessagesRead(friendId) {
    const user = getCurrentUser();
    if (!user) return;
    console.log('Marking messages as read for friend:', friendId);
    await supabase.from('user_messages')
        .update({ is_read: true })
        .eq('sender_id', friendId)
        .eq('receiver_id', user.id)
        .eq('is_read', false);
    // Wait a short time to ensure DB update is reflected
    await new Promise(res => setTimeout(res, 300));
    // Fetch and log all messages from this friend to the user
    const { data: afterUpdate } = await supabase
        .from('user_messages')
        .select('id, sender_id, receiver_id, is_read')
        .eq('sender_id', friendId)
        .eq('receiver_id', user.id);
    console.log('Messages after mark as read:', afterUpdate);
    console.log('Updating sidebar unread counts after marking as read...');
    await updateSidebarUnreadCounts();
    console.log('Sidebar unread counts updated.');
}

// Update openChatModal to mark messages as read
const origOpenChatModalForRead = openChatModal;
openChatModal = async function(friend) {
    await markMessagesRead(friend.id); // Mark as read before rendering chat
    origOpenChatModalForRead(friend);
    subscribeToChatMessages(friend.id);
};

// --- LIVE CHAT MESSAGES WITH SUPABASE REALTIME ---
let chatMessageChannel = null;
async function subscribeToChatMessages(friendId) {
    if (chatMessageChannel) {
        await supabase.removeChannel(chatMessageChannel);
        chatMessageChannel = null;
    }
    const user = getCurrentUser();
    if (!user || !friendId) return;
    chatMessageChannel = supabase.channel('chat-messages-' + friendId)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'user_messages',
        }, payload => {
            if (
                (payload.new.sender_id === user.id && payload.new.receiver_id === friendId) ||
                (payload.new.sender_id === friendId && payload.new.receiver_id === user.id)
            ) {
                loadChatModalMessages(friendId);
            }
        })
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'user_messages',
        }, payload => {
            if (
                (payload.new.sender_id === user.id && payload.new.receiver_id === friendId) ||
                (payload.new.sender_id === friendId && payload.new.receiver_id === user.id)
            ) {
                loadChatModalMessages(friendId);
            }
        });
    await chatMessageChannel.subscribe();
}

// Utility: Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Utility: Format time
function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

(function injectChatModalFullCSS() {
    if (!document.getElementById('chat-modal-full-style')) {
        const style = document.createElement('style');
        style.id = 'chat-modal-full-style';
        style.textContent = `
        .chat-modal-content { display: flex; height: 100%; }
        .chat-modal-friends {
            width: 120px;
            background: #1a1b26;
            border-radius: 14px 0 0 14px;
            padding: 16px 0 16px 0;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
            border-right: 1.5px solid #35355a;
        }
        .modal-friend {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 6px 10px;
            border-radius: 7px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .modal-friend.selected, .modal-friend:hover { background: #2d2e4a; }
        .modal-friend-avatar {
            width: 28px !important;
            height: 28px !important;
            border-radius: 50%;
            object-fit: cover;
            border: 2px solid #a370f7;
        }
        .modal-friend-name {
            font-size: 1.01rem;
            color: #fff;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chat-modal-main {
            flex: 1;
            display: flex;
            flex-direction: column;
            padding: 0 0 0 0.5rem;
            min-width: 0;
            border-radius: 14px
        }
        .chat-modal-header {
            font-weight: bold;
            color: #a370f7;
            padding: 18px 0 10px 0;
            font-size: 1.18rem;
            border-bottom: 1px solid #444;
            margin-bottom: 2px;
            display: flex;
            align-items: center;
            min-height: 40px;
        }
        .chat-modal-messages {
            flex: 1 1 auto;
            overflow-y: auto;
            padding: 12px 0 0 0;
            font-size: 0.97rem;
        }
        .chat-message {
            margin-bottom: 10px;
            display: flex;
            flex-direction: column;
        }
        .chat-message.me { align-items: flex-end; }
        .chat-message .msg-bubble {
            display: inline-block;
            padding: 8px 15px;
            border-radius: 14px;
            background: #a370f7;
            color: #fff;
            max-width: 80%;
            word-break: break-word;
            font-size: 0.98rem;
            line-height: 1.4;
        }
        .chat-message.me .msg-bubble { background: #0db9d7; }
        .chat-message .msg-meta {
            font-size: 0.75em;
            color: #aaa;
            margin-top: 1px;
        }
        .chat-modal-input-form {
            display: flex;
            gap: 0.5rem;
            margin: 12px 0 10px 0;
            align-items: center;
        }
        .chat-modal-input {
            flex: 1;
            border-radius: 7px;
            border: 1px solid #444;
            padding: 8px 12px;
            font-size: 1rem;
            background: #23243a;
            color: #fff;
        }
        .chat-modal-send-btn {
            background: #a370f7;
            color: #fff;
            border: none;
            border-radius: 7px;
            padding: 0 13px;
            font-size: 1.2rem;
            cursor: pointer;
            transition: background 0.2s;
            height: 38px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .chat-modal-send-btn:hover { background: #0db9d7; }
        .chat-modal-messages-empty {
            color: #aaa;
            text-align: center;
            margin-top: 40px;
            font-size: 1.05rem;
        }
        @media (max-width: 700px) {
            .chat-modal { width: 98vw; min-width: 0; }
            .chat-modal-friends { width: 60px; }
            .modal-friend-name { display: none; }
        }
        `;
        document.head.appendChild(style);
    }
})();

(function injectChatModalScrollCSS() {
    if (!document.getElementById('chat-modal-scroll-style')) {
        const style = document.createElement('style');
        style.id = 'chat-modal-scroll-style';
        style.textContent = `
        .chat-modal {
            max-height: 90vh;
            min-height: 420px;
            display: flex;
            flex-direction: column;
        }
        .chat-modal-main {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
            max-height: 70vh;
        }
        .chat-modal-messages {
            flex: 1 1 auto;
            min-height: 0;
            max-height: 55vh;
            overflow-y: auto;
            padding: 12px 0 0 0;
            font-size: 0.97rem;
        }
        .chat-modal-messages::-webkit-scrollbar {
            width: 8px;
            background: transparent;
        }
        .chat-modal-messages::-webkit-scrollbar-thumb {
            background: #35355a;
            border-radius: 6px;
        }
        .chat-modal-messages::-webkit-scrollbar-thumb:hover {
            background: #a370f7;
        }
        `;
        document.head.appendChild(style);
    }
})();

// --- SOUNDBOARD FEATURE ---
// Remove static soundboardSounds array
let soundboardEnabled = true;

// Render the soundboard list, including upload UI and all uploaded sounds
function renderSoundboardList() {
    const list = document.getElementById('soundboardList');
    list.innerHTML = '';

    // Upload form
    const uploadForm = document.createElement('form');
    uploadForm.innerHTML = `
        <input type="file" id="soundboardUploadInput" accept="audio/*" style="display:none;">
        <button type="button" id="soundboardUploadBtn" class="soundboard-upload-btn">
            <i class="fas fa-upload"></i> Upload Sound
        </button>
    `;
    list.appendChild(uploadForm);

    // Inline label input UI (hidden by default)
    let labelInputRow = document.createElement('div');
    labelInputRow.id = 'soundboardLabelInputRow';
    labelInputRow.style.display = 'none';
    labelInputRow.innerHTML = `
        <input type="text" id="soundboardLabelInput" class="soundboard-label-input" placeholder="Enter label for sound..." maxlength="40" />
        <button type="button" id="soundboardLabelConfirm" class="soundboard-label-confirm">Add</button>
        <button type="button" id="soundboardLabelCancel" class="soundboard-label-cancel">Cancel</button>
    `;
    list.appendChild(labelInputRow);
    let pendingFile = null;

    // Cloudinary config
    const cloudName = "dnfq5swp9";
    const uploadPreset = "SKYNET_audio_upload";

    document.getElementById('soundboardUploadBtn').onclick = () => {
        document.getElementById('soundboardUploadInput').click();
    };
    document.getElementById('soundboardUploadInput').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        pendingFile = file;
        labelInputRow.style.display = 'flex';
        const labelInput = document.getElementById('soundboardLabelInput');
        if (labelInput) {
            labelInput.value = file.name.replace(/\.[^/.]+$/, '');
            labelInput.focus();
        }
    };
    document.getElementById('soundboardLabelConfirm').onclick = async () => {
        const labelInput = document.getElementById('soundboardLabelInput');
        const label = labelInput ? labelInput.value.trim() : '';
        if (!label || !pendingFile) return;
        // Upload to Cloudinary
        const user = getCurrentUser();
        const formData = new FormData();
        formData.append('file', pendingFile);
        formData.append('upload_preset', uploadPreset);
        formData.append('folder', user.id + '/soundboard');
        try {
            const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (!data.secure_url) {
                alert('Cloudinary upload failed: ' + (data.error?.message || 'Unknown error. Make sure the unsigned preset "' + uploadPreset + '" exists in your Cloudinary dashboard.'));
                labelInputRow.style.display = 'none';
                pendingFile = null;
                return;
            }
            const fileUrl = data.secure_url;
            // Insert into DB
            await supabase.from('soundboard_sounds').insert([
                { user_id: user.id, file_url: fileUrl, label }
            ]);
            labelInputRow.style.display = 'none';
            pendingFile = null;
            loadSoundboardSoundsListOnly();
        } catch (err) {
            alert('Cloudinary upload error: ' + err.message);
            labelInputRow.style.display = 'none';
            pendingFile = null;
        }
    };
    document.getElementById('soundboardLabelCancel').onclick = () => {
        labelInputRow.style.display = 'none';
        pendingFile = null;
    };

    // List sounds (only update the list, not the upload form or label input row)
    loadSoundboardSoundsListOnly();
}

// Only update the list of sounds, not the upload form or label input row
async function loadSoundboardSoundsListOnly() {
    const list = document.getElementById('soundboardList');
    // Remove everything except the first two children (uploadForm and labelInputRow)
    while (list.children.length > 2) list.removeChild(list.lastChild);
    // Fetch from DB
    const { data: sounds, error } = await supabase
        .from('soundboard_sounds')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) return;
    sounds.forEach(sound => {
        const btn = document.createElement('button');
        btn.className = 'soundboard-sound-btn';
        btn.innerHTML = `<i class='fas fa-play'></i> ${sound.label || 'Sound'}`;
        btn.onclick = () => playSoundboardSound(sound.file_url);
        list.appendChild(btn);
    });
}

// Add minimal CSS for inline label input
(function injectSoundboardLabelInputCSS() {
    if (!document.getElementById('soundboard-label-input-style')) {
        const style = document.createElement('style');
        style.id = 'soundboard-label-input-style';
        style.textContent = `
        #soundboardLabelInputRow {
            display: flex;
            gap: 8px;
            margin-bottom: 10px;
            align-items: center;
            background: #23243a;
            padding: 8px 10px;
            border-radius: 8px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.08);
        }
        .soundboard-label-input {
            flex: 1;
            border-radius: 6px;
            border: 1px solid #444;
            padding: 7px 12px;
            font-size: 1rem;
            background: #181926;
            color: #fff;
        }
        .soundboard-label-confirm, .soundboard-label-cancel {
            background: #a370f7;
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 7px 14px;
            font-size: 1rem;
            cursor: pointer;
            transition: background 0.2s;
        }
        .soundboard-label-cancel {
            background: #e74c3c;
        }
        .soundboard-label-confirm:hover { background: #0db9d7; }
        .soundboard-label-cancel:hover { background: #c0392b; }
        `;
        document.head.appendChild(style);
    }
})();

function openSoundboardModal() {
    const overlay = document.getElementById('soundboardModalOverlay');
    overlay.style.display = 'flex';
    setTimeout(() => overlay.classList.add('active'), 10);
    renderSoundboardList();
    document.getElementById('soundboardToggle').checked = soundboardEnabled;
}
function closeSoundboardModal() {
    const overlay = document.getElementById('soundboardModalOverlay');
    overlay.classList.remove('active');
    setTimeout(() => { overlay.style.display = 'none'; }, 320);
}

// Inject modern, animated CSS for the soundboard modal and its elements
(function injectSoundboardModalCSS() {
    if (!document.getElementById('soundboard-modal-style')) {
        const style = document.createElement('style');
        style.id = 'soundboard-modal-style';
        style.textContent = `
        .soundboard-modal-overlay {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(30,32,44,0.85);
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(2.5px);
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.32s cubic-bezier(0.23, 1, 0.32, 1);
        }
        .soundboard-modal-overlay.active {
            opacity: 1;
            pointer-events: auto;
        }
        .soundboard-modal {
            background: #23243a;
            border-radius: 18px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 1.5px 8px rgba(163,112,247,0.08);
            min-width: 320px;
            max-width: 96vw;
            width: 400px;
            min-height: 220px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            position: relative;
            overflow: hidden;
            transform: scale(0.92) translateY(32px);
            opacity: 0;
            transition: transform 0.32s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.32s cubic-bezier(0.23, 1, 0.32, 1);
        }
        .soundboard-modal-overlay.active .soundboard-modal {
            transform: scale(1) translateY(0);
            opacity: 1;
        }
        .close-soundboard-modal {
            position: absolute;
            top: 14px;
            right: 18px;
            background: none;
            border: none;
            color: #fff;
            font-size: 2.1rem;
            cursor: pointer;
            z-index: 2;
            transition: color 0.18s;
        }
        .close-soundboard-modal:hover {
            color: #a370f7;
        }
        .soundboard-header {
            font-weight: bold;
            color: #a370f7;
            padding: 18px 0 10px 24px;
            font-size: 1.18rem;
            border-bottom: 1px solid #444;
            margin-bottom: 2px;
            display: flex;
            align-items: center;
            min-height: 40px;
            gap: 1.2rem;
        }
        .soundboard-toggle {
            margin-left: auto;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 1rem;
        }
        .soundboard-list {
            flex: 1 1 auto;
            overflow-y: auto;
            padding: 18px 18px 18px 18px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .soundboard-sound-btn {
            background: #a370f7;
            color: #fff;
            border: none;
            border-radius: 7px;
            padding: 8px 16px;
            font-size: 1.05rem;
            cursor: pointer;
            transition: background 0.2s;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.08);
        }
        .soundboard-sound-btn:hover {
            background: #0db9d7;
        }
        .soundboard-upload-btn {
            margin-bottom: 10px;
            padding: 6px 14px;
            border-radius: 6px;
            background: #0db9d7;
            color: #fff;
            border: none;
            cursor: pointer;
            font-size: 0.95rem;
            transition: background 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .soundboard-upload-btn:hover {
            background: #a370f7;
        }
        @media (max-width: 600px) {
            .soundboard-modal { width: 98vw; min-width: 0; }
        }
        `;
        document.head.appendChild(style);
    }
})();

// Fetch and render all uploaded sounds
async function loadSoundboardSounds() {
    const list = document.getElementById('soundboardList');
    // Remove upload form (keep it at the top)
    const uploadForm = list.firstChild;
    list.innerHTML = '';
    if (uploadForm) list.appendChild(uploadForm);

    // Fetch from DB
    const { data: sounds, error } = await supabase
        .from('soundboard_sounds')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) return;

    sounds.forEach(sound => {
        const btn = document.createElement('button');
        btn.className = 'soundboard-sound-btn';
        btn.innerHTML = `<i class='fas fa-play'></i> ${sound.label || 'Sound'}`;
        btn.onclick = () => playSoundboardSound(sound.file_url);
        list.appendChild(btn);
    });
}

// --- LIVE UPDATE USER CARDS ON FRIENDSHIP CHANGES ---
let userFriendsRealtimeChannel = null;
async function subscribeUserFriendsRealtime() {
    if (userFriendsRealtimeChannel) {
        await supabase.removeChannel(userFriendsRealtimeChannel);
        userFriendsRealtimeChannel = null;
    }
    userFriendsRealtimeChannel = supabase.channel('user-friends-userlist')
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'user_friends',
        }, payload => {
            // Refresh user cards (main user list)
            updateUsersList(users);
        });
    await userFriendsRealtimeChannel.subscribe();
}
subscribeUserFriendsRealtime();

function playSoundboardSound(fileUrl) {
    // Play locally
    const audio = new Audio(fileUrl);
    audio.play();

    // Broadcast to all users in the channel
    if (socket && socket.connected) {
        socket.emit('soundboard', { fileUrl });
    }
}

// --- SCREEN SHARE FEATURE ---
let isScreenSharing = false;
let screenShareStream = null;
let screenShareOwnerId = null;
let screenShareVideoEl = null;
let screenShareViewers = new Set();

// Helper: Broadcast screen share state
function broadcastScreenShareState(state) {
    console.log('[ScreenShare] Emitting screenShareState:', { userId: currentUser.id, state });
    if (socket && socket.connected) {
        socket.emit('screenShareState', {
            userId: currentUser.id,
            state: state // 'start' or 'stop'
        });
    }
}

// Helper: Add/Remove green monitor icon on user card
function updateScreenShareIconOnUserCards() {
    console.log('[ScreenShare] updateScreenShareIconOnUserCards, screenShareOwnerId:', screenShareOwnerId);
    document.querySelectorAll('.user-item').forEach(userItem => {
        const userId = userItem.getAttribute('data-user-id');
        let icon = userItem.querySelector('.screen-share-icon');
        if (userId === screenShareOwnerId) {
            if (!icon) {
                icon = document.createElement('span');
                icon.className = 'screen-share-icon';
                icon.title = 'View Screen Share';
                icon.innerHTML = '<i class="fas fa-desktop"></i>';
                icon.style.color = '#2ecc40';
                icon.style.marginLeft = '8px';
                icon.style.cursor = 'pointer';
                icon.onclick = (e) => {
                    e.stopPropagation();
                    if (currentUser.id !== screenShareOwnerId) {
                        showScreenShareView();
                    }
                };
                userItem.querySelector('.user-name').appendChild(icon);
            }
            icon.style.display = 'inline-block';
        } else if (icon) {
            icon.remove();
        }
    });
}

// Helper: Show screen share video in place of user cards
function showScreenShareView() {
    const usersGrid = document.getElementById('usersList');
    usersGrid.classList.add('screenshare-active');
    usersGrid.innerHTML = '';
    // Video element
    if (!screenShareVideoEl) {
        screenShareVideoEl = document.createElement('video');
        screenShareVideoEl.id = 'screenShareVideo';
        screenShareVideoEl.autoplay = true;
        screenShareVideoEl.controls = false;
        screenShareVideoEl.style.maxWidth = '90vw';
        screenShareVideoEl.style.maxHeight = '70vh';
        screenShareVideoEl.style.borderRadius = '16px';
        screenShareVideoEl.style.boxShadow = '0 8px 32px rgba(0,0,0,0.35)';
        screenShareVideoEl.style.background = '#111';
        screenShareVideoEl.style.margin = '0 auto';
    }
    usersGrid.appendChild(screenShareVideoEl);
    // Close button for viewers
    if (currentUser.id !== screenShareOwnerId) {
        let closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close Screen Share';
        closeBtn.className = 'close-screenshare-btn';
        closeBtn.style.margin = '32px auto 0 auto';
        closeBtn.style.display = 'block';
        closeBtn.style.background = '#23243a';
        closeBtn.style.color = '#fff';
        closeBtn.style.border = 'none';
        closeBtn.style.borderRadius = '8px';
        closeBtn.style.padding = '12px 28px';
        closeBtn.style.fontSize = '1.1rem';
        closeBtn.style.cursor = 'pointer';
        closeBtn.onclick = () => {
            hideScreenShareView();
        };
        usersGrid.appendChild(closeBtn);
    } else {
        // Stop sharing button for owner
        let stopBtn = document.createElement('button');
        stopBtn.textContent = 'Stop Screen Share';
        stopBtn.className = 'close-screenshare-btn';
        stopBtn.style.margin = '32px auto 0 auto';
        stopBtn.style.display = 'block';
        stopBtn.style.background = '#e74c3c';
        stopBtn.style.color = '#fff';
        stopBtn.style.border = 'none';
        stopBtn.style.borderRadius = '8px';
        stopBtn.style.padding = '12px 28px';
        stopBtn.style.fontSize = '1.1rem';
        stopBtn.style.cursor = 'pointer';
        stopBtn.onclick = () => {
            stopScreenShare();
        };
        usersGrid.appendChild(stopBtn);
    }
    // Request the screen share stream from the owner
    if (currentUser.id !== screenShareOwnerId) {
        socket.emit('requestScreenShareStream', { ownerId: screenShareOwnerId, viewerId: currentUser.id });
    } else if (screenShareStream) {
        screenShareVideoEl.srcObject = screenShareStream;
    }
}

function hideScreenShareView() {
    const usersGrid = document.getElementById('usersList');
    usersGrid.classList.remove('screenshare-active');
    usersGrid.innerHTML = '';
    updateUsersList(users);
}

// Start screen share
async function startScreenShare() {
    try {
        screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        isScreenSharing = true;
        screenShareOwnerId = currentUser.id;
        broadcastScreenShareState('start');
        updateScreenShareIconOnUserCards();
        showScreenShareView();
        // Send stream to all peers
        Object.keys(peerConnections).forEach(userId => {
            const sender = peerConnections[userId].getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                sender.replaceTrack(screenShareStream.getVideoTracks()[0]);
            } else {
                peerConnections[userId].addTrack(screenShareStream.getVideoTracks()[0], screenShareStream);
            }
        });
        // Listen for stop
        screenShareStream.getVideoTracks()[0].onended = () => {
            stopScreenShare();
        };
    } catch (err) {
        alert('Screen share failed: ' + err.message);
    }
}

// Stop screen share
function stopScreenShare() {
    if (screenShareStream) {
        screenShareStream.getTracks().forEach(track => track.stop());
        screenShareStream = null;
    }
    isScreenSharing = false;
    broadcastScreenShareState('stop');
    screenShareOwnerId = null;
    hideScreenShareView();
    updateScreenShareIconOnUserCards();
    // Remove video tracks from all peer connections
    Object.keys(peerConnections).forEach(userId => {
        const senders = peerConnections[userId].getSenders();
        senders.forEach(sender => {
            if (sender.track && sender.track.kind === 'video') {
                peerConnections[userId].removeTrack(sender);
            }
        });
    });
}

// Listen for screen share state from others
if (typeof socket !== 'undefined' && socket) {
    socket.on('screenShareState', data => {
        if (data.state === 'start') {
            screenShareOwnerId = data.userId;
            updateScreenShareIconOnUserCards();
        } else if (data.state === 'stop') {
            screenShareOwnerId = null;
            hideScreenShareView();
            updateScreenShareIconOnUserCards();
        }
    });
    // Listen for screen share stream requests
    socket.on('requestScreenShareStream', ({ ownerId, viewerId }) => {
        if (currentUser.id === ownerId && screenShareStream) {
            // Send stream to viewer (peer-to-peer logic assumed)
            // In mesh, viewer will renegotiate and get the video track
        }
    });
}

// Patch event listener for screenshareBtn
safeSetOnClick('screenshareBtn', function() {
    if (isScreenSharing) {
        stopScreenShare();
    } else {
        startScreenShare();
    }
});

// Patch updateUsersList to update screen share icons
const origUpdateUsersList = updateUsersList;
updateUsersList = function(usersArr) {
    origUpdateUsersList(usersArr);
    updateScreenShareIconOnUserCards();
    console.log('[ScreenShare] updateUsersList called, ensured icon update');
};

// --- Minimal CSS for screen share icon and close button ---
(function injectScreenShareCSS() {
    if (!document.getElementById('screen-share-style')) {
        const style = document.createElement('style');
        style.id = 'screen-share-style';
        style.textContent = `
        .screen-share-icon {
            display: inline-block;
            margin-left: 8px;
            color: #2ecc40;
            font-size: 1.1em;
            vertical-align: middle;
            cursor: pointer;
            transition: color 0.2s;
        }
        .screen-share-icon:hover {
            color: #27ae60;
        }
        .close-screenshare-btn {
            margin-top: 32px;
            background: #23243a;
            color: #fff;
            border: none;
            border-radius: 8px;
            padding: 12px 28px;
            font-size: 1.1rem;
            cursor: pointer;
            transition: background 0.2s;
        }
        .close-screenshare-btn:hover {
            background: #a370f7;
        }
        `;
        document.head.appendChild(style);
    }
})();

// ================= PRIVATE CHANNELS SECTION =================
// State for private channels
let privateChannels = [];
let selectedPrivateChannel = null;
let privateChannelMembers = [];
let privateChannelMessages = [];
let privateVoiceActive = false;

// DOM Elements for private channels
const privateChannelsSection = document.getElementById('privateChannelsSection');
const privateChannelsSidebar = document.getElementById('privateChannelsSidebar');
const privateChannelsList = document.getElementById('privateChannelsList');
const createPrivateChannelBtn = document.getElementById('createPrivateChannelBtn');
const joinChannelCodeInput = document.getElementById('joinChannelCodeInput');
const joinChannelByCodeBtn = document.getElementById('joinChannelByCodeBtn');
const privateMembersSidebar = document.getElementById('privateMembersSidebar');
const privateMembersList = document.getElementById('privateMembersList');
const privateMainArea = document.getElementById('privateMainArea');
const privateChannelHeader = document.getElementById('privateChannelHeader');
const privateChannelTitle = document.getElementById('privateChannelTitle');
const showChannelCodeBtn = document.getElementById('showChannelCodeBtn');
const privateChannelCode = document.getElementById('privateChannelCode');
const privateChatArea = document.getElementById('privateChatArea');
const privateMessagesList = document.getElementById('privateMessagesList');
const privateMessageInput = document.getElementById('privateMessageInput');
const sendPrivateMessageBtn = document.getElementById('sendPrivateMessageBtn');
const privateVoiceArea = document.getElementById('privateVoiceArea');
const privateVoiceStatus = document.getElementById('privateVoiceStatus');

// --- Modal for creating a private channel ---
function showCreatePrivateChannelModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-card">
            <h3>Create Private Channel</h3>
            <input type="text" id="newPrivateChannelName" class="input-field" placeholder="Channel Name" maxlength="32" autofocus>
            <div class="modal-actions">
                <button id="createChannelConfirmBtn" class="join-btn">Create</button>
                <button id="createChannelCancelBtn" class="join-btn danger">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('newPrivateChannelName').focus();
    document.getElementById('createChannelCancelBtn').onclick = () => modal.remove();
    document.getElementById('createChannelConfirmBtn').onclick = async () => {
        const name = document.getElementById('newPrivateChannelName').value.trim();
        if (!name) {
            document.getElementById('newPrivateChannelName').classList.add('input-error');
            setTimeout(() => document.getElementById('newPrivateChannelName').classList.remove('input-error'), 1000);
            return;
        }
        await createPrivateChannel(name);
        modal.remove();
    };
}

// --- Helper: Show error modal ---
function showPrivateChannelError(msg) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal-card"><div class="modal-error">${msg}</div><button class="join-btn" id="closeErrorModalBtn">Close</button></div>`;
    document.body.appendChild(modal);
    document.getElementById('closeErrorModalBtn').onclick = () => modal.remove();
}

// --- Supabase: Create Private Channel ---
async function createPrivateChannel(name) {
    // Generate a unique 6-character code
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const { data, error } = await supabase.from('private_channels').insert([
        { name, owner_id: currentUser.id, join_code: code }
    ]).select().single();
    if (error) {
        showPrivateChannelError('Failed to create channel: ' + error.message);
        return;
    }
    // Add owner as member
    await supabase.from('private_channel_members').insert([
        { channel_id: data.id, user_id: currentUser.id, is_owner: true }
    ]);
    await fetchPrivateChannels();
    selectPrivateChannel(data.id);
}

// --- Supabase: Join Private Channel by Code ---
async function joinPrivateChannelByCode(code) {
    const { data: channel, error } = await supabase
        .from('private_channels')
        .select('*')
        .eq('join_code', code)
        .single();
    if (error || !channel) {
        showPrivateChannelError('No channel found with that code.');
        return;
    }
    // Check if already a member
    const { data: member } = await supabase
        .from('private_channel_members')
        .select('*')
        .eq('channel_id', channel.id)
        .eq('user_id', currentUser.id)
        .maybeSingle();
    if (!member) {
        await supabase.from('private_channel_members').insert([
            { channel_id: channel.id, user_id: currentUser.id, is_owner: false }
        ]);
    }
    await fetchPrivateChannels();
    selectPrivateChannel(channel.id);
}

// --- Supabase: Fetch Owned/Joined Private Channels ---
async function fetchPrivateChannels() {
    const { data: memberships, error } = await supabase
        .from('private_channel_members')
        .select('channel_id, is_owner, private_channels(*)')
        .eq('user_id', currentUser.id);
    if (error) {
        showPrivateChannelError('Failed to fetch channels: ' + error.message);
        return;
    }
    privateChannels = (memberships || []).map(m => ({ ...m.private_channels, is_owner: m.is_owner }));
    renderPrivateChannelsList();
}

// --- Supabase: Fetch Members for Selected Channel ---
async function fetchPrivateChannelMembers(channelId) {
    const { data: members, error } = await supabase
        .from('private_channel_members')
        .select('user_id, is_owner, users(id, display_name, avatar_url)')
        .eq('channel_id', channelId);
    if (error) {
        showPrivateChannelError('Failed to fetch members: ' + error.message);
        return;
    }
    privateChannelMembers = (members || []).map(m => ({
        id: m.users.id,
        displayName: m.users.display_name,
        avatar_url: m.users.avatar_url,
        is_owner: m.is_owner
    }));
    renderPrivateMembersList();
}

// --- Render: Private Channels List ---
function renderPrivateChannelsList() {
    privateChannelsList.innerHTML = '';
    if (!privateChannels.length) {
        privateChannelsList.innerHTML = '<li style="color:#aaa;text-align:center;">No channels yet.</li>';
        return;
    }
    privateChannels.forEach(channel => {
        const li = document.createElement('li');
        li.textContent = channel.name;
        if (channel.is_owner) {
            li.innerHTML += ' <i class="fas fa-crown" title="Owner" style="color:#feca57;"></i>';
        }
        li.onclick = () => selectPrivateChannel(channel.id);
        if (selectedPrivateChannel && channel.id === selectedPrivateChannel.id) {
            li.classList.add('active');
        }
        privateChannelsList.appendChild(li);
    });
}

// --- Render: Private Channel Members List ---
function renderPrivateMembersList() {
    privateMembersList.innerHTML = '';
    if (!privateChannelMembers.length) {
        privateMembersList.innerHTML = '<li style="color:#aaa;text-align:center;">No members yet.</li>';
        return;
    }
    privateChannelMembers.forEach(member => {
        const li = document.createElement('li');
        li.innerHTML = `<img src="${member.avatar_url || 'assets/images/default-avatar.svg'}" class="user-avatar" style="width:28px;height:28px;border-radius:50%;margin-right:8px;">` +
            `<span>${member.displayName}</span>` +
            (member.is_owner ? ' <i class="fas fa-crown" title="Owner" style="color:#feca57;"></i>' : '');
        privateMembersList.appendChild(li);
    });
}

// --- Select a Private Channel ---
async function selectPrivateChannel(channelId) {
    selectedPrivateChannel = privateChannels.find(c => c.id === channelId);
    if (!selectedPrivateChannel) return;
    privateChannelTitle.textContent = selectedPrivateChannel.name;
    // Show code button if owner
    if (selectedPrivateChannel.is_owner) {
        showChannelCodeBtn.style.display = '';
        showChannelCodeBtn.onclick = () => {
            privateChannelCode.textContent = selectedPrivateChannel.join_code;
            privateChannelCode.style.display = '';
            setTimeout(() => { privateChannelCode.style.display = 'none'; }, 8000);
        };
    } else {
        showChannelCodeBtn.style.display = 'none';
        privateChannelCode.style.display = 'none';
    }
    renderPrivateChannelsList();
    await fetchPrivateChannelMembers(channelId);
    // TODO: Fetch and render chat/messages for this channel
    // TODO: Reset voice chat state for this channel
}

// --- Event: Create Private Channel ---
createPrivateChannelBtn.addEventListener('click', showCreatePrivateChannelModal);

// --- Event: Join Private Channel by Code ---
joinChannelByCodeBtn.addEventListener('click', async () => {
    const code = joinChannelCodeInput.value.trim();
    if (!code) {
        joinChannelCodeInput.classList.add('input-error');
        setTimeout(() => joinChannelCodeInput.classList.remove('input-error'), 1000);
        return;
    }
    await joinPrivateChannelByCode(code);
    joinChannelCodeInput.value = '';
});

// --- Initial fetch of private channels on load ---
document.addEventListener('DOMContentLoaded', fetchPrivateChannels);

// --- Minimal modal CSS for private channel modals ---
(function injectPrivateChannelModalCSS() {
    if (!document.getElementById('private-channel-modal-style')) {
        const style = document.createElement('style');
        style.id = 'private-channel-modal-style';
        style.textContent = `
        .modal-overlay {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(30,32,44,0.85); z-index: 9999;
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(2.5px); transition: opacity 0.32s cubic-bezier(0.23, 1, 0.32, 1);
        }
        .modal-card {
            background: #23243a; border-radius: 18px; box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 1.5px 8px rgba(163,112,247,0.08);
            min-width: 320px; max-width: 96vw; width: 340px; min-height: 120px; display: flex; flex-direction: column; align-items: center; padding: 2rem 1.5rem 1.5rem 1.5rem; position: relative; overflow: hidden;
        }
        .modal-card h3 { color: #a370f7; font-family: 'Orbitron',sans-serif; font-size: 1.3rem; margin-bottom: 1.2rem; }
        .modal-actions { display: flex; gap: 1rem; margin-top: 1.5rem; }
        .modal-error { color: #ff6b6b; margin-bottom: 1.2rem; text-align: center; }
        .modal-card .input-field { width: 100%; margin-bottom: 0.5rem; }
        .join-btn.danger { background: #ff6b6b; }
        `;
        document.head.appendChild(style);
    }
})();

// --- Private Channel Chat State ---
let privateChatRealtimeChannel = null;

// --- Supabase: Fetch Messages for Selected Private Channel ---
async function fetchPrivateChannelMessages(channelId) {
    const { data: messages, error } = await supabase
        .from('private_channel_messages')
        .select('id, user_id, message, created_at, users(display_name, avatar_url)')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true });
    if (error) {
        showPrivateChannelError('Failed to fetch messages: ' + error.message);
        return;
    }
    privateChannelMessages = (messages || []).map(m => ({
        id: m.id,
        user_id: m.user_id,
        message: m.message,
        created_at: m.created_at,
        displayName: m.users?.display_name || 'Unknown',
        avatar_url: m.users?.avatar_url || 'assets/images/default-avatar.svg'
    }));
    renderPrivateMessagesList();
}

// --- Render: Private Channel Messages List ---
function renderPrivateMessagesList() {
    privateMessagesList.innerHTML = '';
    if (!privateChannelMessages.length) {
        privateMessagesList.innerHTML = '<li style="color:#aaa;text-align:center;">No messages yet.</li>';
        return;
    }
    privateChannelMessages.forEach(msg => {
        const li = document.createElement('li');
        li.className = 'private-message' + (msg.user_id === currentUser.id ? ' me' : '');
        li.innerHTML = `
            <div class="private-msg-avatar"><img src="${msg.avatar_url}" alt="" style="width:28px;height:28px;border-radius:50%;"></div>
            <div class="private-msg-content">
                <div class="private-msg-header"><span class="private-msg-user">${msg.displayName}</span><span class="private-msg-time">${formatTime(msg.created_at)}</span></div>
                <div class="private-msg-text">${escapeHtml(msg.message)}</div>
            </div>
        `;
        privateMessagesList.appendChild(li);
    });
    privateMessagesList.scrollTop = privateMessagesList.scrollHeight;
}

// --- Send Message in Private Channel ---
sendPrivateMessageBtn.addEventListener('click', sendPrivateChannelMessage);
privateMessageInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrivateChannelMessage();
    }
});

async function sendPrivateChannelMessage() {
    const msg = privateMessageInput.value.trim();
    if (!msg || !selectedPrivateChannel) return;
    await supabase.from('private_channel_messages').insert([
        {
            channel_id: selectedPrivateChannel.id,
            user_id: currentUser.id,
            message: msg
        }
    ]);
    privateMessageInput.value = '';
}

// --- Subscribe to Private Channel Messages (Realtime) ---
async function subscribeToPrivateChannelMessages(channelId) {
    if (privateChatRealtimeChannel) {
        await supabase.removeChannel(privateChatRealtimeChannel);
        privateChatRealtimeChannel = null;
    }
    privateChatRealtimeChannel = supabase.channel('private-messages-' + channelId)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'private_channel_messages',
            filter: 'channel_id=eq.' + channelId
        }, payload => {
            if (payload.new && payload.new.channel_id === channelId) {
                fetchPrivateChannelMessages(channelId);
            }
        });
    await privateChatRealtimeChannel.subscribe();
}

// --- Patch selectPrivateChannel to fetch messages and subscribe ---
const origSelectPrivateChannel = selectPrivateChannel;
selectPrivateChannel = async function(channelId) {
    await origSelectPrivateChannel(channelId);
    await fetchPrivateChannelMessages(channelId);
    await subscribeToPrivateChannelMessages(channelId);
};

// --- Minimal CSS for private channel chat ---
(function injectPrivateChannelChatCSS() {
    if (!document.getElementById('private-channel-chat-style')) {
        const style = document.createElement('style');
        style.id = 'private-channel-chat-style';
        style.textContent = `
        .private-messages-list { padding: 0.5rem 0; }
        .private-message { display: flex; align-items: flex-start; gap: 0.7rem; margin-bottom: 0.5rem; }
        .private-message.me { flex-direction: row-reverse; }
        .private-msg-avatar img { box-shadow: 0 2px 8px #a370f7aa; }
        .private-msg-content { flex: 1; }
        .private-msg-header { display: flex; align-items: center; gap: 0.7rem; font-size: 0.93rem; color: #a370f7; font-weight: 600; }
        .private-msg-user { font-family: 'Orbitron',sans-serif; }
        .private-msg-time { color: #aaa; font-size: 0.85em; font-weight: 400; }
        .private-msg-text { background: var(--card-bg, #23243a); border-radius: 8px; padding: 0.5rem 1rem; color: var(--text-color, #e0e0e0); margin-top: 2px; font-size: 1.01rem; word-break: break-word; box-shadow: 0 1px 4px #a370f733; }
        .private-message.me .private-msg-content { align-items: flex-end; }
        .private-message.me .private-msg-text { background: var(--primary-color, #a370f7); color: #fff; }
        `;
        document.head.appendChild(style);
    }
})();

// --- Private Channel Voice Chat State ---
let privateVoiceSocket = null;
let privateVoicePeerConnections = {};
let privateVoiceLocalStream = null;
let privateVoiceActiveChannelId = null;
let privateVoiceIsMuted = false;
let privateVoiceIsDeafened = false;

// --- Join Private Channel Voice ---
async function joinPrivateVoice(channelId) {
    if (!selectedPrivateChannel || selectedPrivateChannel.id !== channelId) return;
    privateVoiceStatus.textContent = 'Connecting...';
    // Set button state only if it exists in the DOM
    const joinBtn = document.getElementById('joinPrivateVoiceBtn');
    if (joinBtn) {
        joinBtn.disabled = true;
        joinBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...';
    }
    try {
        // Get audio stream
        privateVoiceLocalStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
        });
        // Connect to Socket.io with unique namespace/room
        privateVoiceSocket = io('https://skynet-mdy7.onrender.com', {
            path: '/socket.io/',
            transports: ['websocket', 'polling'],
            query: { room: 'private-' + channelId },
            forceNew: true,
            withCredentials: true
        });
        privateVoicePeerConnections = {};
        privateVoiceActiveChannelId = channelId;
        privateVoiceIsMuted = false;
        privateVoiceIsDeafened = false;
        // Setup socket events (similar to main channel)
        setupPrivateVoiceSocketEvents();
        privateVoiceStatus.textContent = 'Connected';
        if (joinBtn) {
            joinBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i> Leave Voice';
            joinBtn.disabled = false;
        }
    } catch (err) {
        privateVoiceStatus.textContent = 'Error: ' + err.message;
        if (joinBtn) {
            joinBtn.innerHTML = '<i class="fas fa-microphone"></i> Join Voice';
            joinBtn.disabled = false;
        }
    }
}

async function leavePrivateVoice() {
    privateVoiceStatus.textContent = 'Disconnected';
    const joinBtn = document.getElementById('joinPrivateVoiceBtn');
    if (joinBtn) {
        joinBtn.innerHTML = '<i class="fas fa-microphone"></i> Join Voice';
        joinBtn.disabled = false;
    }
    privateVoiceActiveChannelId = null;
    // Close all peer connections
    Object.values(privateVoicePeerConnections).forEach(pc => pc.close && pc.close());
    privateVoicePeerConnections = {};
    // Remove all audio elements
    document.querySelectorAll('.private-voice-audio').forEach(el => el.remove());
    // Stop local stream
    if (privateVoiceLocalStream) {
        privateVoiceLocalStream.getTracks().forEach(track => track.stop());
        privateVoiceLocalStream = null;
    }
    // Disconnect socket
    if (privateVoiceSocket) {
        privateVoiceSocket.disconnect();
        privateVoiceSocket = null;
    }
}

function setupPrivateVoiceSocketEvents() {
    if (!privateVoiceSocket) return;
    // On connect, join room
    privateVoiceSocket.on('connect', () => {
        privateVoiceSocket.emit('joinPrivateVoice', {
            channelId: selectedPrivateChannel.id,
            userId: currentUser.id,
            displayName: currentUser.displayName,
            avatar_url: currentUser.avatar_url || ''
        });
    });
    // Handle user join/leave, offer/answer, ICE, etc. (similar to main channel)
    privateVoiceSocket.on('usersList', async (usersList) => {
        // Remove self
        const others = usersList.filter(u => u.id !== currentUser.id);
        for (const user of others) {
            if (!privateVoicePeerConnections[user.id]) {
                await createPrivateVoicePeerConnection(user.id, true);
            }
        }
    });
    privateVoiceSocket.on('userJoined', async (userData) => {
        if (userData.id !== currentUser.id && !privateVoicePeerConnections[userData.id]) {
            await createPrivateVoicePeerConnection(userData.id, true);
        }
    });
    privateVoiceSocket.on('userLeft', (userId) => {
        if (privateVoicePeerConnections[userId]) {
            privateVoicePeerConnections[userId].close();
            delete privateVoicePeerConnections[userId];
        }
        const audioEl = document.getElementById('private-voice-audio-' + userId);
        if (audioEl) audioEl.remove();
    });
    privateVoiceSocket.on('offer', async (data) => {
        let pc = privateVoicePeerConnections[data.senderId];
        if (!pc) pc = await createPrivateVoicePeerConnection(data.senderId, false);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        privateVoiceSocket.emit('answer', { targetUserId: data.senderId, answer });
    });
    privateVoiceSocket.on('answer', async (data) => {
        const pc = privateVoicePeerConnections[data.senderId];
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    });
    privateVoiceSocket.on('ice-candidate', async (data) => {
        const pc = privateVoicePeerConnections[data.senderId];
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    });
    // Mute/deafen events (optional, can be extended)
}

async function createPrivateVoicePeerConnection(userId, isInitiator) {
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls: 'turn:relay1.expressturn.com:3480',
                username: '000000002064061488',
                credential: 'Y4KkTGe7+4T5LeMWjkXn5T5Zv54='
            }
        ]
    });
    privateVoicePeerConnections[userId] = pc;
    // Add local audio
    if (privateVoiceLocalStream) {
        privateVoiceLocalStream.getAudioTracks().forEach(track => pc.addTrack(track, privateVoiceLocalStream));
    }
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            privateVoiceSocket.emit('ice-candidate', { targetUserId: userId, candidate: event.candidate });
        }
    };
    pc.ontrack = (event) => {
        let audioEl = document.getElementById('private-voice-audio-' + userId);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = 'private-voice-audio-' + userId;
            audioEl.className = 'private-voice-audio';
            audioEl.autoplay = true;
            audioEl.controls = false;
            privateVoiceArea.appendChild(audioEl);
        }
        audioEl.srcObject = event.streams[0];
    };
    if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        privateVoiceSocket.emit('offer', { targetUserId: userId, offer });
    }
    return pc;
}

// --- Reset private voice state on channel switch or leave ---
const origSelectPrivateChannelForVoice = selectPrivateChannel;
selectPrivateChannel = async function(channelId) {
    await leavePrivateVoice();
    await origSelectPrivateChannelForVoice(channelId);
};

// --- Minimal CSS for private voice audio elements ---
(function injectPrivateVoiceCSS() {
    if (!document.getElementById('private-voice-style')) {
        const style = document.createElement('style');
        style.id = 'private-voice-style';
        style.textContent = `
        .private-voice-audio { display: none; }
        .private-voice-status { color: #0db9d7; font-size: 1rem; margin-left: 1rem; }
        `;
        document.head.appendChild(style);
    }
})();

// --- Private Channel Voice Controls and User List ---
function renderPrivateVoiceControls() {
    privateVoiceArea.innerHTML = `
        <div class="private-voice-controls">
            <button id="privateMuteBtn" class="control-btn"><i class="fas fa-microphone"></i> <span>Mute</span></button>
            <button id="privateDeafenBtn" class="control-btn"><i class="fas fa-volume-mute"></i> <span>Deafen</span></button>
            <button id="leavePrivateVoiceBtn" class="control-btn danger"><i class="fas fa-sign-out-alt"></i> <span>Leave</span></button>
            <span class="private-voice-status" id="privateVoiceStatus"></span>
        </div>
        <div class="private-voice-users-list" id="privateVoiceUsersList"></div>
    `;
}

function renderPrivateVoiceUsersList(users) {
    const list = document.getElementById('privateVoiceUsersList');
    if (!list) return;
    list.innerHTML = '';
    users.forEach(user => {
        const div = document.createElement('div');
        div.className = 'private-voice-user-item';
        div.setAttribute('data-user-id', user.id);
        div.innerHTML = `
            <img src="${user.avatar_url || 'assets/images/default-avatar.svg'}" class="user-avatar" style="width:28px;height:28px;border-radius:50%;margin-right:8px;">
            <span class="user-name">${user.displayName}</span>
            <span class="user-status-indicator"></span>
            <span class="user-status"></span>
        `;
        list.appendChild(div);
    });
}

// --- Private Voice Mute/Deafen State ---
let privateVoiceMuted = false;
let privateVoiceDeafened = false;

function updatePrivateVoiceMuteUI() {
    const btn = document.getElementById('privateMuteBtn');
    if (!btn) return;
    btn.querySelector('i').className = privateVoiceMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
    btn.querySelector('span').textContent = privateVoiceMuted ? 'Unmute' : 'Mute';
}
function updatePrivateVoiceDeafenUI() {
    const btn = document.getElementById('privateDeafenBtn');
    if (!btn) return;
    btn.querySelector('i').className = privateVoiceDeafened ? 'fas fa-volume-up' : 'fas fa-volume-mute';
    btn.querySelector('span').textContent = privateVoiceDeafened ? 'Undeafen' : 'Deafen';
}

// --- Private Voice Activity Detection ---
let privateVoiceAnalyser = null;
let privateVoiceAudioContext = null;
function startPrivateVoiceActivityDetection() {
    if (!privateVoiceLocalStream) return;
    privateVoiceAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    privateVoiceAnalyser = privateVoiceAudioContext.createAnalyser();
    privateVoiceAnalyser.fftSize = 256;
    privateVoiceAnalyser.smoothingTimeConstant = 0.8;
    const source = privateVoiceAudioContext.createMediaStreamSource(privateVoiceLocalStream);
    source.connect(privateVoiceAnalyser);
    const dataArray = new Uint8Array(privateVoiceAnalyser.frequencyBinCount);
    let lastSpeaking = false;
    function checkSpeaking() {
        if (!privateVoiceAnalyser || !privateVoiceAudioContext) return;
        privateVoiceAnalyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
        const speaking = avg > -50;
        if (speaking !== lastSpeaking && privateVoiceSocket && privateVoiceSocket.connected) {
            privateVoiceSocket.emit(speaking ? 'userSpeaking' : 'userStoppedSpeaking', {
                userId: currentUser.id,
                displayName: currentUser.displayName
            });
            lastSpeaking = speaking;
        }
        requestAnimationFrame(checkSpeaking);
    }
    checkSpeaking();
}

// --- Patch joinPrivateVoice to render controls and user list ---
const origJoinPrivateVoice = joinPrivateVoice;
joinPrivateVoice = async function(channelId) {
    await origJoinPrivateVoice(channelId);
    renderPrivateVoiceControls();
    updatePrivateVoiceMuteUI();
    updatePrivateVoiceDeafenUI();
    // Render user list (members)
    renderPrivateVoiceUsersList(privateChannelMembers);
    // Add event listeners
    document.getElementById('privateMuteBtn').onclick = () => {
        privateVoiceMuted = !privateVoiceMuted;
        if (privateVoiceLocalStream) {
            privateVoiceLocalStream.getAudioTracks().forEach(track => {
                track.enabled = !privateVoiceMuted;
            });
        }
        updatePrivateVoiceMuteUI();
        if (privateVoiceSocket && privateVoiceSocket.connected) {
            privateVoiceSocket.emit('userMuteStatus', {
                userId: currentUser.id,
                isMuted: privateVoiceMuted,
                displayName: currentUser.displayName
            });
        }
        updatePrivateVoiceUserStatus(currentUser.id, privateVoiceMuted, privateVoiceDeafened);
    };
    document.getElementById('privateDeafenBtn').onclick = () => {
        privateVoiceDeafened = !privateVoiceDeafened;
        document.querySelectorAll('.private-voice-audio').forEach(audio => {
            audio.muted = privateVoiceDeafened;
        });
        updatePrivateVoiceDeafenUI();
        if (privateVoiceSocket && privateVoiceSocket.connected) {
            privateVoiceSocket.emit('userDeafenStatus', {
                userId: currentUser.id,
                isDeafened: privateVoiceDeafened,
                displayName: currentUser.displayName
            });
        }
        updatePrivateVoiceUserStatus(currentUser.id, privateVoiceMuted, privateVoiceDeafened);
    };
    document.getElementById('leavePrivateVoiceBtn').onclick = leavePrivateVoice;
    startPrivateVoiceActivityDetection();
};

// --- Patch leavePrivateVoice to clear UI ---
const origLeavePrivateVoice = leavePrivateVoice;
leavePrivateVoice = async function() {
    await origLeavePrivateVoice();
    privateVoiceArea.innerHTML = `<button id="joinPrivateVoiceBtn" class="voice-btn"><i class="fas fa-microphone"></i> Join Voice</button><span class="private-voice-status" id="privateVoiceStatus"></span>`;
    document.getElementById('joinPrivateVoiceBtn').onclick = () => joinPrivateVoice(selectedPrivateChannel.id);
};

// --- Patch setupPrivateVoiceSocketEvents to handle mute/deafen/speaking ---
const origSetupPrivateVoiceSocketEvents = setupPrivateVoiceSocketEvents;
setupPrivateVoiceSocketEvents = function() {
    origSetupPrivateVoiceSocketEvents();
    if (!privateVoiceSocket) return;
    privateVoiceSocket.on('userMuteStatus', (data) => {
        updatePrivateVoiceUserStatus(data.userId, data.isMuted, undefined);
    });
    privateVoiceSocket.on('userDeafenStatus', (data) => {
        updatePrivateVoiceUserStatus(data.userId, undefined, data.isDeafened);
    });
    privateVoiceSocket.on('userSpeaking', (data) => {
        setPrivateVoiceUserSpeaking(data.userId, true);
    });
    privateVoiceSocket.on('userStoppedSpeaking', (data) => {
        setPrivateVoiceUserSpeaking(data.userId, false);
    });
};

function updatePrivateVoiceUserStatus(userId, isMuted, isDeafened) {
    const userItem = document.querySelector(`.private-voice-user-item[data-user-id="${userId}"]`);
    if (!userItem) return;
    if (isMuted !== undefined) {
        userItem.setAttribute('data-muted', isMuted);
        const status = userItem.querySelector('.user-status');
        if (status) status.textContent = isMuted ? 'Muted' : '';
    }
    if (isDeafened !== undefined) {
        userItem.setAttribute('data-deafened', isDeafened);
        const status = userItem.querySelector('.user-status');
        if (status) status.textContent = isDeafened ? 'Deafened' : '';
    }
}
function setPrivateVoiceUserSpeaking(userId, speaking) {
    const userItem = document.querySelector(`.private-voice-user-item[data-user-id="${userId}"]`);
    if (!userItem) return;
    const indicator = userItem.querySelector('.user-status-indicator');
    if (indicator) {
        indicator.className = 'user-status-indicator' + (speaking ? ' speaking' : '');
    }
}
// --- Minimal CSS for private voice controls and user list ---
(function injectPrivateVoiceControlsCSS() {
    if (!document.getElementById('private-voice-controls-style')) {
        const style = document.createElement('style');
        style.id = 'private-voice-controls-style';
        style.textContent = `
        .private-voice-controls { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; }
        .private-voice-users-list { display: flex; flex-direction: column; gap: 0.5rem; }
        .private-voice-user-item { display: flex; align-items: center; gap: 0.7rem; padding: 6px 10px; border-radius: 7px; background: #23243a; }
        .private-voice-user-item .user-avatar { width: 28px; height: 28px; border-radius: 50%; }
        .private-voice-user-item .user-name { font-size: 1rem; color: #fff; font-weight: 500; }
        .private-voice-user-item .user-status-indicator { width: 12px; height: 12px; border-radius: 50%; background: #4CAF50; margin-left: 6px; transition: background 0.2s; }
        .private-voice-user-item[data-muted="true"] .user-status-indicator { background: #f44336; }
        .private-voice-user-item[data-deafened="true"] .user-status-indicator { background: #9c27b0; }
        .private-voice-user-item .user-status-indicator.speaking { background: #0db9d7; box-shadow: 0 0 10px #0db9d7aa; animation: pulse 1.5s infinite; }
        .private-voice-user-item .user-status { font-size: 0.85rem; color: #aaa; margin-left: 8px; }
        @keyframes pulse { 0% { transform: scale(1); box-shadow: 0 0 0 0 #0db9d7bb; } 70% { transform: scale(1.2); box-shadow: 0 0 0 15px #0db9d700; } 100% { transform: scale(1); box-shadow: 0 0 0 0 #0db9d700; } }
        `;
        document.head.appendChild(style);
    }
})();

// ================= UNIFIED VOICE CHAT ENVIRONMENT =================
// Remove all privateVoice* state, socket, and UI logic.
// When joining a channel (DUNE PC or private), use the main channelSection and its logic.
// Scope signaling/room to either 'dunepc' or 'private-<channel_id>' as needed.

// --- Helper: Join Voice Channel (DUNE PC or Private) ---
async function joinVoiceChannel(channelType, channelId = null) {
    // channelType: 'dunepc' or 'private'
    // channelId: private channel id if channelType is 'private'
    let roomName = 'dunepc';
    if (channelType === 'private' && channelId) {
        roomName = 'private-' + channelId;
    }
    // Disconnect from any existing socket
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    // Reset peer connections and UI
    Object.keys(peerConnections).forEach(userId => closePeerConnection(userId));
    peerConnections = {};
    users = [];
    updateUsersList(users);
    // Get audio stream
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
    });
    // Connect to Socket.io with room
    socket = io('https://skynet-mdy7.onrender.com', {
        path: '/socket.io/',
        transports: ['websocket', 'polling'],
        query: { room: roomName },
        forceNew: true,
        withCredentials: true
    });
    // Reuse all main channelSection logic and event handlers
    initializeSocket();
    // Show main channelSection, hide others
    welcomeSection.classList.add('hidden');
    channelSection.classList.remove('hidden');
    channelSection.classList.add('visible');
    // Update UI title
    const channelInfo = channelSection.querySelector('.channel-info h2');
    if (channelType === 'private' && channelId) {
        const privateChan = privateChannels.find(c => c.id === channelId);
        channelInfo.textContent = privateChan ? privateChan.name : 'Private Channel';
    } else {
        channelInfo.textContent = 'DUNE PC';
    }
}

// --- Patch: When user selects a private channel and clicks Join Voice, call joinVoiceChannel('private', channelId) ---
// --- When user clicks Join DUNE PC, call joinVoiceChannel('dunepc') ---
// --- Ensure only one voice chat area is ever visible ---
