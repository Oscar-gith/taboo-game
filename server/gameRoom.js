// ============================================================
// GameRoom — Core game state machine
//
// This is the most important file. It owns ALL game state and
// enforces ALL game rules. The server is the single source of truth.
//
// NEVER put game logic anywhere else (not in index.js, not on the client).
// ============================================================

const { v4: uuidv4 } = require('uuid');
const config = require('./config');

class GameRoom {
  constructor(code, hostSocketId, hostPlayerId, hostPlayerName) {
    this.code        = code;
    this.state       = 'lobby';   // 'lobby' | 'playing' | 'game_over'
    this.turnPhase   = null;      // 'waiting_for_describer' | 'turn_active' | 'turn_ended'

    // players: { playerId -> { id, name, teamName, socketId, isHost } }
    this.players = {};

    // teams: Fixed teams created upfront (Equipo A, Equipo B)
    // { teamName -> { name, score, memberIds: [], describerIndex: 0 } }
    this.teams = {};
    config.TEAM_NAMES.forEach(name => {
      this.teams[name] = { name, score: 0, memberIds: [], describerIndex: 0 };
    });

    // Turn rotation
    this.teamOrder       = [];   // Ordered list of team names
    this.activeTeamIndex = 0;    // Index into teamOrder

    // Card state
    this.deck        = [];       // Remaining cards (objects)
    this.currentCard = null;
    this.usedCardIds = new Set();

    // Turn state
    this.turnTimer        = null;
    this.secondsRemaining = 0;
    this.turnNumber       = 0;

    // Stats: { playerId -> { described: 0, guessed: 0 } }
    this.playerStats = {};

    // Win configuration
    this.scoreLimit = config.DEFAULT_SCORE_LIMIT;
    this.winMode    = 'score_limit';   // 'score_limit' | 'deck_mode'

    // Lifecycle
    this.lastActivityAt = Date.now();
    this.hostPlayerId   = hostPlayerId;

    // Reconnect timers: { playerId -> timeoutId }
    this.reconnectTimers = {};

    // Add the host to Equipo A (first team)
    this.addPlayer(hostSocketId, hostPlayerId, hostPlayerName, config.TEAM_NAMES[0], true);
  }

  // ── PLAYER MANAGEMENT ────────────────────────────────────────

  // Returns null on success, or an error code string on failure
  addPlayer(socketId, playerId, name, teamName, isHost = false) {
    // Validate team name is one of the fixed teams
    if (!config.TEAM_NAMES.includes(teamName)) {
      return 'INVALID_TEAM';
    }

    // Validate team is not full
    const team = this.teams[teamName];
    if (team.memberIds.length >= config.MAX_PLAYERS_PER_TEAM) {
      return 'TEAM_FULL';
    }

    this.players[playerId] = { id: playerId, name, teamName, socketId, isHost };
    this.playerStats[playerId] = { described: 0, guessed: 0 };

    if (!team.memberIds.includes(playerId)) {
      team.memberIds.push(playerId);
    }

    this.lastActivityAt = Date.now();
    return null; // Success
  }

  removePlayer(playerId) {
    const player = this.players[playerId];
    if (!player) return;

    const team = this.teams[player.teamName];
    if (team) {
      team.memberIds = team.memberIds.filter(id => id !== playerId);
      // Note: Don't delete empty teams — teams are fixed (Equipo A, Equipo B)
    }

    delete this.players[playerId];
    this.lastActivityAt = Date.now();
  }

  // Called when a player reconnects with a new socket ID
  reconnectPlayer(playerId, newSocketId) {
    if (this.players[playerId]) {
      this.players[playerId].socketId = newSocketId;
      // Cancel any pending removal timer
      if (this.reconnectTimers[playerId]) {
        clearTimeout(this.reconnectTimers[playerId]);
        delete this.reconnectTimers[playerId];
      }
      this.lastActivityAt = Date.now();
      return true;
    }
    return false;
  }

