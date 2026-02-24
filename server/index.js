// ============================================================
// Server Entry Point — Express + Socket.io
//
// Responsibilities:
//   1. Serve the client files (HTML, CSS, JS) statically
//   2. Wire all Socket.io events to GameRoom methods
//   3. Manage the server-side turn timer
//
// PATTERN: Every socket handler follows:
//   get room → validate → call gameRoom method → broadcast result
// ============================================================

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

const GameManager = require('./gameManager');
const CardStore   = require('./cardStore');
const config      = require('./config');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

const gameManager = new GameManager();
const cardStore   = new CardStore();

// ── STATIC FILE SERVING ──────────────────────────────────────

// The client folder is served directly — no build step needed
app.use(express.static(path.join(__dirname, '../client')));

// ── REST ENDPOINTS ────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: gameManager.rooms.size, cards: cardStore.count });
});

// ── SOCKET.IO ────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────────────────────

  socket.on('create_room', ({ playerName, playerId: existingPlayerId, mode = 'classic' }) => {
    // Validate mode
    if (!config.GAME_MODES.includes(mode)) {
      return socket.emit('error', { code: 'INVALID_MODE', message: 'Modo de juego inválido.' });
    }

    // Create room with specified mode
    const { room, hostPlayerId } = gameManager.createRoom(socket.id, playerName, mode);
    socket.join(room.code);

    if (mode === 'practice') {
      // Practice mode: start immediately with cards
      if (cardStore.count === 0) {
        gameManager.deleteRoom(room.code);
        return socket.emit('error', { code: 'DECK_EMPTY', message: 'No hay cartas disponibles. Ejecuta: npm run generate-cards' });
      }

      const deck = cardStore.getShuffledDeck();
      const result = room.startPractice(deck);

      if (result.error) {
        gameManager.deleteRoom(room.code);
        return socket.emit('error', { code: result.error, message: 'Error al iniciar práctica.' });
      }

      socket.emit('room_created', {
        roomCode:  room.code,
        roomState: room.toPublicState(),
        playerId:  hostPlayerId,
      });

      // Send the first card immediately
      socket.emit('practice_started', {
        card: result.card,
        stats: result.stats,
      });

      console.log(`Practice room ${room.code} created by "${playerName}"`);
    } else {
      // Classic mode: host is assigned to Equipo A
      socket.emit('room_created', {
        roomCode:  room.code,
        roomState: room.toPublicState(),
        playerId:  hostPlayerId,
      });

      console.log(`Room ${room.code} created by "${playerName}" (Equipo A)`);
    }
  });

  // ── JOIN ROOM ────────────────────────────────────────────

  socket.on('join_room', ({ roomCode, playerName, teamName, playerId: existingPlayerId }) => {
    const room = gameManager.getRoom(roomCode);
    if (!room) {
      return socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Sala no encontrada. Verifica el código.' });
    }

    // Practice mode rooms don't allow other players to join
    if (room.mode === 'practice') {
      return socket.emit('error', { code: 'ROOM_IS_PRACTICE', message: 'Esta es una sala de práctica privada.' });
    }

    // Check if this player is reconnecting with a known ID
    if (existingPlayerId && room.reconnectPlayer(existingPlayerId, socket.id)) {
      socket.join(room.code);
      socket.emit('room_joined', { roomState: room.toPublicState(), playerId: existingPlayerId });
      socket.to(room.code).emit('room_updated', { roomState: room.toPublicState() });
      return;
    }

    // New player joining — validate team selection
    // Note: Players CAN join mid-game as spectators now (no GAME_ALREADY_STARTED check)
    const playerId = uuidv4();
    const addResult = room.addPlayer(socket.id, playerId, playerName, teamName, false);

    if (addResult.error === 'INVALID_TEAM') {
      return socket.emit('error', { code: 'INVALID_TEAM', message: 'Equipo inválido. Elige Equipo A o Equipo B.' });
    }
    if (addResult.error === 'TEAM_FULL') {
      return socket.emit('error', { code: 'TEAM_FULL', message: `${teamName} está lleno. Únete al otro equipo.` });
    }

    socket.join(room.code);
    socket.emit('room_joined', { roomState: room.toPublicState(), playerId, isSpectator: addResult.isSpectator });

    if (addResult.isSpectator) {
      // Notify everyone that a spectator joined
      io.to(room.code).emit('spectator_joined', { playerName, teamName });
      console.log(`"${playerName}" joined room ${room.code} as spectator (${teamName})`);
    } else {
      socket.to(room.code).emit('room_updated', { roomState: room.toPublicState() });
      console.log(`"${playerName}" joined room ${room.code} (${teamName})`);
    }
  });

  // ── RECONNECT ROOM ────────────────────────────────────────

  socket.on('reconnect_room', ({ roomCode, playerId, playerName }) => {
    const room = gameManager.getRoom(roomCode);

    // Check if room exists and player was in it
    if (!room) {
      return socket.emit('reconnect_failed', { reason: 'ROOM_NOT_FOUND' });
    }

    if (!room.hasPlayer(playerId)) {
      return socket.emit('reconnect_failed', { reason: 'PLAYER_NOT_IN_ROOM' });
    }

    // Reconnect the player with new socket
    room.reconnectPlayer(playerId, socket.id);
    socket.join(room.code);

    socket.emit('reconnect_success', { roomState: room.toPublicState(), playerId });
    socket.to(room.code).emit('room_updated', { roomState: room.toPublicState() });

    console.log(`"${playerName}" reconnected to room ${room.code}`);
  });

  // ── START GAME ────────────────────────────────────────────

  socket.on('start_game', ({ roomCode }) => {
    const { room, playerId } = _getPlayerRoom(socket.id, roomCode);
    if (!room) return socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Sala no encontrada.' });

    const error = room.canStart(playerId);
    if (error === 'NOT_HOST')          return socket.emit('error', { code: 'NOT_HOST',          message: 'Solo el anfitrión puede iniciar el juego.' });
    if (error === 'GAME_ALREADY_STARTED') return socket.emit('error', { code: 'GAME_ALREADY_STARTED', message: 'El juego ya está en curso.' });
    if (error === 'NEED_MORE_PLAYERS') return socket.emit('error', { code: 'NEED_MORE_PLAYERS', message: 'Cada equipo necesita al menos 2 jugadores.' });

    // Check cardStore has cards (not the room's deck which is empty before game starts)
    if (cardStore.count === 0) {
      return socket.emit('error', { code: 'DECK_EMPTY', message: 'No hay cartas disponibles. Ejecuta: npm run generate-cards' });
    }

    // Get a shuffled deck for this game
    const deck     = cardStore.getShuffledDeck();
    const turnInfo = room.startGame(deck);

    // Notify everyone the game has started
    io.to(roomCode).emit('game_started', { roomState: room.toPublicState() });

    // Immediately signal the first turn
    io.to(roomCode).emit('turn_started', turnInfo);

    console.log(`Game started in room ${roomCode}`);
  });

  // ── DESCRIBER READY ───────────────────────────────────────

  socket.on('describer_ready', ({ roomCode }) => {
    const { room, playerId } = _getPlayerRoom(socket.id, roomCode);
    if (!room) return;

    const result = room.setDescriberReady(playerId);
    if (result.error) {
      return socket.emit('error', { code: result.error, message: _errorMessage(result.error) });
    }

    // Send the card to the describer
    socket.emit('card_revealed', { card: result.card });

    // Send the card to all buzzers (opposing team) so they can catch taboo violations
    const buzzerSocketIds = room.getBuzzerSocketIds();
    buzzerSocketIds.forEach(buzzerSocketId => {
      io.to(buzzerSocketId).emit('card_revealed', { card: result.card });
    });

    // Tell all observers that the turn is now active
    socket.to(roomCode).emit('turn_active', { activeTeam: result.turnInfo.activeTeam });

    // Start the server-side countdown timer
    _startTurnTimer(room, roomCode);

    console.log(`Turn started in room ${roomCode} — describer: "${result.turnInfo.describerName}"`);
  });

  // ── CARD CORRECT ─────────────────────────────────────────

  socket.on('card_correct', ({ roomCode, cardId }) => {
    _handleCardAction(socket, roomCode, cardId, 'correct');
  });

  // ── CARD BUZZ (taboo word said) ───────────────────────────

  socket.on('card_buzz', ({ roomCode, cardId }) => {
    _handleCardAction(socket, roomCode, cardId, 'buzz');
  });

  // ── CARD SKIP ────────────────────────────────────────────

  socket.on('card_skip', ({ roomCode, cardId }) => {
    _handleCardAction(socket, roomCode, cardId, 'skip');
  });

  // ── PLAY AGAIN ────────────────────────────────────────────

  socket.on('play_again', ({ roomCode }) => {
    const { room, playerId } = _getPlayerRoom(socket.id, roomCode);
    if (!room) return;
    if (playerId !== room.hostPlayerId) {
      return socket.emit('error', { code: 'NOT_HOST', message: 'Solo el anfitrión puede reiniciar.' });
    }
    if (room.state !== 'game_over') return;

    room.restart();
    io.to(roomCode).emit('room_updated', { roomState: room.toPublicState() });
  });

  // ── PRACTICE MODE: END PRACTICE ─────────────────────────

  socket.on('end_practice', ({ roomCode }) => {
    const { room, playerId } = _getPlayerRoom(socket.id, roomCode);
    if (!room) return socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Sala no encontrada.' });

    if (room.mode !== 'practice') {
      return socket.emit('error', { code: 'NOT_PRACTICE_MODE', message: 'Esta no es una sala de práctica.' });
    }

    const result = room.endPractice();
    if (result.error) {
      return socket.emit('error', { code: result.error, message: _errorMessage(result.error) });
    }

    socket.emit('practice_ended', { stats: result.stats });
    console.log(`Practice ended in room ${roomCode} — stats: ${JSON.stringify(result.stats)}`);
  });

  // ── PRACTICE MODE: RESTART PRACTICE ─────────────────────

  socket.on('restart_practice', ({ roomCode }) => {
    const { room, playerId } = _getPlayerRoom(socket.id, roomCode);
    if (!room) return socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Sala no encontrada.' });

    if (room.mode !== 'practice') {
      return socket.emit('error', { code: 'NOT_PRACTICE_MODE', message: 'Esta no es una sala de práctica.' });
    }

    const deck = cardStore.getShuffledDeck();
    const result = room.restartPractice(deck);
    if (result.error) {
      return socket.emit('error', { code: result.error, message: _errorMessage(result.error) });
    }

    socket.emit('practice_started', { card: result.card, stats: result.stats });
    console.log(`Practice restarted in room ${roomCode}`);
  });

  // ── LEAVE ROOM ────────────────────────────────────────────

  socket.on('leave_room', ({ roomCode }) => {
    _handleDisconnect(socket, roomCode);
  });

  // ── DISCONNECT ────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnected: ${socket.id}`);
    _handleDisconnect(socket);
  });

  // ── HELPERS ──────────────────────────────────────────────

  function _handleCardAction(socket, roomCode, cardId, result) {
    const { room, playerId } = _getPlayerRoom(socket.id, roomCode);
    if (!room) return;

    // Practice mode: handle separately
    if (room.mode === 'practice') {
      return _handlePracticeCardAction(socket, room, roomCode, result);
    }

    // Classic mode: existing logic
    // For buzz, we may not have a cardId from the client — use the current card
    const effectiveCardId = cardId || room.currentCard?.id;
    if (!effectiveCardId) return;

    const res = room.scoreCard(playerId, effectiveCardId, result);
    if (res.error) {
      return socket.emit('error', { code: res.error, message: _errorMessage(res.error) });
    }

    // Broadcast the score update to everyone
    io.to(roomCode).emit('card_scored', {
      cardId:   effectiveCardId,
      result:   res.result,
      scores:   res.scores,
    });

    if (res.isGameOver) {
      // Stop the timer
      if (room.turnTimer) { clearInterval(room.turnTimer); room.turnTimer = null; }

      io.to(roomCode).emit('game_over', {
        finalScores: res.scores,
        teamStats:   res.teamStats,
        playerStats: res.playerStats,
        winner:      res.winner,
      });
    } else if (res.nextCard) {
      // Send next card to describer
      const describerSocketId = room.getSocketIdForPlayer(room._getCurrentDescriberId());
      if (describerSocketId) {
        io.to(describerSocketId).emit('card_revealed', { card: res.nextCard });
      }
      // Also send to buzzers so they can catch taboo violations
      const buzzerSocketIds = room.getBuzzerSocketIds();
      buzzerSocketIds.forEach(buzzerSocketId => {
        io.to(buzzerSocketId).emit('card_revealed', { card: res.nextCard });
      });
    }

    // Refill cards in background if running low
    cardStore.checkAndRefill((totalCards) => {
      io.to(roomCode).emit('cards_ready', { totalCards });
    });
  }

  function _handlePracticeCardAction(socket, room, roomCode, result) {
    // Practice mode only supports 'correct' and 'skip'
    if (result !== 'correct' && result !== 'skip') return;

    const res = room.practiceCard(result);
    if (res.error) {
      return socket.emit('error', { code: res.error, message: _errorMessage(res.error) });
    }

    if (res.deckEmpty) {
      // No more cards — end practice
      socket.emit('practice_ended', { stats: res.stats });
      console.log(`Practice ended (deck empty) in room ${roomCode}`);
    } else {
      // Send next card
      socket.emit('practice_card', { card: res.nextCard, stats: res.stats });
    }
  }

  function _handleDisconnect(socket, specificRoomCode = null) {
    const room = specificRoomCode
      ? gameManager.getRoom(specificRoomCode)
      : gameManager.getRoomBySocketId(socket.id);

    if (!room) return;

    const playerId = _getPlayerIdBySocket(room, socket.id);
    if (!playerId) return;

    const roomCode = room.code;
    const playerName = room.players[playerId]?.name;
    const wasHost = playerId === room.hostPlayerId;

    console.log(`Player "${playerName}" disconnected from room ${roomCode}`);

    // If the disconnected player was the active describer and turn is running, end the turn
    const isDescriber = (room.state === 'playing' &&
                         room.turnPhase === 'turn_active' &&
                         playerId === room._getCurrentDescriberId());

    if (isDescriber) {
      const endData = room.endTurn();
      io.to(roomCode).emit('turn_ended', endData);

      // Emit spectator_activated for any spectators that were activated
      if (endData.activatedSpectators && endData.activatedSpectators.length > 0) {
        endData.activatedSpectators.forEach(name => {
          io.to(roomCode).emit('spectator_activated', { playerName: name });
        });
      }

      // Schedule the next turn after the pause
      setTimeout(() => {
        if (room.state === 'playing') {
          const turnInfo = room._buildTurnInfo();
          io.to(roomCode).emit('turn_started', turnInfo);
        }
      }, config.TURN_END_PAUSE_MS);
    }

    // If host disconnected, delegate to next player immediately
    if (wasHost) {
      const newHost = room.delegateHost();
      if (newHost) {
        io.to(roomCode).emit('host_changed', {
          newHostName: newHost.name,
          newHostId:   newHost.id,
        });
        console.log(`Host delegated to "${newHost.name}" in room ${roomCode}`);
      }
    }

    // Notify the room
    io.to(roomCode).emit('room_updated', { roomState: room.toPublicState() });

    // Give the player time to reconnect before removing them
    room.schedulePlayerRemoval(playerId, (removedId) => {
      io.to(roomCode).emit('room_updated', { roomState: room.toPublicState() });
      // Clean up room if empty
      if (room.isEmpty()) gameManager.deleteRoom(roomCode);
    });
  }
});

