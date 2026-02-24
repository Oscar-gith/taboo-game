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
  constructor(code, hostSocketId, hostPlayerId, hostPlayerName, mode = 'classic') {
    this.code        = code;
    this.mode        = mode;      // 'classic' | 'practice'
    this.state       = mode === 'practice' ? 'practice_active' : 'lobby';
    this.turnPhase   = null;      // 'waiting_for_describer' | 'turn_active' | 'turn_ended' (classic only)

    // players: { playerId -> { id, name, teamName, socketId, isHost, status, joinOrder } }
    // status: 'active' | 'spectating' (spectating = joined mid-game, waiting for next round)
    this.players = {};
    this.nextJoinOrder = 0;  // Counter for tracking join order (for host delegation)

    // teams: Fixed teams created upfront (Equipo A, Equipo B) — only for classic mode
    // { teamName -> { name, score, memberIds: [], describerIndex: 0 } }
    this.teams = {};
    if (mode === 'classic') {
      config.TEAM_NAMES.forEach(name => {
        this.teams[name] = { name, score: 0, memberIds: [], describerIndex: 0 };
      });
    }

    // Turn rotation (classic mode only)
    this.teamOrder       = [];   // Ordered list of team names
    this.activeTeamIndex = 0;    // Index into teamOrder

    // Card state
    this.deck        = [];       // Remaining cards (objects)
    this.currentCard = null;
    this.usedCardIds = new Set();

    // Turn state (classic mode only)
    this.turnTimer        = null;
    this.secondsRemaining = 0;
    this.turnNumber       = 0;

    // Stats: { playerId -> { described: 0, guessed: 0 } }
    this.playerStats = {};

    // Practice mode stats
    this.practiceStats = {
      cardsViewed: 0,
      cardsCorrect: 0,
      cardsSkipped: 0
    };

    // Win configuration (classic mode only)
    this.scoreLimit = config.DEFAULT_SCORE_LIMIT;
    this.winMode    = 'score_limit';   // 'score_limit' | 'deck_mode'

    // Lifecycle
    this.lastActivityAt = Date.now();
    this.hostPlayerId   = hostPlayerId;

    // Reconnect timers: { playerId -> timeoutId }
    this.reconnectTimers = {};

    // Add the player
    if (mode === 'practice') {
      // Practice mode: single player, no team
      this.addPracticePlayer(hostSocketId, hostPlayerId, hostPlayerName);
    } else {
      // Classic mode: host joins Equipo A
      this.addPlayer(hostSocketId, hostPlayerId, hostPlayerName, config.TEAM_NAMES[0], true);
    }
  }

  // Add a player for practice mode (no team)
  addPracticePlayer(socketId, playerId, name) {
    this.players[playerId] = {
      id: playerId,
      name,
      teamName: null,
      socketId,
      isHost: true,
      status: 'active',
      joinOrder: this.nextJoinOrder++
    };
    this.playerStats[playerId] = { described: 0, guessed: 0 };
    this.lastActivityAt = Date.now();
    return {};
  }

  // Get list of spectators (players waiting to join)
  getSpectators() {
    return Object.values(this.players).filter(p => p.status === 'spectating');
  }

  // Activate all spectators — call this at the start of a new turn (waiting_for_describer)
  // Returns array of activated player names
  activateSpectators() {
    const activated = [];
    for (const player of Object.values(this.players)) {
      if (player.status === 'spectating') {
        player.status = 'active';
        const team = this.teams[player.teamName];
        if (team && !team.memberIds.includes(player.id)) {
          team.memberIds.push(player.id);
        }
        activated.push(player.name);
      }
    }
    return activated;
  }

  // Delegate host to the next oldest player (by joinOrder)
  // Returns the new host's player object, or null if no other players
  delegateHost() {
    const currentHostId = this.hostPlayerId;
    const candidates = Object.values(this.players)
      .filter(p => p.id !== currentHostId && p.status === 'active')
      .sort((a, b) => a.joinOrder - b.joinOrder);

    if (candidates.length === 0) {
      // No active players to delegate to, try spectators
      const spectators = Object.values(this.players)
        .filter(p => p.id !== currentHostId)
        .sort((a, b) => a.joinOrder - b.joinOrder);
      if (spectators.length === 0) return null;
      candidates.push(spectators[0]);
    }

    const newHost = candidates[0];

    // Remove host status from current host if they still exist
    if (this.players[currentHostId]) {
      this.players[currentHostId].isHost = false;
    }

    // Assign host to new player
    newHost.isHost = true;
    this.hostPlayerId = newHost.id;

    return newHost;
  }

  // ── PLAYER MANAGEMENT ────────────────────────────────────────

  // Returns { error } on failure, or { isSpectator } on success
  addPlayer(socketId, playerId, name, teamName, isHost = false) {
    // Validate team name is one of the fixed teams
    if (!config.TEAM_NAMES.includes(teamName)) {
      return { error: 'INVALID_TEAM' };
    }

    // Validate team is not full
    const team = this.teams[teamName];
    if (team.memberIds.length >= config.MAX_PLAYERS_PER_TEAM) {
      return { error: 'TEAM_FULL' };
    }

    // Determine if player joins as spectator (game already in progress)
    const isSpectator = this.state === 'playing';

    this.players[playerId] = {
      id: playerId,
      name,
      teamName,
      socketId,
      isHost,
      status: isSpectator ? 'spectating' : 'active',
      joinOrder: this.nextJoinOrder++
    };
    this.playerStats[playerId] = { described: 0, guessed: 0 };

    // Only add to team's active members if not spectating
    // Spectators are tracked in players but don't participate in rotation until activated
    if (!team.memberIds.includes(playerId)) {
      if (!isSpectator) {
        team.memberIds.push(playerId);
      }
    }

    this.lastActivityAt = Date.now();
    return { isSpectator }; // Success
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
  // Returns: { scores, teamStats, nextTeam, nextDescriberName, activatedSpectators }
  endTurn() {
    this.turnPhase = 'turn_ended';
    // Mark the current card as used so it won't appear again
    if (this.currentCard) {
      this.usedCardIds.add(this.currentCard.id);
    }
    this.currentCard = null;
    this._clearTimer();

    // Advance describer rotation within the active team
    const activeTeam = this._getActiveTeam();
    if (activeTeam.memberIds.length > 0) {
      activeTeam.describerIndex = (activeTeam.describerIndex + 1) % activeTeam.memberIds.length;
    }

    // Advance to the next team
    this.activeTeamIndex = (this.activeTeamIndex + 1) % this.teamOrder.length;
    this.turnNumber++;

    // Activate any spectators waiting to join
    const activatedSpectators = this.activateSpectators();

    const nextTeam     = this.teamOrder[this.activeTeamIndex];
    const nextDescName = this._getDescriberName(nextTeam);

    this.turnPhase = 'waiting_for_describer';
    this.lastActivityAt = Date.now();

    return {
      scores:            this._buildScores(),
      teamStats:         this._buildTeamStats(),
      nextTeam,
      nextDescriberName: nextDescName,
      activatedSpectators,
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

    // Activate any remaining spectators
    this.activateSpectators();

    Object.values(this.teams).forEach(t => { t.score = 0; t.describerIndex = 0; });
    Object.keys(this.playerStats).forEach(id => { this.playerStats[id] = { described: 0, guessed: 0 }; });

    this._clearTimer();
    this.lastActivityAt = Date.now();
  }

  // ── PRACTICE MODE METHODS ───────────────────────────────────

  // Start practice session with a deck
  startPractice(deck) {
    if (this.mode !== 'practice') return { error: 'NOT_PRACTICE_MODE' };

    this.deck = [...deck];
    this.state = 'practice_active';
    this.practiceStats = { cardsViewed: 0, cardsCorrect: 0, cardsSkipped: 0 };
    this.lastActivityAt = Date.now();

    // Draw the first card
    const card = this._drawPracticeCard();
    if (!card) return { error: 'DECK_EMPTY' };

    this.currentCard = card;
    this.practiceStats.cardsViewed++;

    return { card, stats: { ...this.practiceStats } };
  }

  // Process a practice card result: 'correct' | 'skip'
  // Returns the next card and updated stats
  practiceCard(result) {
    if (this.mode !== 'practice') return { error: 'NOT_PRACTICE_MODE' };
    if (this.state !== 'practice_active') return { error: 'NOT_PLAYING' };
    if (!this.currentCard) return { error: 'NO_CARD' };

    // Update stats
    if (result === 'correct') {
      this.practiceStats.cardsCorrect++;
    } else if (result === 'skip') {
      this.practiceStats.cardsSkipped++;
    }

    // Draw next card (practice mode doesn't mark cards as used - can repeat)
    const nextCard = this._drawPracticeCard();
    if (!nextCard) {
      // No more cards - end practice
      this.state = 'practice_ended';
      this.currentCard = null;
      return {
        nextCard: null,
        stats: { ...this.practiceStats },
        deckEmpty: true
      };
    }

    this.currentCard = nextCard;
    this.practiceStats.cardsViewed++;
    this.lastActivityAt = Date.now();

    return {
      nextCard,
      stats: { ...this.practiceStats },
      deckEmpty: false
    };
  }

  // End practice session
  endPractice() {
    if (this.mode !== 'practice') return { error: 'NOT_PRACTICE_MODE' };

    this.state = 'practice_ended';
    this.currentCard = null;
    this.lastActivityAt = Date.now();

    return { stats: { ...this.practiceStats } };
  }

  // Restart practice session
  restartPractice(deck) {
    if (this.mode !== 'practice') return { error: 'NOT_PRACTICE_MODE' };

    return this.startPractice(deck);
  }

  // Draw a random card for practice (doesn't mark as used)
  _drawPracticeCard() {
    if (this.deck.length === 0) return null;
    // Pick a random card from the deck
    const randomIndex = Math.floor(Math.random() * this.deck.length);
    return this.deck[randomIndex];
  }

  // ── PUBLIC SERIALIZATION ─────────────────────────────────────

  // Safe to send to ALL clients — does NOT include the current card
  toPublicState() {
    const base = {
      code:         this.code,
      mode:         this.mode,
      state:        this.state,
      players:      this.players,
      hostPlayerId: this.hostPlayerId,
    };

    if (this.mode === 'practice') {
      return {
        ...base,
        practiceStats: { ...this.practiceStats },
      };
    }

    // Classic mode includes team/turn data
    return {
      ...base,
      turnPhase:    this.turnPhase,
      teams:        this.teams,
      scores:       this._buildScores(),
      teamOrder:    this.teamOrder,
      activeTeamIndex: this.activeTeamIndex,
      turnNumber:   this.turnNumber,
      secondsRemaining: this.secondsRemaining,
    };
  }

  // Check if a player exists and was previously in this room
  hasPlayer(playerId) {
    return !!this.players[playerId];
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
