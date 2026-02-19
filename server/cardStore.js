// ============================================================
// CardStore — In-memory deck management
//
// Loads the seed deck from disk on startup.
// All active game rooms draw from this shared store.
// When the deck runs low, triggers background generation.
// ============================================================

const fs     = require('fs');
const path   = require('path');
const config = require('./config');
const { generateCards } = require('./cardGenerator');

const SEED_FILE = path.join(__dirname, '../data/cards-seed.json');

class CardStore {
  constructor() {
    // The master list of all available cards
    this.cards = [];
    this._generating = false;

    this._loadSeedCards();
  }

  // Load the pre-generated seed deck from disk
  _loadSeedCards() {
    if (!fs.existsSync(SEED_FILE)) {
      console.warn(`Seed file not found at ${SEED_FILE}. Run "npm run generate-cards" to create it.`);
      return;
    }
    try {
      const raw   = fs.readFileSync(SEED_FILE, 'utf8');
      this.cards  = JSON.parse(raw);
      console.log(`CardStore: Loaded ${this.cards.length} cards from seed file.`);
    } catch (err) {
      console.error('CardStore: Failed to load seed file:', err.message);
    }
  }

  // Get a shuffled copy of all cards — used when starting a new game
  getShuffledDeck() {
    const deck = [...this.cards];
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // Total number of cards available
  get count() { return this.cards.length; }

  // Check if we're running low and trigger background generation if so
  checkAndRefill(onRefillComplete) {
    if (this.cards.length <= config.LOW_DECK_THRESHOLD && !this._generating) {
      this._generateInBackground(onRefillComplete);
    }
  }

  // Generate new cards in the background without blocking game play
  async _generateInBackground(onComplete) {
    this._generating = true;
    try {
      console.log('CardStore: Deck running low — generating more cards in background...');
      const newCards = await generateCards(config.CARDS_PER_GENERATION);
      this._mergeCards(newCards);
      console.log(`CardStore: Added ${newCards.length} new cards. Total: ${this.cards.length}`);
      if (typeof onComplete === 'function') onComplete(this.cards.length);
    } catch (err) {
      console.error('CardStore: Background generation failed:', err.message);
    } finally {
      this._generating = false;
    }
  }

  // Add new cards, avoiding duplicates by word
  _mergeCards(newCards) {
    const existingWords = new Set(this.cards.map(c => c.word.toUpperCase()));
    const unique = newCards.filter(c => !existingWords.has(c.word.toUpperCase()));
    this.cards.push(...unique);
  }
}

module.exports = CardStore;
