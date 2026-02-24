// ============================================================
// TABOO GAME — Client-side logic
//
// ARCHITECTURE NOTE:
//   - This file is display-only. All game rules live on the server.
//   - We emit events to the server and render whatever the server sends back.
//   - Never implement game logic here. Never trust client state for rules.
//
// SECTIONS:
//   1. Initialization & State
//   2. Screen Management
//   3. Socket.io — Server → Client (incoming events)
//   4. Socket.io — Client → Server (outgoing events, triggered by UI)
//   5. Render Helpers
//   6. Utility Functions
// ============================================================

// ── 1. INITIALIZATION & STATE ─────────────────────────────────

const socket = io();

// Persistent player identity in localStorage (survives browser refresh)
let myPlayerId   = localStorage.getItem('taboo_player_id') || null;
let myRoomCode   = localStorage.getItem('taboo_room_code') || null;
let myPlayerName = localStorage.getItem('taboo_player_name') || null;
let myRole       = null;   // 'describer' | 'guesser' | 'buzzer'
let myTeamName   = null;
let currentCard  = null;   // Only set for the describer
let currentScores = {};
let isSpectator  = false;  // True if joined mid-game
let isPracticeMode = false; // True if in practice mode

// Save player data to localStorage
function savePlayerData() {
  if (myPlayerId) localStorage.setItem('taboo_player_id', myPlayerId);
  if (myRoomCode) localStorage.setItem('taboo_room_code', myRoomCode);
  if (myPlayerName) localStorage.setItem('taboo_player_name', myPlayerName);
}

// Clear room data (when leaving or room expires)
function clearRoomData() {
  myRoomCode = null;
  localStorage.removeItem('taboo_room_code');
}

// Generate DiceBear avatar URL from player name
function getAvatarUrl(name) {
  const seed = encodeURIComponent(name || 'player');
  return `https://api.dicebear.com/7.x/thumbs/svg?seed=${seed}`;
}

// ── 2. SCREEN MANAGEMENT ──────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
  } else {
    console.warn(`showScreen: screen "${id}" not found`);
  }
}

// ── 3. SERVER → CLIENT EVENTS ─────────────────────────────────

// Server accepted our create_room request
socket.on('room_created', ({ roomCode, roomState, playerId }) => {
  myPlayerId   = playerId;
  myRoomCode   = roomCode;
  myTeamName   = roomState.players[playerId]?.teamName || null;
  myPlayerName = roomState.players[playerId]?.name || null;
  isSpectator  = false;
  isPracticeMode = roomState.mode === 'practice';
  savePlayerData();

  updateRoomCodeBadges(roomCode);

  if (isPracticeMode) {
    // Practice mode: wait for practice_started event to show the screen
    document.getElementById('room-badge-practice').textContent = roomCode;
  } else {
    // Classic mode: go to lobby
    document.getElementById('lobby-room-code').textContent = roomCode;
    renderLobby(roomState);
    showScreen('screen-lobby');
  }
});

// Server accepted our join_room request
socket.on('room_joined', ({ roomState, playerId, isSpectator: joinedAsSpectator }) => {
  myPlayerId   = playerId;
  myRoomCode   = roomState.code;
  myTeamName   = roomState.players[playerId]?.teamName || null;
  myPlayerName = roomState.players[playerId]?.name || null;
  isSpectator  = joinedAsSpectator || false;
  savePlayerData();

  document.getElementById('lobby-room-code').textContent = roomState.code;
  updateRoomCodeBadges(roomState.code);

  if (isSpectator) {
    // Joined mid-game as spectator - show appropriate screen
    showToast('Te uniste como espectador. Podrás jugar en la próxima ronda.', 'info');
    // Navigate to the correct screen based on game state
    navigateToGameState(roomState);
  } else {
    renderLobby(roomState);
    showScreen('screen-lobby');
  }
});

// Server accepted our reconnection
socket.on('reconnect_success', ({ roomState, playerId }) => {
  myPlayerId   = playerId;
  myRoomCode   = roomState.code;
  myTeamName   = roomState.players[playerId]?.teamName || null;
  myPlayerName = roomState.players[playerId]?.name || null;
  isSpectator  = roomState.players[playerId]?.status === 'spectating';
  savePlayerData();

  updateRoomCodeBadges(roomState.code);
  showToast('¡Reconectado!', 'success');

  // Navigate to the correct screen based on game state
  navigateToGameState(roomState);
});

