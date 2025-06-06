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
let videoBtn;
let videoGrid;

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
let isVideoEnabled = false;
let localVideoTrack = null;

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
    videoBtn = document.getElementById('videoBtn');
    videoGrid = document.getElementById('videoGrid');

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

    videoBtn.addEventListener('click', async () => {
        if (!isVideoEnabled) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                localVideoTrack = stream.getVideoTracks()[0];
                if (localStream) {
                    localStream.addTrack(localVideoTrack);
                } else {
                    localStream = stream;
                }
                isVideoEnabled = true;
                videoBtn.querySelector('i').className = 'fas fa-video-slash';
                videoBtn.querySelector('span').textContent = 'Stop Video';
                updateLocalVideoElement();
                // Add video track to all peer connections
                Object.values(peerConnections).forEach(pc => {
                    pc.addTrack(localVideoTrack, localStream);
                });
                await renegotiateAllPeers();
            } catch (err) {
                console.error('Could not start video:', err);
            }
        } else {
            // Stop video
            if (localVideoTrack) {
                localVideoTrack.stop();
                if (localStream) {
                    localStream.removeTrack(localVideoTrack);
                }
                // Remove video track from all peer connections
                Object.values(peerConnections).forEach(pc => {
                    pc.getSenders().forEach(sender => {
                        if (sender.track && sender.track.kind === 'video') {
                            pc.removeTrack(sender);
                        }
                    });
                });
                localVideoTrack = null;
            }
            isVideoEnabled = false;
            videoBtn.querySelector('i').className = 'fas fa-video';
            videoBtn.querySelector('span').textContent = 'Start Video';
            updateLocalVideoElement();
            await renegotiateAllPeers();
        }
    });
}

