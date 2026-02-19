# New Feature — Spec-Driven Development Workflow

Add a new feature to the Taboo game using Spec-Driven Development.
This workflow ensures features are specified and approved BEFORE any code is written.

## Philosophy

> Code without a spec is a guess. A spec without code is a dream.

Update `SPEC.md` first. Get user approval. Then write code. Always in this order.

---

## Workflow

### Step 1: Understand the Request
Ask clarifying questions until you can clearly answer all of these:
- What is the user-visible behavior change?
- Which game states/phases are affected?
  - lobby, playing, game_over, waiting_for_describer, turn_active, turn_ended
- What new Socket.io events are needed? (client→server AND server→client)
- What new UI elements are needed?
- What are the edge cases?
- What happens if a player disconnects during this feature?

### Step 2: Review Existing Spec
Read `SPEC.md` carefully:
- Does this feature conflict with any existing rule?
- Does any existing spec section already partially cover this?
- Which state machine transitions are affected?

### Step 3: Write the Spec Update
Draft additions to `SPEC.md` (do NOT edit SPEC.md yet — just show the draft):

The draft should include:
1. Feature description in plain language (what a new player would understand)
2. Any new game rules or modifications to existing rules
3. New Socket.io events:
   - Client → Server: `event_name { payload }`
   - Server → Client: `event_name { payload }` → sent to whom
4. New config constants (if any) → add to `server/config.js`
5. Edge cases and error conditions
6. What happens to the UI (which screens are affected)

**Present the spec draft to the user and say:**
> "Here is the spec I propose to add to SPEC.md. Should I proceed with implementation, or would you like to change anything?"

**Wait for explicit approval before writing any code.**

### Step 4: Update SPEC.md
After the user approves the spec draft, update `SPEC.md` with the new content.

### Step 5: Plan the Implementation
Identify exactly which files need changes and what changes each requires:

| File | What changes |
|------|-------------|
| `server/config.js` | New constants |
| `server/gameRoom.js` | New state/methods/validation |
| `server/index.js` | New socket event handlers |
| `client/index.html` | New HTML elements (if any) |
| `client/style.css` | New styles (if any) |
| `client/game.js` | New socket listeners + UI handlers |

List the planned changes before making them. The user can adjust.

### Step 6: Implement in Order
Always implement in this order (server first, then client):
1. `server/config.js` — new constants
2. `server/gameRoom.js` — game logic
3. `server/index.js` — socket event wiring
4. `client/index.html` — new HTML elements
5. `client/style.css` — new styles
6. `client/game.js` — client event handling

### Step 7: Test Checklist
After implementation, provide this checklist to the user:

```
Test Checklist for [Feature Name]:
[ ] Happy path: [describe the expected normal flow]
[ ] Edge case: What if a player disconnects mid-feature?
[ ] Edge case: What if the feature is triggered at the wrong game phase?
[ ] Mobile: Does it work on a narrow screen (360px)?
[ ] Two browsers: Test with two browser tabs open simultaneously
```

### Step 8: Update CLAUDE.md (if needed)
If this feature adds a new architectural pattern, key constraint, or important decision,
add it to the "Key Architectural Decisions" section of `CLAUDE.md`.

---

## Example Usage

**User:** "I want a feature where players can vote to extend the timer by 15 seconds"

**You should:**
1. Ask: How many votes needed? Can each player only vote once? Does the extension stack?
2. Draft spec additions: "Timer Extension Vote" section + new Socket.io events
3. Present spec to user and wait for approval
4. Update SPEC.md
5. Plan: new config constant `TIMER_EXTENSION_SECONDS`, new vote tracking in gameRoom.js, etc.
6. Implement in order
7. Provide test checklist

---

## Key Rules

- NEVER write code before the spec is approved
- NEVER skip the spec update step
- ALWAYS implement server-side logic before client-side display
- ALWAYS keep game rules on the server (gameRoom.js), not the client
- ALWAYS test with two browser windows simultaneously to catch real-time sync issues
