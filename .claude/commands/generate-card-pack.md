# Generate Spanish Taboo Card Pack

Generate a new pack of Spanish Taboo cards using the Google Gemini API and save them
to `data/cards-seed.json`. Use this when you want to refresh or expand the card deck.

## When to Use This Skill
- The card deck needs more cards (below 50 is considered low)
- You want cards for a specific theme or category
- Running `npm run generate-cards` before the first game start

## Steps

### Step 1: Check the current deck
Read `data/cards-seed.json` to see how many cards exist and what categories are covered.
If the file doesn't exist, note that it needs to be created.

### Step 2: Ask the user for parameters (if not already specified)
- **How many cards?** (default: 50)
- **Theme/category?** (default: mixed — tecnología, comida, naturaleza, deportes, cultura)
- **Replace or append?** (default: append, deduplicating by word)

### Step 3: Generate the cards
Run the generation script:

```bash
cd /Users/oscargonzalez/taboo-game && node scripts/generate-cards.js 50
```

If you want a specific count:
```bash
node scripts/generate-cards.js 30
```

### Step 4: Verify the output
After generation completes:
1. Read `data/cards-seed.json`
2. Confirm the total card count increased
3. Show the user a sample of 3-5 generated cards
4. Note any issues (low count, duplicates skipped, etc.)

### Step 5: Report to user
Tell the user:
- How many cards were generated
- How many were unique (vs. duplicates skipped)
- New total deck size
- 3 example cards with their taboo words

## Quality Standards for Good Taboo Cards

**Good card — taboo words are obvious descriptors:**
```
VOLCÁN: lava, erupción, magma, montaña, fuego
```

**Bad card — taboo words are too technical or obscure:**
```
PERRO: canis lupus, hocico, raza, pelaje, bozal
```

Good taboo words for PERRO: animal, mascota, ladrar, gato, cuatro patas

## Troubleshooting

**"GOOGLE_API_KEY is not set"**:
The user needs to copy `.env.example` to `.env` and add their Google API key.
Tell them: "Get a key at https://aistudio.google.com/apikey"

**Fewer cards than requested**:
Gemini may generate slightly fewer cards if it detects duplicates internally.
This is normal — just run again to add more.

**JSON parse error**:
The API response was malformed. Try running again — usually a transient issue.
