# Taboo Game — Project Specification

> **This is the source of truth.** When in doubt about game behavior, consult this file first.
> Before writing code for any new feature, update this spec and get it reviewed.

---

## Overview

A real-time online multiplayer Taboo card game played in Spanish. Players join a shared room via a 6-character code, form teams, and take turns describing Spanish words without saying the word or its 5 "taboo" words. Cards are generated dynamically by the Google Gemini API.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Plain HTML, CSS, JavaScript (no frameworks, no build tools) |
| Backend | Node.js + Express + Socket.io |
| Card Generation | Google Gemini API (`gemini-2.0-flash`), server-side only, free tier |
| Language | All game cards and UI are in Spanish |
| Auth | None — players use a display nickname only |

---

## Classic Taboo Rules

### Setup
- Exactly **2 fixed teams**: **Equipo A** and **Equipo B**
- Minimum **2 players per team** (4 total to start)
- Maximum **6 players per team** (12 total)
- One player is the **HOST** (room creator); always assigned to Equipo A
- Host can start the game when both teams have ≥2 players
- New players joining select which team to join (if team is full, must join the other)

### Turn Structure
1. The **active team** has one player designated as the **DESCRIBER** (rotates each turn)
2. Describer clicks **"¡Estoy listo!"** to start the 60-second countdown
3. A Taboo card is revealed to the **DESCRIBER** and **BUZZERS** (opposing team)
   - GUESSERS (same team as describer) do NOT see the card
4. Describer gives verbal clues to their teammates (**GUESSERS**)
5. All players on opposing teams are **BUZZERS** — they see the card to catch violations
6. When the team guesses correctly → active team clicks **"✓ Correcto"** (+1 point)
7. If the describer says a taboo word → opposing team clicks **"¡Tabú!"** (-1 point, card discarded)
8. Describer can click **"→ Pasar"** to skip a card (0 points, card removed from deck)
9. When timer hits 0 → turn ends, play passes to the next team

### Forbidden for the Describer
- Cannot say the main word or any variation (plurals, verb conjugations, diminutives)
- Cannot say any of the 5 taboo words
- Cannot spell the word or individual letters
- Cannot say "starts with...", "rhymes with...", "sounds like..."
- Cannot use gestures (honor system — this is a party game)
- Cannot say a word in another language to bypass taboo restrictions

### Scoring
| Event | Points |
|---|---|
| Correct guess | **+1** to active team |
| Taboo word used | **−1** to active team |
| Skip | **0** (card removed) |

Note: Buzzers (opposing teams) do NOT get points for catching violations.

### Individual Stats (tracked for fun, do not affect team score)
- Cards described correctly (per describer)
- Cards guessed (per guesser — everyone on team gets credit on a correct guess)

### Win Conditions (host configures before game start)

**Score Limit Mode** (default):
- First team to reach **15 points** wins
- Game ends immediately when the threshold is crossed

**Deck Mode**:
- Game ends when all cards in the deck are exhausted
- Highest team score wins
- On a tie: one sudden-death extra card (first team to score wins)

---

## State Machine

### Room States

```
LOBBY
  └─→ PLAYING       (host clicks start; requires ≥2 players per team, deck available)
        └─→ GAME_OVER   (score limit reached OR deck exhausted)
              └─→ LOBBY  (host clicks "Jugar de nuevo"; scores reset, teams preserved)
```

### Turn Phases (within PLAYING state)

```
WAITING_FOR_DESCRIBER
  └─→ TURN_ACTIVE          (describer clicks ready; 60s timer starts server-side)
        ├─→ TURN_ACTIVE     (card scored/skipped/buzzed; next card drawn)
        ├─→ GAME_OVER       (deck exhausted mid-turn, or score limit hit)
        └─→ TURN_ENDED      (timer hits 0)
              └─→ WAITING_FOR_DESCRIBER  (after 3s pause; next team's turn)
```

### Role Assignment

Each turn:
- **DESCRIBER**: next player in rotation from the active team
- **GUESSERS**: remaining players on the active team
- **BUZZERS**: all players on non-active teams

Team rotation: round-robin (Team A → Team B → Team C → Team A...)
Describer rotation: cycles through team members before repeating

---

## Socket.io Event Definitions

### Client → Server

```
create_room      { playerName }
                 // Host is auto-assigned to "Equipo A"
join_room        { roomCode, playerName, teamName }
                 // teamName must be "Equipo A" or "Equipo B"
                 // Server rejects if chosen team is full (6 players)
start_game       { roomCode }                    [host only]
describer_ready  { roomCode }                    [describer only]
card_correct     { roomCode, cardId }            [active team only]
card_buzz        { roomCode, cardId }            [opposing team only]
card_skip        { roomCode, cardId }            [describer only]
leave_room       { roomCode }
```

### Server → Client

```
room_created     { roomCode, roomState }                  → creating player
room_joined      { roomState }                            → joining player
room_updated     { roomState }                            → all players in room
game_started     { roomState }                            → all players in room
turn_started     { activeTeam, describerName, turnNumber } → all players in room
card_revealed    { card }                                 → DESCRIBER + BUZZERS (not guessers)
timer_tick       { secondsRemaining }                     → all players in room
card_scored      { cardId, result, scores, teamStats }    → all players in room
                 result: 'correct' | 'buzz' | 'skip'
turn_ended       { scores, teamStats, nextTeam, nextDescriberName } → all
game_over        { finalScores, teamStats, playerStats, winner }    → all
                 winner: team name string | 'tie'
error            { code, message }                        → requesting player
cards_generating { }                                      → all players in room
cards_ready      { totalCards }                           → all players in room
```

