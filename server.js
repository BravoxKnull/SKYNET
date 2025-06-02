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
    console.log('User connected:', socket.id);

    // Handle user joining a room
    socket.on('joinChannel', (data) => {
        const { id, displayName, avatar_url } = data;

        // Check if user is already connected
        if (userIdToSocketId.has(id)) {
            // If user is already connected, disconnect the old socket
            const oldSocketId = userIdToSocketId.get(id);
            if (oldSocketId !== socket.id) {
                io.to(oldSocketId).emit('duplicateConnection');
                io.sockets.sockets.get(oldSocketId)?.disconnect();
            }
        }

        // Store user data with both socket.id and user.id
        connectedUsers.set(socket.id, { id, displayName, avatar_url });
        userIdToSocketId.set(id, socket.id);

        // Notify other users in the room
        socket.broadcast.emit('userJoined', {
            id,
            displayName,
            avatar_url
        });

        // Send list of existing users to the new user
        const existingUsers = Array.from(connectedUsers.values())
            .filter(user => user.id !== id);

        socket.emit('usersList', existingUsers);
    });

    // Handle WebRTC signaling
    socket.on('offer', (data) => {
        const { targetUserId, offer } = data;
        const targetSocketId = userIdToSocketId.get(targetUserId);
        
        if (targetSocketId) {
            io.to(targetSocketId).emit('offer', {
                senderId: connectedUsers.get(socket.id).id,
                offer
            });
        }
    });

    socket.on('answer', (data) => {
        const { targetUserId, answer } = data;
        const targetSocketId = userIdToSocketId.get(targetUserId);
        
        if (targetSocketId) {
            io.to(targetSocketId).emit('answer', {
                senderId: connectedUsers.get(socket.id).id,
                answer
            });
        }
    });

    socket.on('ice-candidate', (data) => {
        const { targetUserId, candidate } = data;
        const targetSocketId = userIdToSocketId.get(targetUserId);
        
        if (targetSocketId) {
            io.to(targetSocketId).emit('ice-candidate', {
                senderId: connectedUsers.get(socket.id).id,
                candidate
            });
        }
    });

    // Handle voice activity
    socket.on('speaking', (data) => {
        socket.broadcast.emit('userSpeaking', data);
    });

    socket.on('stoppedSpeaking', (data) => {
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

    // Handle disconnection
    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            socket.broadcast.emit('userLeft', user.id);
            connectedUsers.delete(socket.id);
            userIdToSocketId.delete(user.id);
        }
        console.log('User disconnected:', socket.id);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 