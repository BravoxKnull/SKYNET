const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true
    },
    path: '/socket.io/',
    transports: ['websocket', 'polling']
});

// Serve static files
app.use(express.static('.'));

// Store connected users with both socket.id and user.id as keys
const connectedUsers = new Map();
const userIdToSocketId = new Map();

// Add a basic route for health check
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Handle mute status changes
    socket.on('userMuteStatus', (data) => {
        console.log(`Broadcasting mute status for ${data.userId}: ${data.isMuted}`);
        // Broadcast to all clients except sender
        socket.broadcast.emit('userMuteStatus', {
            userId: data.userId,
            isMuted: data.isMuted,
            displayName: data.displayName
        });
    });

    // Handle deafen status changes
    socket.on('userDeafenStatus', (data) => {
        console.log(`Broadcasting deafen status for ${data.userId}: ${data.isDeafened}`);
        // Broadcast to all clients except sender
        socket.broadcast.emit('userDeafenStatus', {
            userId: data.userId,
            isDeafened: data.isDeafened,
            displayName: data.displayName
        });
    });

    // Handle user joining
    socket.on('joinChannel', (userData) => {
        console.log('User joined channel:', userData);
        // Store user data with both keys
        connectedUsers.set(socket.id, userData);
        userIdToSocketId.set(userData.id, socket.id);
        
        // Broadcast to all clients except sender
        socket.broadcast.emit('userJoined', userData);
        
        // Send current users list to the new user
        const usersList = Array.from(connectedUsers.values());
        socket.emit('usersList', usersList);
    });

    // Handle user leaving
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        const userData = connectedUsers.get(socket.id);
        if (userData) {
            // Broadcast to all clients
            io.emit('userLeft', userData.id);
            connectedUsers.delete(socket.id);
            userIdToSocketId.delete(userData.id);
        }
    });

    // Handle WebRTC signaling
    socket.on('offer', (data) => {
        console.log('Received offer from:', socket.id, 'to:', data.targetUserId);
        const targetSocketId = userIdToSocketId.get(data.targetUserId);
        
        if (targetSocketId) {
            console.log('Forwarding offer to:', targetSocketId);
            io.to(targetSocketId).emit('offer', {
                senderId: connectedUsers.get(socket.id).id,
                offer: data.offer
            });
        } else {
            console.log('Target user not found:', data.targetUserId);
        }
    });

    socket.on('answer', (data) => {
        console.log('Received answer from:', socket.id, 'to:', data.targetUserId);
        const targetSocketId = userIdToSocketId.get(data.targetUserId);
        
        if (targetSocketId) {
            console.log('Forwarding answer to:', targetSocketId);
            io.to(targetSocketId).emit('answer', {
                senderId: connectedUsers.get(socket.id).id,
                answer: data.answer
            });
        } else {
            console.log('Target user not found:', data.targetUserId);
        }
    });

    socket.on('ice-candidate', (data) => {
        console.log('Received ICE candidate from:', socket.id, 'to:', data.targetUserId);
        const targetSocketId = userIdToSocketId.get(data.targetUserId);
        
        if (targetSocketId) {
            console.log('Forwarding ICE candidate to:', targetSocketId);
            io.to(targetSocketId).emit('ice-candidate', {
                senderId: connectedUsers.get(socket.id).id,
                candidate: data.candidate
            });
        } else {
            console.log('Target user not found:', data.targetUserId);
        }
    });

    // Handle voice activity
    socket.on('userSpeaking', (data) => {
        socket.broadcast.emit('userSpeaking', data);
    });

    socket.on('userStoppedSpeaking', (data) => {
        socket.broadcast.emit('userStoppedSpeaking', data);
    });

    // Handle user leaving
    socket.on('leaveChannel', (data) => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            socket.broadcast.emit('userLeft', user.id);
            connectedUsers.delete(socket.id);
            userIdToSocketId.delete(user.id);
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 