// ── TURN TIMER ───────────────────────────────────────────────

function _startTurnTimer(room, roomCode) {
  // Clear any existing timer first
  if (room.turnTimer) clearInterval(room.turnTimer);

  room.turnTimer = setInterval(() => {
    const { secondsRemaining, timedOut } = room.tickTimer();

    io.to(roomCode).emit('timer_tick', { secondsRemaining });

    if (timedOut) {
      clearInterval(room.turnTimer);
      room.turnTimer = null;

      const endData = room.endTurn();
      io.to(roomCode).emit('turn_ended', endData);

      // Emit spectator_activated for any spectators that were activated
      if (endData.activatedSpectators && endData.activatedSpectators.length > 0) {
        endData.activatedSpectators.forEach(name => {
          io.to(roomCode).emit('spectator_activated', { playerName: name });
        });
      }

      // Check if the game should continue
      if (room.state === 'game_over') {
        io.to(roomCode).emit('game_over', {
          finalScores: endData.scores,
          teamStats:   endData.teamStats,
          playerStats: room._buildPlayerStats(),
          winner:      room._findLeader(),
        });
        return;
      }

      // Auto-advance after the pause
      setTimeout(() => {
        if (room.state === 'playing') {
          const turnInfo = room._buildTurnInfo();
          io.to(roomCode).emit('turn_started', turnInfo);
        }
      }, config.TURN_END_PAUSE_MS);

      // Refill if low
      cardStore.checkAndRefill((totalCards) => {
        io.to(roomCode).emit('cards_ready', { totalCards });
      });
    }
  }, 1000);
}