// Initialize WebRTC with simplified constraints
async function initializeWebRTC() {
    try {
        console.log('Initializing WebRTC...');
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: isVideoEnabled
        });
        if (isVideoEnabled) {
            localVideoTrack = localStream.getVideoTracks()[0];
        }
        updateLocalVideoElement();
        
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

                // Remove any existing video/audio element for this user
                const existingVideo = document.getElementById(`video-${userId}`);
                if (existingVideo) existingVideo.remove();
                const existingAudio = document.getElementById(`audio-${userId}`);
                if (existingAudio) existingAudio.remove();
                // Add video if present
                if (stream.getVideoTracks().length > 0) {
                    const videoElement = document.createElement('video');
                    videoElement.id = `video-${userId}`;
                    videoElement.srcObject = stream;
                    videoElement.autoplay = true;
                    videoElement.playsInline = true;
                    videoElement.className = 'video-element remote-video';
                    videoGrid.appendChild(videoElement);
                }
                // Add audio if present
                if (stream.getAudioTracks().length > 0) {
                    const audioElement = document.createElement('audio');
                    audioElement.id = `audio-${userId}`;
                    audioElement.srcObject = stream;
                    audioElement.autoplay = true;
                    audioElement.muted = isDeafened;
                    audioElement.volume = 1.0;
                    document.body.appendChild(audioElement);
                }
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
        // Check starred state (for icon)
        let starred = false;
        try {
            const user = getCurrentUser();
            // This is a synchronous check, but we need the value for the icon
            // We'll fetch it below for the menu, but here we use a cache or fallback
            // For now, we will fetch it again below for the menu
        } catch {}
        // We'll fetch the real value for the menu, but for now, we need to fetch it here synchronously
        // So, instead, after the menu is used, we re-render the list, so the icon will update
        // Render avatar, name, and star icon if starred
        div.innerHTML = `
          <img src="${friend.avatar_url || 'assets/images/default-avatar.svg'}" class="sidebar-friend-avatar" style="cursor:pointer;">
          <span class="sidebar-friend-name-wrapper">
            <span class="sidebar-friend-name" style="cursor:pointer;">${friend.display_name}</span>
            <span class="sidebar-friend-star" style="display:none;"><i class="fas fa-star"></i></span>
          </span>
          <button class="sidebar-friend-kebab" title="More options">
            <i class="fas fa-ellipsis-v"></i>
          </button>`;
        // Fetch starred state and show icon if needed
        (async () => {
            try {
                const user = getCurrentUser();
                const { data } = await supabase
                    .from('user_friends')
                    .select('starred')
                    .or(`and(user_id.eq.${user.id},friend_id.eq.${friend.id}),and(user_id.eq.${friend.id},friend_id.eq.${user.id})`)
                    .eq('status', 'accepted')
                    .single();
                if (data && data.starred) {
                    const starEl = div.querySelector('.sidebar-friend-star');
                    if (starEl) {
                        starEl.style.display = 'inline-block';
                    }
                }
            } catch {}
        })();
        if (sidebarUnreadCounts[friend.id] > 0) {
            const badge = document.createElement('span');
            badge.className = 'sidebar-friend-unread';
            badge.textContent = sidebarUnreadCounts[friend.id];
            div.appendChild(badge);
        }
        // Avatar click: open profile modal
        div.querySelector('.sidebar-friend-avatar').onclick = (e) => {
            e.stopPropagation();
            openFriendProfileModal(friend, e.target);
        };
        // Name click: open chat modal
        div.querySelector('.sidebar-friend-name').onclick = (e) => {
            e.stopPropagation();
            openChatModal(friend);
        };
        // Kebab menu logic
        const kebabBtn = div.querySelector('.sidebar-friend-kebab');
        let kebabMenu = null;
        kebabBtn.onclick = async (e) => {
            e.stopPropagation();
            // Close any open menu
            document.querySelectorAll('.sidebar-friend-kebab-menu').forEach(m => m.remove());
            // Fetch friendship date
            let since = '';
            try {
                const user = getCurrentUser();
                const { data } = await supabase
                    .from('user_friends')
                    .select('created_at')
                    .or(`and(user_id.eq.${user.id},friend_id.eq.${friend.id}),and(user_id.eq.${friend.id},friend_id.eq.${user.id})`)
                    .eq('status', 'accepted')
                    .single();
                if (data && data.created_at) {
                    since = new Date(data.created_at).toLocaleDateString();
                }
            } catch {}
            // Check starred state (local fallback)
            let starred = false;
            try {
                const user = getCurrentUser();
                const { data } = await supabase
                    .from('user_friends')
                    .select('starred')
                    .or(`and(user_id.eq.${user.id},friend_id.eq.${friend.id}),and(user_id.eq.${friend.id},friend_id.eq.${user.id})`)
                    .eq('status', 'accepted')
                    .single();
                starred = data && data.starred;
            } catch {}
            kebabMenu = document.createElement('div');
            kebabMenu.className = 'sidebar-friend-kebab-menu';
            kebabMenu.innerHTML = `
              <div class="kebab-menu-option" data-action="since"><i class="fas fa-calendar-alt"></i> Friends Since <span style="float:right;color:#a370f7;font-weight:600;">${since || '?'}</span></div>
              <div class="kebab-menu-option" data-action="star"><i class="fas fa-star${starred ? '' : '-o'}"></i> ${starred ? 'Unstar' : 'Add Star'}</div>
              <div class="kebab-menu-option" data-action="unfriend"><i class="fas fa-user-slash"></i> Unfriend</div>
            `;
            // Position menu
            const rect = kebabBtn.getBoundingClientRect();
            const menuWidth = 200;
            const menuHeight = 140;
            let left = rect.right - 10;
            let top = rect.top + 8;
            // If menu would overflow right, open to the left
            if (left + menuWidth > window.innerWidth - 8) {
                left = rect.left - menuWidth - 8;
            }
            // If menu would overflow left, clamp to 8px
            if (left < 8) left = 8;
            // If menu would overflow bottom, move up
            if (top + menuHeight > window.innerHeight - 8) {
                top = window.innerHeight - menuHeight - 8;
            }
            if (top < 8) top = 8;
            kebabMenu.style.position = 'fixed';
            kebabMenu.style.left = left + 'px';
            kebabMenu.style.top = top + 'px';
            document.body.appendChild(kebabMenu);
            // Click outside closes
            setTimeout(() => {
                function outside(e2) {
                    if (!kebabMenu.contains(e2.target) && e2.target !== kebabBtn) {
                        kebabMenu.remove();
                        document.removeEventListener('mousedown', outside);
                    }
                }
                document.addEventListener('mousedown', outside);
            }, 30);
            // Option actions
            kebabMenu.querySelectorAll('.kebab-menu-option').forEach(opt => {
                opt.onclick = async (ev) => {
                    const action = opt.dataset.action;
                    if (action === 'since') {
                        // Just close menu (date is shown)
                        kebabMenu.remove();
                    } else if (action === 'unfriend') {
                        if (confirm('Unfriend this user?')) {
                            const user = getCurrentUser();
                            await supabase.from('user_friends')
                                .delete()
                                .or(`and(user_id.eq.${user.id},friend_id.eq.${friend.id}),and(user_id.eq.${friend.id},friend_id.eq.${user.id})`);
                            kebabMenu.remove();
                            renderFriendsSidebarList();
                        }
                    } else if (action === 'star') {
                        const user = getCurrentUser();
                        await supabase.from('user_friends')
                            .update({ starred: !starred })
                            .or(`and(user_id.eq.${user.id},friend_id.eq.${friend.id}),and(user_id.eq.${friend.id},friend_id.eq.${user.id})`);
                        kebabMenu.remove();
                        renderFriendsSidebarList();
                    }
                };
            });
        };
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