  // Schedule player removal if they don't reconnect in time
  schedulePlayerRemoval(playerId, callback) {
    this.reconnectTimers[playerId] = setTimeout(() => {
      this.removePlayer(playerId);
      callback(playerId);
    }, config.RECONNECT_GRACE_MS);
  }

  // Update the socket ID for a player (called after reconnect)
  getSocketIdForPlayer(playerId) {
    return this.players[playerId]?.socketId || null;
  }

  // Get all buzzer socket IDs (opposing team players who can see the card)
  getBuzzerSocketIds() {
    if (this.state !== 'playing') return [];
    const activeTeamName = this.teamOrder[this.activeTeamIndex];
    const buzzerIds = [];

    for (const [teamName, team] of Object.entries(this.teams)) {
      if (teamName !== activeTeamName) {
        for (const playerId of team.memberIds) {
          const socketId = this.players[playerId]?.socketId;
          if (socketId) buzzerIds.push(socketId);
        }
      }
    }
    return buzzerIds;
  }

  // ── GAME START ───────────────────────────────────────────────

  // Returns an error string if can't start, or null if OK
  // Note: DECK_EMPTY is checked in index.js using cardStore.count, not here
  canStart(requestingPlayerId) {
    if (requestingPlayerId !== this.hostPlayerId) return 'NOT_HOST';
    if (this.state !== 'lobby') return 'GAME_ALREADY_STARTED';

    // Check each team has minimum players
    for (const team of Object.values(this.teams)) {
      if (team.memberIds.length < config.MIN_PLAYERS_PER_TEAM) {
        return 'NEED_MORE_PLAYERS';
      }
    }
    return null;
  }

  startGame(deck) {
    this.deck          = [...deck]; // Copy so we don't mutate the shared store
    this.usedCardIds   = new Set();
    this.state         = 'playing';
    this.turnPhase     = 'waiting_for_describer';
    this.activeTeamIndex = 0;
    this.turnNumber    = 0;

    // Set team turn order (sorted for consistency)
    this.teamOrder = Object.keys(this.teams).sort();

    // Reset scores and stats
    Object.values(this.teams).forEach(t => { t.score = 0; t.describerIndex = 0; });
    Object.keys(this.playerStats).forEach(id => { this.playerStats[id] = { described: 0, guessed: 0 }; });

    this.lastActivityAt = Date.now();
    return this._buildTurnInfo();
  }

  // ── TURN MANAGEMENT ──────────────────────────────────────────

  // Called when the describer signals they are ready
  // Returns { card, turnInfo } or an error string
  setDescriberReady(requestingPlayerId) {
    if (this.state !== 'playing')             return { error: 'NOT_PLAYING' };
    if (this.turnPhase !== 'waiting_for_describer') return { error: 'NOT_YOUR_TURN' };

    const expectedDescriber = this._getCurrentDescriberId();
    if (requestingPlayerId !== expectedDescriber) return { error: 'NOT_YOUR_TURN' };

    const card = this._drawNextCard();
    if (!card) return { error: 'DECK_EMPTY' };

    this.currentCard      = card;
    this.turnPhase        = 'turn_active';
    this.secondsRemaining = config.TURN_DURATION_SECONDS;
    this.lastActivityAt   = Date.now();

    return { card, turnInfo: this._buildTurnInfo() };
  }

  // Called by the server's setInterval every second while a turn is active
  // Returns: { secondsRemaining, timedOut }
  tickTimer() {
    this.secondsRemaining--;
    if (this.secondsRemaining <= 0) {
      this.turnPhase = 'turn_ended';
      return { secondsRemaining: 0, timedOut: true };
    }
    return { secondsRemaining: this.secondsRemaining, timedOut: false };
  }