// Reconnection failed
socket.on('reconnect_failed', ({ reason }) => {
  clearRoomData();
  showToast('No se pudo reconectar. La sala ya no existe.', 'error');
  showScreen('screen-home');
});

// Host changed (host disconnected and was delegated)
socket.on('host_changed', ({ newHostName, newHostId }) => {
  showToast(`👑 ${newHostName} es ahora el anfitrión`, 'info');
});

// A spectator joined the room
socket.on('spectator_joined', ({ playerName, teamName }) => {
  showToast(`${playerName} se unió como espectador (${teamName})`, 'info');
});

// A spectator was activated (can now play)
socket.on('spectator_activated', ({ playerName }) => {
  if (playerName === myPlayerName) {
    isSpectator = false;
    showToast('¡Ya puedes jugar!', 'success');
  }
});

// Update all room code badge elements throughout the UI
function updateRoomCodeBadges(roomCode) {
  const code = roomCode || myRoomCode || '------';
  const badgeIds = [
    'room-badge-waiting',
    'room-badge-describer',
    'room-badge-observer',
    'room-badge-ended',
    'room-badge-gameover',
    'room-badge-practice'
  ];
  badgeIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = code;
  });
}

// Navigate to the correct screen based on current game state
function navigateToGameState(roomState) {
  document.getElementById('lobby-room-code').textContent = roomState.code;
  updateRoomCodeBadges(roomState.code);

  if (roomState.state === 'lobby') {
    renderLobby(roomState);
    showScreen('screen-lobby');
  } else if (roomState.state === 'game_over') {
    showScreen('screen-game-over');
  } else if (roomState.state === 'playing') {
    currentScores = roomState.scores || {};

    // Determine current describer from room state
    const activeTeamName = roomState.teamOrder[roomState.activeTeamIndex];
    const activeTeam = roomState.teams[activeTeamName];
    const describerPlayerId = activeTeam?.memberIds[activeTeam.describerIndex] || null;
    const describerPlayer = describerPlayerId ? roomState.players[describerPlayerId] : null;
    const describerName = describerPlayer?.name || '—';

    // Determine this player's role
    if (myPlayerId === describerPlayerId) {
      myRole = 'describer';
    } else if (myTeamName === activeTeamName) {
      myRole = 'guesser';
    } else {
      myRole = 'buzzer';
    }

    // Handle based on turn phase
    if (roomState.turnPhase === 'waiting_for_describer') {
      // Set up the waiting screen UI
      document.getElementById('wfd-active-team').textContent = activeTeamName;
      document.getElementById('wfd-describer-name').textContent = describerName;
      document.getElementById('wfd-describer-name-2').textContent = describerName;

      const readyBtn   = document.getElementById('btn-describer-ready');
      const waitingMsg = document.getElementById('wfd-wait-msg');

      if (myRole === 'describer') {
        readyBtn.classList.remove('hidden');
        waitingMsg.classList.add('hidden');
      } else {
        readyBtn.classList.add('hidden');
        waitingMsg.classList.remove('hidden');
      }

      renderScores(currentScores, activeTeamName);
      showScreen('screen-waiting-describer');
    } else if (roomState.turnPhase === 'turn_active') {
      // Player reconnected during active turn - show observer screen
      // They'll need to wait for the next turn to participate properly
      updatePlayerInfo();
      showScreen('screen-turn-observer');
    } else {
      // Default: show waiting screen
      showScreen('screen-waiting-describer');
    }
  }
}

// Another player joined or left; refresh the lobby view
// Also handles returning to lobby after "play again"
socket.on('room_updated', ({ roomState }) => {
  // If we're back in lobby state (e.g., after play_again), navigate to lobby screen
  if (roomState.state === 'lobby') {
    document.getElementById('lobby-room-code').textContent = roomState.code;
    updateRoomCodeBadges(roomState.code);
    renderLobby(roomState);
    showScreen('screen-lobby');
  } else {
    renderLobby(roomState);
  }
});