// --- FRIEND PROFILE MODAL ---
(function injectFriendProfileModalCSS() {
    if (!document.getElementById('friend-profile-modal-style')) {
        const style = document.createElement('style');
        style.id = 'friend-profile-modal-style';
        style.textContent = `
        .friend-profile-modal {
            position: fixed;
            z-index: 99999;
            min-width: 340px;
            max-width: 96vw;
            min-height: 260px;
            max-height: 90vh;
            background: rgba(40,30,60,0.98);
            border-radius: 18px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 1.5px 8px rgba(163,112,247,0.08);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            opacity: 0;
            transform: scale(0.7);
            pointer-events: none;
            transition: opacity 0.32s cubic-bezier(0.23, 1, 0.32, 1), transform 0.32s cubic-bezier(0.23, 1, 0.32, 1);
        }
        .friend-profile-modal.active {
            opacity: 1;
            transform: scale(1);
            pointer-events: auto;
        }
        .friend-profile-banner {
            width: 100%;
            height: 110px;
            object-fit: cover;
            background: #23243a;
            border-radius: 18px 18px 0 0;
        }
        .friend-profile-header {
            display: flex;
            align-items: center;
            gap: 1.2rem;
            margin-top: -48px;
            padding: 0 2rem 0.5rem 2rem;
        }
        .friend-profile-avatar {
            width: 96px;
            height: 96px;
            border-radius: 50%;
            object-fit: cover;
            border: 4px solid #a370f7;
            background: #23243a;
            box-shadow: 0 2px 12px rgba(163,112,247,0.12);
        }
        .friend-profile-info {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 0.2rem;
        }
        .friend-profile-name {
            color: #fff;
            font-size: 1.45rem;
            font-weight: 600;
            margin-bottom: 0.2rem;
        }
        .friend-profile-bio {
            color: #bdb6d6;
            font-size: 1.01rem;
            margin-top: 0.2rem;
            max-width: 340px;
            word-break: break-word;
        }
        .close-friend-profile-modal {
            position: absolute;
            top: 12px;
            right: 18px;
            background: none;
            border: none;
            color: #fff;
            font-size: 2.1rem;
            cursor: pointer;
            z-index: 2;
            transition: color 0.18s;
        }
        .close-friend-profile-modal:hover {
            color: #a370f7;
        }
        @media (max-width: 600px) {
            .friend-profile-modal { min-width: 90vw; }
            .friend-profile-header { flex-direction: column; align-items: flex-start; padding: 0 1rem; }
            .friend-profile-info { max-width: 90vw; }
        }
        `;
        document.head.appendChild(style);
    }
})();

// Modal root
if (!document.getElementById('friendProfileModalRoot')) {
    const root = document.createElement('div');
    root.id = 'friendProfileModalRoot';
    document.body.appendChild(root);
}

// Open friend profile modal
async function openFriendProfileModal(friend, avatarEl) {
    // Remove any existing modal
    const root = document.getElementById('friendProfileModalRoot');
    root.innerHTML = '';
    // Fetch extra info (bio, banner)
    let userData = friend;
    try {
        const { data } = await supabase
            .from('users')
            .select('id, display_name, avatar_url, banner_url, bio')
            .eq('id', friend.id)
            .single();
        if (data) userData = data;
    } catch {}
    // Modal element
    const modal = document.createElement('div');
    modal.className = 'friend-profile-modal';
    // Position modal to the left of the avatar
    const rect = avatarEl.getBoundingClientRect();
    const modalWidth = 360; // Approximate modal width
    let left = rect.left - modalWidth;
    // If not enough space on the left, fallback to right
    if (left < 8) left = rect.right + 8;
    let top = rect.top + rect.height/2;
    // Prevent overflow at bottom
    if (top + 320 > window.innerHeight) top = window.innerHeight - 340;
    if (top < 8) top = 8;
    modal.style.position = 'fixed';
    modal.style.left = left + 'px';
    modal.style.top = top + 'px';
    modal.style.transformOrigin = left < rect.left ? 'top right' : 'top left';
    // Modal content
    modal.innerHTML = `
      <button class="close-friend-profile-modal" title="Close">&times;</button>
      <img class="friend-profile-banner" src="${userData.banner_url || 'assets/images/default-banner.jpg'}" alt="Banner">
      <div class="friend-profile-header">
        <img class="friend-profile-avatar" src="${userData.avatar_url || 'assets/images/default-avatar.svg'}" alt="Avatar">
        <div class="friend-profile-info">
          <div class="friend-profile-name">${userData.display_name}</div>
          <div class="friend-profile-bio">${userData.bio ? userData.bio : '<span style=\'color:#666\'>No bio provided.</span>'}</div>
        </div>
      </div>
    `;
    root.appendChild(modal);
    // Animate in
    setTimeout(() => { modal.classList.add('active'); }, 10);
    // Close logic
    function closeModal() {
        modal.classList.remove('active');
        setTimeout(() => { if (modal.parentNode) modal.parentNode.removeChild(modal); }, 320);
    }
    modal.querySelector('.close-friend-profile-modal').onclick = closeModal;
    // Click outside closes
    setTimeout(() => {
        function outsideClick(e) {
            if (!modal.contains(e.target)) {
                closeModal();
                document.removeEventListener('mousedown', outsideClick);
            }
        }
        document.addEventListener('mousedown', outsideClick);
    }, 50);
}

