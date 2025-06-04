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

        // Emit sound notification to all clients when a user joins
        io.emit('userJoinedSound');
    });

    // Handle user leaving
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const userData = connectedUsers.get(socket.id);
        if (userData) {
            // Broadcast to all clients
            io.emit('userLeft', userData.id);
            connectedUsers.delete(socket.id);
            userIdToSocketId.delete(userData.id);

            // Emit sound notification to all clients when a user leaves
            io.emit('userLeftSound');
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

            // Emit sound notification to all clients when a user leaves
            io.emit('userLeftSound');
        }
    });

    // Handle friend requests
    socket.on('friendRequest', async (data) => {
        console.log('Friend request received:', data);
        const { from, to } = data;
        
        // Store the friend request in Supabase
        const { data: requestData, error } = await supabase
            .from('friend_requests')
            .insert([
                { 
                    from_user_id: from,
                    to_user_id: to,
                    status: 'pending'
                }
            ])
            .select();
        
        if (error) {
            console.error('Error storing friend request:', error);
            socket.emit('friendRequestError', { message: 'Failed to send friend request' });
            return;
        }

        // Notify the recipient
        const recipientSocket = getUserSocket(to);
        if (recipientSocket) {
            recipientSocket.emit('friendRequest', {
                from,
                requestId: requestData[0].id
            });
        }
    });

    // Handle friend request responses
    socket.on('friendRequestResponse', async (data) => {
        console.log('Friend request response:', data);
        const { requestId, response, from, to } = data;
        
        // Update the friend request status
        const { error: updateError } = await supabase
            .from('friend_requests')
            .update({ status: response })
            .eq('id', requestId);
        
        if (updateError) {
            console.error('Error updating friend request:', updateError);
            socket.emit('friendRequestError', { message: 'Failed to update friend request' });
            return;
        }

        if (response === 'accepted') {
            // Add the friendship to the friends table
            const { error: friendError } = await supabase
                .from('friends')
                .insert([
                    { user_id: from, friend_id: to },
                    { user_id: to, friend_id: from }
                ]);
            
            if (friendError) {
                console.error('Error creating friendship:', friendError);
                socket.emit('friendRequestError', { message: 'Failed to create friendship' });
                return;
            }

            // Notify both users
            const fromSocket = getUserSocket(from);
            const toSocket = getUserSocket(to);
            
            if (fromSocket) {
                fromSocket.emit('friendRequestAccepted', { friendId: to });
            }
            if (toSocket) {
                toSocket.emit('friendRequestAccepted', { friendId: from });
            }
        } else {
            // Notify the sender that the request was rejected
            const fromSocket = getUserSocket(from);
            if (fromSocket) {
                fromSocket.emit('friendRequestRejected', { friendId: to });
            }
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 