// Host started the game
socket.on('game_started', ({ roomState }) => {
  currentScores = roomState.scores || {};
  // We'll navigate to the correct screen when turn_started arrives
});

// A new turn is beginning — tells everyone the active team and describer
socket.on('turn_started', ({ activeTeam, describerName, describerPlayerId, turnNumber }) => {
  // Determine this player's role for the upcoming turn
  if (myPlayerId === describerPlayerId) {
    myRole = 'describer';
  } else if (myTeamName === activeTeam) {
    myRole = 'guesser';
  } else {
    myRole = 'buzzer';
  }

  // Update player info header with current role
  updatePlayerInfo();

  // Show the waiting screen while the describer gets ready
  document.getElementById('wfd-active-team').textContent = activeTeam;
  document.getElementById('wfd-describer-name').textContent = describerName;
  document.getElementById('wfd-describer-name-2').textContent = describerName;

  const readyBtn   = document.getElementById('btn-describer-ready');
  const waitingMsg = document.getElementById('wfd-wait-msg');

  if (myRole === 'describer') {
    readyBtn.classList.remove('hidden');
    waitingMsg.classList.add('hidden');
  } else {
    readyBtn.classList.add('hidden');
    waitingMsg.classList.remove('hidden');
  }

  // Clear the live feed from the previous turn
  document.getElementById('turn-live-feed').innerHTML = '';

  // Reset observer display for new turn — clear any stale card data
  const cardBack   = document.querySelector('#screen-turn-observer .card-back');
  const buzzerCard = document.getElementById('buzzer-card-display');
  const guesserMsg = document.getElementById('observer-guesser-msg');
  const buzzerMsg  = document.getElementById('observer-buzzer-msg');
  const buzzBtn    = document.getElementById('btn-buzz');

  // Clear buzzer card content from previous turn
  buzzerCard.classList.add('hidden');
  document.getElementById('buzzer-card-word').textContent = '—';
  document.getElementById('buzzer-taboo-words-list').innerHTML = '';

  // Reset to default state: card-back visible, buzzer card hidden
  cardBack.classList.remove('hidden');
  buzzBtn.classList.add('hidden');

  // Set ONLY the correct message visible based on role
  if (myRole === 'guesser') {
    // Guessers see "Adivina la palabra..."
    guesserMsg.classList.remove('hidden');
    buzzerMsg.classList.add('hidden');
  } else if (myRole === 'buzzer') {
    // Buzzers see "Escucha las palabras tabú..." until card is revealed
    guesserMsg.classList.add('hidden');
    buzzerMsg.classList.remove('hidden');
  } else {
    // Describer - hide both (they go to a different screen)
    guesserMsg.classList.add('hidden');
    buzzerMsg.classList.add('hidden');
  }

  renderScores(currentScores, activeTeam);
  showScreen('screen-waiting-describer');
});

// Server sends the card to describer AND buzzers (not guessers)
socket.on('card_revealed', ({ card }) => {
  currentCard = card;

  if (myRole === 'describer') {
    // Describer sees full card with action buttons
    renderCard(card);
    showScreen('screen-turn-describer');
  } else if (myRole === 'buzzer') {
    // Buzzer sees card to catch taboo words, with buzz button
    renderBuzzerCard(card);
    showScreen('screen-turn-observer');
  }
  // Guessers don't receive this event (server doesn't send to them)
});

// Timer tick from server — update both timer displays
socket.on('timer_tick', ({ secondsRemaining }) => {
  const timerDescriber = document.getElementById('timer-describer');
  const timerObserver  = document.getElementById('timer-observer');

  timerDescriber.textContent = secondsRemaining;
  timerObserver.textContent  = secondsRemaining;

  // Add urgent styling when time is running low
  const isUrgent = secondsRemaining <= 10;
  timerDescriber.classList.toggle('urgent', isUrgent);
  timerObserver.classList.toggle('urgent', isUrgent);
});