  // Process a card result: 'correct' | 'buzz' | 'skip'
  // Returns: { error } | { scores, result, nextCard, isGameOver, winner }
  scoreCard(requestingPlayerId, cardId, result) {
    if (this.state !== 'playing')    return { error: 'NOT_PLAYING' };
    if (this.turnPhase !== 'turn_active') return { error: 'WRONG_PHASE' };

    // Validate the card matches what's being played
    if (this.currentCard?.id !== cardId) return { error: 'WRONG_CARD' };

    // Validate who can submit each result
    const activeTeamName = this.teamOrder[this.activeTeamIndex];
    const player = this.players[requestingPlayerId];
    if (!player) return { error: 'PLAYER_NOT_FOUND' };

    const isOnActiveTeam = player.teamName === activeTeamName;
    const isDescriber    = requestingPlayerId === this._getCurrentDescriberId();

    if (result === 'correct' && !isOnActiveTeam)  return { error: 'NOT_YOUR_TURN' };
    if (result === 'buzz'    &&  isOnActiveTeam)  return { error: 'CANNOT_BUZZ_OWN_TEAM' };
    if (result === 'skip'    && !isDescriber)      return { error: 'NOT_YOUR_TURN' };

    // Apply the score change
    const activeTeam = this.teams[activeTeamName];
    if (result === 'correct') {
      activeTeam.score++;
      // Track stats for the describer and all guessers on the active team
      const describerId = this._getCurrentDescriberId();
      if (this.playerStats[describerId]) this.playerStats[describerId].described++;
      activeTeam.memberIds
        .filter(id => id !== describerId)
        .forEach(id => { if (this.playerStats[id]) this.playerStats[id].guessed++; });
    } else if (result === 'buzz') {
      activeTeam.score--;
    }
    // 'skip' has no score change

    this.usedCardIds.add(cardId);
    this.currentCard = null;

    // Check win condition before drawing next card
    const winner = this._checkWinCondition();
    if (winner) {
      this.state     = 'game_over';
      this.turnPhase = null;
      this._clearTimer();
      return {
        result,
        scores:     this._buildScores(),
        teamStats:  this._buildTeamStats(),
        playerStats: this._buildPlayerStats(),
        nextCard:   null,
        isGameOver: true,
        winner,
      };
    }

    // Draw the next card for the describer
    const nextCard = this._drawNextCard();
    if (!nextCard) {
      // Deck exhausted mid-turn — check if we have a winner in deck mode
      const deckWinner = this._checkWinCondition(true);
      this.state     = 'game_over';
      this.turnPhase = null;
      this._clearTimer();
      return {
        result,
        scores:     this._buildScores(),
        teamStats:  this._buildTeamStats(),
        playerStats: this._buildPlayerStats(),
        nextCard:   null,
        isGameOver: true,
        winner:     deckWinner || this._findLeader(),
      };
    }

    this.currentCard = nextCard;
    this.lastActivityAt = Date.now();

    return {
      result,
      scores:     this._buildScores(),
      nextCard,
      isGameOver: false,
    };
  }

  // Called when the turn timer expires — advance to next team
  // Returns: { scores, teamStats, nextTeam, nextDescriberName }
  endTurn() {
    this.turnPhase   = 'turn_ended';
    this.currentCard = null;
    this._clearTimer();

    // Advance describer rotation within the active team
    const activeTeam = this._getActiveTeam();
    activeTeam.describerIndex = (activeTeam.describerIndex + 1) % activeTeam.memberIds.length;

    // Advance to the next team
    this.activeTeamIndex = (this.activeTeamIndex + 1) % this.teamOrder.length;
    this.turnNumber++;

    const nextTeam     = this.teamOrder[this.activeTeamIndex];
    const nextDescName = this._getDescriberName(nextTeam);

    this.turnPhase = 'waiting_for_describer';
    this.lastActivityAt = Date.now();

    return {
      scores:            this._buildScores(),
      teamStats:         this._buildTeamStats(),
      nextTeam,
      nextDescriberName: nextDescName,
    };
  }

