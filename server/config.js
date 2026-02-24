// All game constants live here. Never use magic numbers anywhere else.
// Change values here to tune game balance and server behavior.

module.exports = {
  // Game modes
  GAME_MODES: ['classic', 'practice'],

  // Turn timing
  TURN_DURATION_SECONDS: 60,
  TURN_END_PAUSE_MS: 3000,        // Pause between turns so players can see the summary

  // Teams — fixed team names, no custom teams allowed
  TEAM_NAMES: ['Equipo A', 'Equipo B'],
  MIN_PLAYERS_PER_TEAM: 2,        // Minimum players per team to start game
  MAX_PLAYERS_PER_TEAM: 6,        // Maximum players per team

  // Scoring
  DEFAULT_SCORE_LIMIT: 15,        // Points to win in Score Limit mode

  // Card deck management
  LOW_DECK_THRESHOLD: 10,         // Below this count, trigger background card generation
  CARDS_PER_GENERATION: 20,       // How many cards to request per API call

  // Room lifecycle
  ROOM_CODE_LENGTH: 6,
  // Characters for room codes: exclude I/O (look like 1/0) and 0/1 (look like O/I)
  ROOM_CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  ROOM_EXPIRY_MS: 60 * 60 * 1000,   // 1 hour of inactivity before a room is destroyed
  RECONNECT_GRACE_MS: 60 * 1000,    // 60 seconds to reconnect before being removed

  // Gemini model for card generation (free tier available)
  CARD_GENERATION_MODEL: 'gemini-2.0-flash',
};
