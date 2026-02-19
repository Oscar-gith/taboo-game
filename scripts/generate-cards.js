// ============================================================
// generate-cards.js — Standalone card generation script
//
// Run with: npm run generate-cards
//
// This generates Spanish Taboo cards using the Google Gemini API
// and saves them to data/cards-seed.json for the game to use.
// ============================================================

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { generateCards } = require('../server/cardGenerator');

const OUTPUT_FILE = path.join(__dirname, '../data/cards-seed.json');
const COUNT       = parseInt(process.argv[2] || '50', 10);

async function main() {
  console.log(`\nGenerating ${COUNT} Spanish Taboo cards via Google Gemini API...`);
  console.log('This may take ~10-20 seconds.\n');

  let existing = [];

  // Load existing cards to avoid duplicates
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      console.log(`Found ${existing.length} existing cards. New cards will be merged in.`);
    } catch {
      console.warn('Could not read existing cards file — starting fresh.');
    }
  }

  let cards;
  try {
    cards = await generateCards(COUNT);
  } catch (err) {
    console.error('\n❌ Card generation failed:', err.message);
    if (err.message.includes('GOOGLE_API_KEY')) {
      console.error('\nTo fix: copy .env.example to .env and add your Google API key.');
      console.error('Get a key at: https://aistudio.google.com/apikey\n');
    }
    process.exit(1);
  }

  // Merge new cards with existing, deduplicating by word
  const existingWords = new Set(existing.map(c => c.word.toUpperCase()));
  const newUnique = cards.filter(c => !existingWords.has(c.word.toUpperCase()));
  const merged = [...existing, ...newUnique];

  // Ensure the data directory exists
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  // Write to disk
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf8');

  console.log(`\n✓ Generated ${cards.length} cards (${newUnique.length} new, ${cards.length - newUnique.length} duplicates skipped)`);
  console.log(`✓ Total deck size: ${merged.length} cards`);
  console.log(`✓ Saved to: ${OUTPUT_FILE}\n`);

  // Show a sample
  console.log('Sample cards:');
  newUnique.slice(0, 3).forEach(c => {
    console.log(`  ${c.word} [${c.difficulty}] — Tabú: ${c.tabooWords.join(', ')}`);
  });
  console.log('');
}

main();