// ── UTILITY HELPERS ──────────────────────────────────────────

// Given a socket and optional roomCode, return { room, playerId }
function _getPlayerRoom(socketId, roomCode) {
  const room = gameManager.getRoom(roomCode);
  if (!room) return { room: null, playerId: null };
  const playerId = _getPlayerIdBySocket(room, socketId);
  return { room, playerId };
}

function _getPlayerIdBySocket(room, socketId) {
  for (const [id, player] of Object.entries(room.players)) {
    if (player.socketId === socketId) return id;
  }
  return null;
}

function _errorMessage(code) {
  const messages = {
    NOT_PLAYING:        'El juego no está en curso.',
    NOT_YOUR_TURN:      'No es tu turno.',
    WRONG_PHASE:        'Acción no permitida en este momento.',
    WRONG_CARD:         'La carta ya cambió.',
    CANNOT_BUZZ_OWN_TEAM: 'No puedes reportar tabú en tu propio equipo.',
    PLAYER_NOT_FOUND:   'Jugador no encontrado.',
    DECK_EMPTY:         'No hay más cartas disponibles.',
  };
  return messages[code] || 'Error desconocido.';
}

// ── START SERVER ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\nTaboo server running at http://localhost:${PORT}`);
  console.log(`Cards loaded: ${cardStore.count}`);
  console.log('Press Ctrl+C to stop.\n');
});