// Non-describer players transition to the observer screen when turn becomes active
socket.on('turn_active', ({ activeTeam }) => {
  if (myRole === 'describer') return; // Describer already on their screen
  if (myRole === 'buzzer') return; // Buzzers get their screen via card_revealed

  // Only guessers need this handler - they don't see the card
  // Explicitly set guesser view: show card-back with guesser message only
  const cardBack   = document.querySelector('#screen-turn-observer .card-back');
  const guesserMsg = document.getElementById('observer-guesser-msg');
  const buzzerMsg  = document.getElementById('observer-buzzer-msg');
  const buzzBtn    = document.getElementById('btn-buzz');
  const buzzerCard = document.getElementById('buzzer-card-display');

  // Show the card-back container (for guessers)
  cardBack.classList.remove('hidden');
  // Show ONLY the guesser message
  guesserMsg.classList.remove('hidden');
  buzzerMsg.classList.add('hidden');
  // Hide buzzer-specific elements
  buzzBtn.classList.add('hidden');
  buzzerCard.classList.add('hidden');

  showScreen('screen-turn-observer');
});

// A card was scored — update scores and show feedback
socket.on('card_scored', ({ cardId, result, scores, nextCard }) => {
  currentScores = scores;

  // Update scores in both timer-screen displays
  const activeTeam = getActiveTeam(); // We track this locally from turn_started
  renderScoresCompact(scores);

  // Add to live feed (visible to observers)
  addToLiveFeed(result, cardId);

  // If we're the describer and there's a next card, show it
  if (myRole === 'describer' && nextCard) {
    currentCard = nextCard;
    renderCard(nextCard);
    // Stay on screen-turn-describer (no screen change needed)
  }
});

// Turn timer hit 0 — show summary screen
socket.on('turn_ended', ({ scores, teamStats, nextTeam, nextDescriberName }) => {
  currentScores = scores;

  renderTurnSummary(scores, nextTeam, nextDescriberName);
  showScreen('screen-turn-ended');
  // Server will emit turn_started after the pause, transitioning us forward
});

// Game over!
socket.on('game_over', ({ finalScores, teamStats, playerStats, winner }) => {
  renderGameOver(finalScores, playerStats, winner);
  showScreen('screen-game-over');
});

// Background card generation status
socket.on('cards_generating', () => {
  showToast('Generando más cartas...', 'info');
});
socket.on('cards_ready', ({ totalCards }) => {
  showToast(`Cartas listas: ${totalCards} disponibles`, 'success');
});

// Server sent an error
socket.on('error', ({ code, message }) => {
  showToast(message, 'error');
  console.error(`Server error [${code}]: ${message}`);
});

// ── PRACTICE MODE EVENTS ─────────────────────────────────────

// Practice session started — show the first card
socket.on('practice_started', ({ card, stats }) => {
  isPracticeMode = true;
  currentCard = card;
  renderPracticeCard(card);
  updatePracticeStats(stats);
  showScreen('screen-practice');
});

// Next practice card received
socket.on('practice_card', ({ card, stats }) => {
  currentCard = card;
  renderPracticeCard(card);
  updatePracticeStats(stats);
});

// Practice session ended
socket.on('practice_ended', ({ stats }) => {
  currentCard = null;
  renderPracticeSummary(stats);
  showScreen('screen-practice-ended');
});

// ── 4. CLIENT → SERVER EVENTS ─────────────────────────────────

// --- Home screen ---

document.getElementById('btn-create-room').addEventListener('click', () => {
  const playerName = document.getElementById('player-name').value.trim();
  if (!playerName) return showToast('Escribe tu nombre', 'warning');
  // Get selected game mode
  const modeChoice = document.querySelector('input[name="game-mode"]:checked');
  const mode = modeChoice ? modeChoice.value : 'classic';
  socket.emit('create_room', { playerName, playerId: myPlayerId, mode });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
  const playerName = document.getElementById('player-name').value.trim();
  const roomCode   = document.getElementById('room-code-input').value.trim().toUpperCase();
  // Get selected team from radio buttons
  const teamChoice = document.querySelector('input[name="team-choice"]:checked');
  const teamName   = teamChoice ? teamChoice.value : null;

  if (!playerName) return showToast('Escribe tu nombre', 'warning');
  if (!roomCode)   return showToast('Escribe el código de la sala', 'warning');
  if (!teamName)   return showToast('Selecciona un equipo', 'warning');
  socket.emit('join_room', { playerName, teamName, roomCode, playerId: myPlayerId });
});

// Allow pressing Enter on the room code input to join
document.getElementById('room-code-input').addEventListener('keyup', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join-room').click();
});

