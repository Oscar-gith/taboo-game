// ============================================================
// GameManager — Global room registry
//
// Keeps track of all active game rooms. Creates, looks up,
// and destroys rooms. Runs a periodic cleanup to remove expired rooms.
// ============================================================

const { v4: uuidv4 } = require('uuid');
const GameRoom = require('./gameRoom');
const config   = require('./config');

class GameManager {
  constructor() {
    // Map of roomCode -> GameRoom
    this.rooms = new Map();

    // Clean up expired rooms every 5 minutes
    this.cleanupInterval = setInterval(
      this._cleanup.bind(this),
      5 * 60 * 1000
    );
  }

  // Create a new room and return it
  // Host is auto-assigned to Equipo A (handled in GameRoom constructor)
  createRoom(hostSocketId, hostPlayerName) {
    const code       = this._generateCode();
    const hostPlayerId = uuidv4();
    const room       = new GameRoom(code, hostSocketId, hostPlayerId, hostPlayerName);
    this.rooms.set(code, room);
    return { room, hostPlayerId };
  }

  // Look up a room by code (case-insensitive)
  getRoom(code) {
    return this.rooms.get(code.toUpperCase()) || null;
  }

  // Remove a room and clean it up
  deleteRoom(code) {
    const room = this.rooms.get(code.toUpperCase());
    if (room) room.destroy();
    this.rooms.delete(code.toUpperCase());
  }

  // Find which room a socket ID belongs to (for disconnect handling)
  getRoomBySocketId(socketId) {
    for (const room of this.rooms.values()) {
      for (const player of Object.values(room.players)) {
        if (player.socketId === socketId) return room;
      }
    }
    return null;
  }

  // Find a player by their persistent playerId across all rooms
  findPlayerRoom(playerId) {
    for (const room of this.rooms.values()) {
      if (room.players[playerId]) return room;
    }
    return null;
  }

  // Generate a unique 6-character room code
  _generateCode() {
    let code;
    do {
      code = Array.from(
        { length: config.ROOM_CODE_LENGTH },
        () => config.ROOM_CODE_CHARS[Math.floor(Math.random() * config.ROOM_CODE_CHARS.length)]
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  // Remove rooms that are empty or have been inactive too long
  _cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const expired = (now - room.lastActivityAt) > config.ROOM_EXPIRY_MS;
      if (room.isEmpty() || expired) {
        console.log(`Cleaning up room ${code} (empty: ${room.isEmpty()}, expired: ${expired})`);
        this.deleteRoom(code);
      }
    }
  }

  // Stop the cleanup interval (call on server shutdown)
  destroy() {
    clearInterval(this.cleanupInterval);
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
  }
}

module.exports = GameManager;
