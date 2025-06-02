const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const MusicService = require('./musicService');

// Serve static files
app.use(express.static('public'));

// Initialize music service
const musicService = new MusicService();

// Store connected users
const connectedUsers = new Map();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle user joining channel
    socket.on('joinChannel', (userData) => {
        connectedUsers.set(socket.id, userData);
        socket.join('voice-channel');
        
        // Broadcast user joined to all users in the channel
        io.to('voice-channel').emit('userJoined', userData);
        
        // Send current users list to the new user
        const usersList = Array.from(connectedUsers.values());
        socket.emit('usersList', usersList);
    });

    // Handle user leaving
    socket.on('disconnect', () => {
        const userData = connectedUsers.get(socket.id);
        if (userData) {
            connectedUsers.delete(socket.id);
            io.to('voice-channel').emit('userLeft', userData.id);
        }
    });

    // Handle speaking state
    socket.on('speaking', (data) => {
        socket.to('voice-channel').emit('userSpeaking', data);
    });

    socket.on('stoppedSpeaking', (data) => {
        socket.to('voice-channel').emit('userStoppedSpeaking', data);
    });

    // Music Player Events
    socket.on('searchMusic', async ({ query }) => {
        try {
            const results = await musicService.search(query);
            socket.emit('searchResults', results);
        } catch (error) {
            console.error('Error searching music:', error);
            socket.emit('error', { message: 'Error searching music' });
        }
    });

    socket.on('playMusic', async ({ songName }) => {
        try {
            const track = await musicService.play(songName);
            musicService.currentTrack = track;
            io.to('voice-channel').emit('musicState', musicService.getState());
        } catch (error) {
            console.error('Error playing music:', error);
            socket.emit('error', { message: 'Error playing music' });
        }
    });

    socket.on('pauseMusic', () => {
        musicService.pause();
        io.to('voice-channel').emit('musicState', musicService.getState());
    });

    socket.on('resumeMusic', () => {
        musicService.resume();
        io.to('voice-channel').emit('musicState', musicService.getState());
    });

    socket.on('nextTrack', () => {
        const nextTrack = musicService.queue.shift();
        if (nextTrack) {
            musicService.play(nextTrack.url);
            io.to('voice-channel').emit('musicState', musicService.getState());
        }
    });

    socket.on('prevTrack', () => {
        // Implement previous track logic if needed
    });

    socket.on('setVolume', ({ volume }) => {
        musicService.setVolume(volume);
        io.to('voice-channel').emit('musicState', musicService.getState());
    });

    socket.on('clearQueue', () => {
        musicService.clearQueue();
        io.to('voice-channel').emit('musicState', musicService.getState());
    });

    // Handle mute state
    socket.on('userMuted', (data) => {
        socket.to('voice-channel').emit('userMuted', data);
    });

    socket.on('userUnmuted', (data) => {
        socket.to('voice-channel').emit('userUnmuted', data);
    });
});

// Add a basic route for health check
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 