// Auto-fill room code from URL query string (?room=XTBK92)
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('room')) {
  document.getElementById('room-code-input').value = urlParams.get('room').toUpperCase();
}

// --- Lobby screen ---

document.getElementById('btn-copy-code').addEventListener('click', () => {
  const code = document.getElementById('lobby-room-code').textContent;
  const shareUrl = `${window.location.origin}/?room=${code}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('¡Enlace copiado!', 'success');
  }).catch(() => {
    showToast(shareUrl, 'info'); // Fallback: show URL in toast
  });
});

document.getElementById('btn-start-game').addEventListener('click', () => {
  socket.emit('start_game', { roomCode: myRoomCode });
});

// --- Waiting for describer screen ---

document.getElementById('btn-describer-ready').addEventListener('click', () => {
  socket.emit('describer_ready', { roomCode: myRoomCode });
});

// --- Active turn (describer) ---

document.getElementById('btn-correct').addEventListener('click', () => {
  if (!currentCard) return;
  socket.emit('card_correct', { roomCode: myRoomCode, cardId: currentCard.id });
});

document.getElementById('btn-skip').addEventListener('click', () => {
  if (!currentCard) return;
  socket.emit('card_skip', { roomCode: myRoomCode, cardId: currentCard.id });
});

// --- Active turn (observers) ---

document.getElementById('btn-buzz').addEventListener('click', () => {
  socket.emit('card_buzz', { roomCode: myRoomCode });
});

// --- Game over screen ---

document.getElementById('btn-play-again').addEventListener('click', () => {
  socket.emit('play_again', { roomCode: myRoomCode });
});

// --- Practice mode ---

document.getElementById('btn-practice-correct').addEventListener('click', () => {
  if (!currentCard) return;
  socket.emit('card_correct', { roomCode: myRoomCode, cardId: currentCard.id });
});

document.getElementById('btn-practice-skip').addEventListener('click', () => {
  if (!currentCard) return;
  socket.emit('card_skip', { roomCode: myRoomCode, cardId: currentCard.id });
});

document.getElementById('btn-end-practice').addEventListener('click', () => {
  socket.emit('end_practice', { roomCode: myRoomCode });
});

document.getElementById('btn-restart-practice').addEventListener('click', () => {
  socket.emit('restart_practice', { roomCode: myRoomCode });
});

document.getElementById('btn-exit-practice').addEventListener('click', () => {
  // Clear room data and go back to home
  clearRoomData();
  isPracticeMode = false;
  showScreen('screen-home');
});

// ── 5. RENDER HELPERS ─────────────────────────────────────────

// Render the lobby: list of fixed teams and their players
function renderLobby(roomState) {
  const teamList   = document.getElementById('team-list');
  const startBtn   = document.getElementById('btn-start-game');
  const statusMsg  = document.getElementById('lobby-status');

  // Use the fixed teams from roomState.teams (always Equipo A and Equipo B)
  const teams = roomState.teams || {};

  // Render both fixed teams, even if empty
  teamList.innerHTML = Object.entries(teams).map(([teamName, teamData]) => {
    const members = teamData.memberIds
      .map(id => roomState.players[id])
      .filter(Boolean);
    const memberCount = members.length;
    const memberHtml = members.length > 0
      ? members.map(m => {
          const hostMark = m.isHost ? ' is-host' : '';
          const avatarUrl = getAvatarUrl(m.name);
          return `<span class="player-chip${hostMark}">
            <img src="${avatarUrl}" class="player-avatar-small" alt="">
            <span class="player-name">${escapeHtml(m.name)}</span>
          </span>`;
        }).join('')
      : '<span class="hint">Sin jugadores</span>';

    const needsMore = memberCount < 2;
    const statusClass = needsMore ? ' needs-players' : '';

    return `
      <div class="team-block${statusClass}">
        <h3>${escapeHtml(teamName)} <span class="player-count">(${memberCount}/6)</span></h3>
        <div>${memberHtml}</div>
        ${needsMore ? '<p class="team-hint">Necesita ' + (2 - memberCount) + ' jugador(es) más</p>' : ''}
      </div>`;
  }).join('');

  // Check if game can start: both teams need at least 2 players
  const amHost = roomState.players[myPlayerId]?.isHost;
  const teamCounts = Object.values(teams).map(t => t.memberIds.length);
  const canStart = teamCounts.every(count => count >= 2);

  if (amHost) {
    startBtn.classList.toggle('hidden', !canStart);
    if (canStart) {
      statusMsg.textContent = '¡Puedes iniciar el juego!';
    } else {
      const needed = teamCounts.map((c, i) => Math.max(0, 2 - c));
      const totalNeeded = needed.reduce((a, b) => a + b, 0);
      statusMsg.textContent = `Faltan ${totalNeeded} jugador(es) para iniciar`;
    }
  } else {
    startBtn.classList.add('hidden');
    statusMsg.textContent = 'Esperando que el anfitrión inicie el juego...';
  }
}

// Render the Taboo card for the describer
function renderCard(card) {
  document.getElementById('card-word').textContent = card.word;

  const listEl = document.getElementById('taboo-words-list');
  listEl.innerHTML = card.tabooWords.map(w => `<li>${escapeHtml(w)}</li>`).join('');
}

// Render the Taboo card for buzzers (they see the card to catch taboo words)
function renderBuzzerCard(card) {
  document.getElementById('buzzer-card-word').textContent = card.word;

  const listEl = document.getElementById('buzzer-taboo-words-list');
  listEl.innerHTML = card.tabooWords.map(w => `<li>${escapeHtml(w)}</li>`).join('');

  // Buzzer view: hide card-back (with messages), show buzzer card
  const cardBack   = document.querySelector('#screen-turn-observer .card-back');
  const buzzerCard = document.getElementById('buzzer-card-display');
  const buzzBtn    = document.getElementById('btn-buzz');

  // Hide the card-back container entirely (hides both messages)
  cardBack.classList.add('hidden');
  // Show the buzzer card and button
  buzzerCard.classList.remove('hidden');
  buzzBtn.classList.remove('hidden');
}

// Render the Taboo card for practice mode
function renderPracticeCard(card) {
  document.getElementById('practice-card-word').textContent = card.word;

  const listEl = document.getElementById('practice-taboo-words-list');
  listEl.innerHTML = card.tabooWords.map(w => `<li>${escapeHtml(w)}</li>`).join('');
}

// Update practice stats display
function updatePracticeStats(stats) {
  document.getElementById('practice-viewed').textContent = stats.cardsViewed || 0;
  document.getElementById('practice-correct').textContent = stats.cardsCorrect || 0;
  document.getElementById('practice-skipped').textContent = stats.cardsSkipped || 0;
}

// Render practice session summary
function renderPracticeSummary(stats) {
  document.getElementById('summary-viewed').textContent = stats.cardsViewed || 0;
  document.getElementById('summary-correct').textContent = stats.cardsCorrect || 0;
  document.getElementById('summary-skipped').textContent = stats.cardsSkipped || 0;
}

// Render scores as chips (full version: waiting screen)
function renderScores(scores, activeTeam = null) {
  const bar = document.getElementById('scores-waiting');
  if (!bar) return;
  bar.innerHTML = Object.entries(scores).map(([team, score]) => {
    const isActive = team === activeTeam ? ' active-team' : '';
    return `<div class="score-chip${isActive}">
      <span>${escapeHtml(team)}</span>
      <span class="score-num">${score}</span>
    </div>`;
  }).join('');
}

// Render compact scores (inside turn headers)
function renderScoresCompact(scores) {
  ['scores-describer', 'scores-observer'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = Object.entries(scores).map(([team, score]) =>
      `<span class="score-chip">${escapeHtml(team)}: <strong>${score}</strong></span>`
    ).join('');
  });
}

// Add a card result to the live feed (observer screen)
function addToLiveFeed(result, cardId) {
  const feed = document.getElementById('turn-live-feed');
  if (!feed) return;
  const icons = { correct: '✓', buzz: '✗', skip: '→' };
  const labels = { correct: 'Correcto (+1)', buzz: '¡Tabú! (−1)', skip: 'Pasada (0)' };
  const item = document.createElement('div');
  item.className = `feed-item ${result}`;
  item.textContent = `${icons[result]} ${labels[result]}`;
  feed.insertBefore(item, feed.firstChild); // Newest at top
}

// Render the turn summary screen
function renderTurnSummary(scores, nextTeam, nextDescriberName) {
  const container = document.getElementById('turn-summary-scores');

  // Sort by score descending
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const leadScore = sorted[0]?.[1] ?? 0;

  container.innerHTML = sorted.map(([team, score]) => {
    const isLeading = score === leadScore ? ' leading' : '';
    return `<div class="score-row${isLeading}">
      <span class="team-label">${escapeHtml(team)}</span>
      <span class="team-score">${score}</span>
    </div>`;
  }).join('');

  document.getElementById('next-team-name').textContent      = nextTeam || '—';
  document.getElementById('next-describer-name').textContent = nextDescriberName || '—';
}

// Render the game over screen with podium and stats
function renderGameOver(finalScores, playerStats, winner) {
  const podium = document.getElementById('final-podium');

  // Sort teams by score
  const sorted = Object.entries(finalScores).sort((a, b) => b[1] - a[1]);
  const medals = ['🥇', '🥈', '🥉'];

  podium.innerHTML = sorted.map(([team, score], i) => `
    <div class="podium-entry">
      <span class="podium-rank">${medals[i] || (i + 1)}</span>
      <span class="podium-team">${escapeHtml(team)}</span>
      <span class="podium-score">${score}</span>
    </div>`).join('');

  // Winner banner
  const banner = document.getElementById('winner-banner');
  if (winner === 'tie') {
    banner.textContent = '¡Empate!';
  } else {
    banner.textContent = `¡Gana ${escapeHtml(winner)}! 🎉`;
  }

  // Player stats
  const statsEl = document.getElementById('player-stats');
  if (playerStats && Object.keys(playerStats).length > 0) {
    statsEl.innerHTML = Object.entries(playerStats).map(([name, stats]) => `
      <div class="stat-row">
        <span class="stat-player">
          <img src="${getAvatarUrl(name)}" class="player-avatar-small" alt="">
          ${escapeHtml(name)}
        </span>
        <span class="stat-values">Describió: ${stats.described || 0} · Adivinó: ${stats.guessed || 0}</span>
      </div>`).join('');
  } else {
    statsEl.textContent = 'Sin estadísticas disponibles';
  }

  // Show "Play again" to the host
  // We assume host can always replay (server validates on play_again)
  document.getElementById('btn-play-again').classList.remove('hidden');
}

// Update player info header during game (shows name, avatar, and role)
function updatePlayerInfo() {
  const roleLabels = {
    describer: 'Describiendo',
    guesser: 'Adivinando',
    buzzer: 'Vigilando'
  };

  // Update describer screen
  document.getElementById('player-name-describer').textContent = myPlayerName || '—';
  document.getElementById('avatar-describer').src = getAvatarUrl(myPlayerName);

  // Update observer screen
  document.getElementById('player-name-observer').textContent = myPlayerName || '—';
  document.getElementById('avatar-observer').src = getAvatarUrl(myPlayerName);

  const roleBadge = document.getElementById('role-badge-observer');
  roleBadge.textContent = roleLabels[myRole] || '—';
  roleBadge.className = `role-badge ${myRole || ''}`;
}

// ── 6. UTILITY FUNCTIONS ──────────────────────────────────────

// Show a temporary toast notification
// type: 'error' | 'success' | 'warning' | 'info'
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Remove after animation completes (3 seconds)
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

// Escape HTML special characters to prevent XSS
// Always use this when inserting user-provided strings into innerHTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Helper: find the active team name from current scores context
// This is used locally since the server sends it with each event
let _activeTeam = null;
function getActiveTeam() { return _activeTeam; }
socket.on('turn_started', ({ activeTeam }) => { _activeTeam = activeTeam; });

// ── 7. TUTORIAL ──────────────────────────────────────────────────

const TUTORIAL_SEEN_KEY = 'taboo_tutorial_seen';
let currentTutorialSlide = 0;
const totalTutorialSlides = 5;

function showTutorial() {
  currentTutorialSlide = 0;
  updateTutorialSlide();
  document.getElementById('tutorial-modal').classList.remove('hidden');
}

function hideTutorial() {
  document.getElementById('tutorial-modal').classList.add('hidden');
  localStorage.setItem(TUTORIAL_SEEN_KEY, 'true');
}

function updateTutorialSlide() {
  // Update slides
  document.querySelectorAll('.tutorial-slide').forEach((slide, i) => {
    slide.classList.toggle('active', i === currentTutorialSlide);
  });

  // Update dots
  document.querySelectorAll('.tutorial-dots .dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === currentTutorialSlide);
  });

  // Update buttons
  const prevBtn = document.getElementById('btn-tutorial-prev');
  const nextBtn = document.getElementById('btn-tutorial-next');

  prevBtn.style.visibility = currentTutorialSlide === 0 ? 'hidden' : 'visible';

  if (currentTutorialSlide === totalTutorialSlides - 1) {
    nextBtn.textContent = '¡Entendido!';
    nextBtn.classList.remove('btn-ghost');
    nextBtn.classList.add('btn-primary');
  } else {
    nextBtn.textContent = 'Siguiente →';
    nextBtn.classList.remove('btn-ghost');
    nextBtn.classList.add('btn-primary');
  }
}

function nextTutorialSlide() {
  if (currentTutorialSlide < totalTutorialSlides - 1) {
    currentTutorialSlide++;
    updateTutorialSlide();
  } else {
    hideTutorial();
  }
}

function prevTutorialSlide() {
  if (currentTutorialSlide > 0) {
    currentTutorialSlide--;
    updateTutorialSlide();
  }
}

function goToTutorialSlide(index) {
  if (index >= 0 && index < totalTutorialSlides) {
    currentTutorialSlide = index;
    updateTutorialSlide();
  }
}

// Tutorial event listeners
document.getElementById('btn-help-home')?.addEventListener('click', showTutorial);
document.getElementById('btn-help-lobby')?.addEventListener('click', showTutorial);
document.getElementById('btn-tutorial-close')?.addEventListener('click', hideTutorial);
document.getElementById('btn-tutorial-next')?.addEventListener('click', nextTutorialSlide);
document.getElementById('btn-tutorial-prev')?.addEventListener('click', prevTutorialSlide);

// Click on overlay to close
document.querySelector('.modal-overlay')?.addEventListener('click', hideTutorial);

// Dot navigation
document.querySelectorAll('.tutorial-dots .dot').forEach(dot => {
  dot.addEventListener('click', () => {
    const slideIndex = parseInt(dot.dataset.slide, 10);
    goToTutorialSlide(slideIndex);
  });
});

// Auto-show tutorial on first visit
if (!localStorage.getItem(TUTORIAL_SEEN_KEY)) {
  // Small delay to ensure page is fully loaded
  setTimeout(showTutorial, 300);
}

// ── 8. AUTO-RECONNECTION ──────────────────────────────────────

// Pre-fill player name from localStorage
if (myPlayerName) {
  document.getElementById('player-name').value = myPlayerName;
}

// Save player name when it changes
document.getElementById('player-name').addEventListener('change', (e) => {
  myPlayerName = e.target.value.trim();
  if (myPlayerName) {
    localStorage.setItem('taboo_player_name', myPlayerName);
  }
});

// Update hint text when game mode changes
document.querySelectorAll('input[name="game-mode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const hint = document.getElementById('create-room-hint');
    if (e.target.value === 'practice') {
      hint.textContent = 'Practica solo, sin timer';
    } else {
      hint.textContent = 'Serás asignado al Equipo A';
    }
  });
});

// Attempt to reconnect to a room if we have stored room data
function attemptReconnect() {
  const storedRoomCode = localStorage.getItem('taboo_room_code');
  const storedPlayerId = localStorage.getItem('taboo_player_id');
  const storedPlayerName = localStorage.getItem('taboo_player_name');

  if (storedRoomCode && storedPlayerId && storedPlayerName) {
    console.log(`Attempting to reconnect to room ${storedRoomCode}...`);
    socket.emit('reconnect_room', {
      roomCode: storedRoomCode,
      playerId: storedPlayerId,
      playerName: storedPlayerName
    });
  }
}

// On socket connect, attempt to reconnect to previous room
socket.on('connect', () => {
  // Small delay to let the socket stabilize
  setTimeout(attemptReconnect, 100);
});
