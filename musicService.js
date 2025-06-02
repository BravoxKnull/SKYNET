const play = require('play-dl');
const { createAudioPlayer, createAudioResource, AudioPlayerStatus, joinVoiceChannel } = require('@discordjs/voice');

class MusicService {
    constructor() {
        this.queue = [];
        this.currentTrack = null;
        this.isPlaying = false;
        this.volume = 1;
        this.player = createAudioPlayer();
    }

    async search(query) {
        try {
            const searchResults = await play.search(query, { limit: 10 });
            return searchResults.map(result => ({
                title: result.title,
                artist: result.channel?.name || 'Unknown Artist',
                thumbnail: result.thumbnails?.[0]?.url || null,
                url: result.url,
                duration: result.durationInSec || 0
            }));
        } catch (error) {
            console.error('Error searching music:', error);
            throw error;
        }
    }

    async play(songUrl) {
        try {
            const stream = await play.stream(songUrl);
            const resource = createAudioResource(stream.stream, {
                inputType: stream.type,
                inlineVolume: true
            });
            
            resource.volume.setVolume(this.volume);
            this.player.play(resource);
            this.isPlaying = true;
            
            return {
                title: stream.video_details.title,
                artist: stream.video_details.channel?.name || 'Unknown Artist',
                thumbnail: stream.video_details.thumbnails?.[0]?.url || null,
                duration: stream.video_details.durationInSec || 0
            };
        } catch (error) {
            console.error('Error playing music:', error);
            throw error;
        }
    }

    pause() {
        this.player.pause();
        this.isPlaying = false;
    }

    resume() {
        this.player.unpause();
        this.isPlaying = true;
    }

    stop() {
        this.player.stop();
        this.isPlaying = false;
    }

    setVolume(volume) {
        this.volume = volume;
        if (this.player.state.resource) {
            this.player.state.resource.volume.setVolume(volume);
        }
    }

    addToQueue(song) {
        this.queue.push(song);
    }

    clearQueue() {
        this.queue = [];
    }

    getQueue() {
        return this.queue;
    }

    getCurrentTrack() {
        return this.currentTrack;
    }

    getState() {
        return {
            currentTrack: this.currentTrack,
            isPlaying: this.isPlaying,
            queue: this.queue,
            volume: this.volume
        };
    }
}

module.exports = MusicService; 