  // Restart after game_over: reset scores, keep teams, go back to lobby
  restart() {
    this.state       = 'lobby';
    this.turnPhase   = null;
    this.deck        = [];
    this.usedCardIds = new Set();
    this.currentCard = null;
    this.turnNumber  = 0;
    this.activeTeamIndex = 0;

    Object.values(this.teams).forEach(t => { t.score = 0; t.describerIndex = 0; });
    Object.keys(this.playerStats).forEach(id => { this.playerStats[id] = { described: 0, guessed: 0 }; });

    this._clearTimer();
    this.lastActivityAt = Date.now();
  }

  // ── PUBLIC SERIALIZATION ─────────────────────────────────────

  // Safe to send to ALL clients — does NOT include the current card
  toPublicState() {
    return {
      code:         this.code,
      state:        this.state,
      turnPhase:    this.turnPhase,
      players:      this.players,
      teams:        this.teams,
      scores:       this._buildScores(),
      teamOrder:    this.teamOrder,
      activeTeamIndex: this.activeTeamIndex,
      turnNumber:   this.turnNumber,
      secondsRemaining: this.secondsRemaining,
    };
  }

  isEmpty() { return Object.keys(this.players).length === 0; }

  destroy() { this._clearTimer(); }

  // ── PRIVATE HELPERS ──────────────────────────────────────────

  _getActiveTeam() {
    return this.teams[this.teamOrder[this.activeTeamIndex]];
  }

  _getCurrentDescriberId() {
    const team = this._getActiveTeam();
    if (!team || team.memberIds.length === 0) return null;
    const idx = team.describerIndex % team.memberIds.length;
    return team.memberIds[idx];
  }

  _getDescriberName(teamName) {
    const team = this.teams[teamName];
    if (!team || team.memberIds.length === 0) return '—';
    const idx = team.describerIndex % team.memberIds.length;
    const playerId = team.memberIds[idx];
    return this.players[playerId]?.name || '—';
  }

  _drawNextCard() {
    // Find cards not yet used in this game
    const available = this.deck.filter(c => !this.usedCardIds.has(c.id));
    if (available.length === 0) return null;

    // Draw from the front (deck is pre-shuffled when game starts)
    const card = available[0];
    return card;
  }

  _checkWinCondition(forceCheck = false) {
    if (this.winMode === 'score_limit') {
      for (const [name, team] of Object.entries(this.teams)) {
        if (team.score >= this.scoreLimit) return name;
      }
    }
    // deck_mode: checked when deck is exhausted
    return null;
  }

  _findLeader() {
    let leader = null;
    let top = -Infinity;
    let tie = false;

    for (const [name, team] of Object.entries(this.teams)) {
      if (team.score > top) {
        top = team.score;
        leader = name;
        tie = false;
      } else if (team.score === top) {
        tie = true;
      }
    }
    return tie ? 'tie' : leader;
  }

  _buildScores() {
    const scores = {};
    for (const [name, team] of Object.entries(this.teams)) {
      scores[name] = team.score;
    }
    return scores;
  }

  _buildTeamStats() {
    // Per-team aggregate stats (for future use)
    return {};
  }

  _buildPlayerStats() {
    const result = {};
    for (const [playerId, stats] of Object.entries(this.playerStats)) {
      const name = this.players[playerId]?.name || playerId;
      result[name] = stats;
    }
    return result;
  }

  _buildTurnInfo() {
    const activeTeamName = this.teamOrder[this.activeTeamIndex];
    const describerId    = this._getCurrentDescriberId();
    const describerName  = describerId ? (this.players[describerId]?.name || '—') : '—';
    return {
      activeTeam:        activeTeamName,
      describerName,
      describerPlayerId: describerId,
      turnNumber:        this.turnNumber,
    };
  }

  _clearTimer() {
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
      this.turnTimer = null;
    }
  }
}

module.exports = GameRoom;