// Add kebab menu styles
(function injectSidebarFriendKebabCSS() {
    if (!document.getElementById('sidebar-friend-kebab-style')) {
        const style = document.createElement('style');
        style.id = 'sidebar-friend-kebab-style';
        style.textContent = `
        .sidebar-friend-kebab {
            background: none;
            border: none;
            color: #bdb6d6;
            font-size: 1.1rem;
            margin-left: auto;
            cursor: pointer;
            padding: 4px 6px;
            border-radius: 5px;
            transition: background 0.18s;
        }
        .sidebar-friend-kebab:hover {
            background: #2a2340;
            color: #a370f7;
        }
        .sidebar-friend-kebab-menu {
            min-width: 170px;
            max-width: 220px;
            min-height: 120px;
            background: rgba(40,30,60,0.98);
            border-radius: 14px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.22), 0 1.5px 8px rgba(163,112,247,0.08);
            padding: 10px 0 10px 0;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            gap: 2px;
            position: fixed;
            animation: kebabMenuIn 0.22s cubic-bezier(0.23, 1, 0.32, 1);
        }
        @keyframes kebabMenuIn {
            0% { opacity: 0; transform: scale(0.85) translateY(18px); }
            100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        .kebab-menu-option {
            color: #eae6fa;
            font-size: 1.01rem;
            padding: 10px 18px 10px 18px;
            cursor: pointer;
            border: none;
            background: none;
            text-align: left;
            border-radius: 7px;
            display: flex;
            align-items: center;
            gap: 10px;
            transition: background 0.16s, color 0.16s;
        }
        .kebab-menu-option:hover {
            background: #2a2340;
            color: #a370f7;
        }
        .kebab-menu-option i {
            min-width: 18px;
            text-align: center;
        }
        `;
        document.head.appendChild(style);
    }
})();

// Add gold star CSS
(function injectSidebarFriendStarCSS() {
    if (!document.getElementById('sidebar-friend-star-style')) {
        const style = document.createElement('style');
        style.id = 'sidebar-friend-star-style';
        style.textContent = `
        .sidebar-friend-name-wrapper {
            display: flex;
            align-items: center;
            gap: 2px;
        }
        .sidebar-friend-star {
            color: gold;
            font-size: 0.85em;
            margin-right: 2px;
            vertical-align: middle;
            display: inline-block;
            line-height: 1;
            height: 1em;
            width: 1em;
            opacity: 0.85;
            transition: opacity 0.18s;
        }
        .sidebar-friend-star i {
            font-size: 0.85em;
            line-height: 1;
        }
        `;
        document.head.appendChild(style);
    }
})();

function updateLocalVideoElement() {
    if (!videoGrid) return;
    let localVideo = document.getElementById('video-local');
    if (isVideoEnabled && localVideoTrack && localStream) {
        if (!localVideo) {
            localVideo = document.createElement('video');
            localVideo.id = 'video-local';
            localVideo.autoplay = true;
            localVideo.muted = true;
            localVideo.playsInline = true;
            localVideo.className = 'video-element local-video';
            videoGrid.appendChild(localVideo);
        }
        localVideo.srcObject = localStream;
        localVideo.style.display = '';
    } else if (localVideo) {
        localVideo.srcObject = null;
        localVideo.style.display = 'none';
    }
}

// Renegotiate all peer connections (for video add/remove)
async function renegotiateAllPeers() {
    for (const userId in peerConnections) {
        const pc = peerConnections[userId];
        if (pc.signalingState === 'stable') {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('offer', {
                    targetUserId: userId,
                    offer: offer
                });
            } catch (err) {
                console.error('Renegotiation failed for', userId, err);
            }
        }
    }
}