---

## Card Format

```json
{
  "id": "string (uuid v4)",
  "word": "string (UPPERCASE, Spanish noun or concept)",
  "tabooWords": ["string x5 (Spanish, lowercase)"],
  "category": "string (e.g. naturaleza, tecnología, comida, deportes, cultura)",
  "difficulty": "easy | medium | hard"
}
```

---

## Player Avatars

- Each player is assigned a unique avatar generated via DiceBear API
- Avatar URL: `https://api.dicebear.com/7.x/thumbs/svg?seed=[playerName]`
- Avatars appear in: lobby, score displays, game over screen
- No server-side storage needed — generated client-side from player name

---

## Tutorial

An interactive tutorial explains the game rules to new players.

### Trigger Conditions
- **First visit**: Automatically shown if `localStorage.getItem('taboo_tutorial_seen')` is `null`
- **Help button**: A "?" button on home and lobby screens opens the tutorial manually
- On completion or close: `localStorage.setItem('taboo_tutorial_seen', 'true')`

### Format
- Full-screen modal with dark overlay
- 5 slides with navigation (Previous / Next buttons)
- Progress indicators (dots: ● ○ ○ ○ ○)
- Close button (✕) available on all slides

### Tutorial Content

| Slide | Title | Content |
|-------|-------|---------|
| 1 | ¡Bienvenido a Taboo! | El objetivo es que tu equipo adivine la palabra secreta |
| 2 | Roles | **Descriptor**: da pistas. **Adivinadores**: adivinan. **Vigilantes**: cazan palabras prohibidas |
| 3 | Palabras Prohibidas | No puedes decir la palabra principal ni las 5 palabras prohibidas listadas |
| 4 | Puntuación | ✓ Correcto: +1 punto. ¡Prohibida!: -1 punto. Pasar: 0 puntos |
| 5 | ¡A jugar! | Crea una sala o únete con un código de 6 letras |

### UI Elements
- Help button "?" visible on: `#screen-home`, `#screen-lobby`
- Modal: `#tutorial-modal` (hidden by default)
- No server-side changes required (100% client-side feature)

---

## Room Code System

- 6-character uppercase alphanumeric string (e.g. `XTBK92`)
- Characters: `A-Z` (excluding `I`, `O`) and `2-9` (excluding `0`, `1`) to avoid confusion
- Generated server-side on room creation; guaranteed unique among active rooms
- Players can join via URL query string: `/?room=XTBK92` (auto-fills the input)
- Rooms expire after **1 hour of inactivity**

---

## Reconnection Behavior

- Each player has a persistent `playerId` (UUID) stored in `sessionStorage`
- If a player disconnects during their **describer turn**, their turn ends immediately
- Player has **60 seconds** to reconnect before being removed from the room
- On reconnect: player rejoins their team; play resumes on the next turn

---

## Error Codes

| Code | When |
|---|---|
| `ROOM_NOT_FOUND` | `join_room` with invalid code |
| `GAME_ALREADY_STARTED` | `join_room` after game began |
| `TEAM_FULL` | `join_room` when selected team has 6 players |
| `INVALID_TEAM` | `join_room` with team name other than "Equipo A"/"Equipo B" |
| `NOT_YOUR_TURN` | Attempting an action when it's not your turn |
| `NOT_HOST` | Non-host attempts `start_game` |
| `NEED_MORE_PLAYERS` | `start_game` when any team has <2 players |
| `DECK_EMPTY` | Card draw attempted with no cards remaining |
| `CARD_API_FAILED` | Gemini API call failed during card generation |

---

## Configuration Constants (server/config.js)

| Constant | Default | Description |
|---|---|---|
| `TURN_DURATION_SECONDS` | 60 | Seconds per describer turn |
| `TEAM_NAMES` | `['Equipo A', 'Equipo B']` | Fixed team names |
| `MIN_PLAYERS_PER_TEAM` | 2 | Minimum players per team to start |
| `MAX_PLAYERS_PER_TEAM` | 6 | Maximum players per team |
| `DEFAULT_SCORE_LIMIT` | 15 | Points to win in Score Limit mode |
| `LOW_DECK_THRESHOLD` | 10 | Triggers background card generation |
| `CARDS_PER_GENERATION` | 20 | Cards requested per API call |
| `ROOM_EXPIRY_MS` | 3,600,000 | 1 hour inactivity expiry |
| `RECONNECT_GRACE_MS` | 60,000 | Grace period to reconnect |
| `TURN_END_PAUSE_MS` | 3,000 | Pause between turns |

---

## End-of-Game Screen

Shows (ranked by score):
1. Team name + final score
2. Winner announcement: "¡Gana el equipo [X]!" or "¡Empate!"
3. Individual stats per player:
   - Cards described correctly (as describer)
   - Cards guessed (as guesser, all active team members credited on each correct)
4. "Jugar de nuevo" button → resets scores, keeps teams, returns to lobby

---

## Out of Scope for v1

- Persistent user accounts or cross-session history
- In-game chat or voice communication (players use external calls)
- Custom card creation by players
- Card reporting or moderation
- Mobile native app (web only, mobile-responsive)
- Spectator mode
- Private team chat for guessers
