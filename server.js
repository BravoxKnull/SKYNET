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

// Store connected users
const connectedUsers = new Map();

// Add a basic route for health check
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    socket.on('join-room', (data) => {
        const { displayName, avatar_url } = data;
        connectedUsers.set(socket.id, { displayName, avatar_url });
        console.log(`User ${displayName} (${socket.id}) joined with avatar: ${avatar_url}`);

        socket.broadcast.emit('user-joined', {
            socketId: socket.id,
            displayName,
            avatar_url
        });

        const existingUsers = Array.from(connectedUsers.entries())
            .filter(([id]) => id !== socket.id)
            .map(([id, user]) => ({
                socketId: id,
                displayName: user.displayName,
                avatar_url: user.avatar_url
            }));

        console.log('Sending existing users to new user:', existingUsers);
        socket.emit('existing-users', existingUsers);
    });

    // Handle WebRTC signaling
    socket.on('offer', (data) => {
        io.to(data.socketId).emit('offer', {
            socketId: socket.id,
            offer: data.offer
        });
    });

    socket.on('answer', (data) => {
        io.to(data.socketId).emit('answer', {
            socketId: socket.id,
            answer: data.answer
        });
    });

    socket.on('ice-candidate', (data) => {
        io.to(data.socketId).emit('ice-candidate', {
            socketId: socket.id,
            candidate: data.candidate
        });
    });

    // Handle voice activity
    socket.on('speaking', (data) => {
        socket.broadcast.emit('speaking', data);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            socket.broadcast.emit('user-left', {
                socketId: socket.id,
                displayName: user.displayName
            });
            connectedUsers.delete(socket.id);
        }
        console.log('User disconnected:', socket.id);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 