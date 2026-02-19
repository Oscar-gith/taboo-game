// ============================================================
// CardGenerator — Google Gemini API integration
//
// Generates Spanish Taboo cards using Gemini (free tier available).
// Called server-side only. The API key is never exposed to clients.
// ============================================================

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// System instruction that tells Gemini exactly what format we need.
const SYSTEM_INSTRUCTION = `Eres un diseñador experto de juegos de mesa en español, especializado en el juego Taboo.
Tu única tarea es generar cartas para Taboo en español.
Debes responder ÚNICAMENTE con un JSON array válido — sin texto extra, sin markdown, sin explicaciones.
El array debe contener exactamente los objetos de carta solicitados.`;

function buildPrompt(count, category) {
  const categoryInstruction = category
    ? `Categoría temática obligatoria: ${category}.`
    : 'Usa categorías variadas: tecnología, comida, naturaleza, deportes, cultura, geografía, objetos cotidianos, animales, profesiones.';

  return `Genera ${count} cartas únicas para el juego Taboo en español.
${categoryInstruction}

Reglas para cartas de calidad:
1. La palabra principal debe ser un sustantivo o concepto común y reconocible en español
2. Las 5 palabras tabú deben ser las palabras MÁS OBVIAS que alguien usaría para describir la principal
3. Las palabras tabú NO deben incluir la palabra principal, sus plurales ni conjugaciones directas
4. Las palabras tabú deben estar en minúsculas
5. La dificultad varía: mezcla easy, medium y hard

Ejemplo de carta BUENA:
{"word":"VOLCÁN","tabooWords":["lava","erupción","magma","montaña","fuego"],"category":"naturaleza","difficulty":"medium"}

Ejemplo de carta MALA (palabras tabú demasiado técnicas u obscuras):
{"word":"PERRO","tabooWords":["canis lupus","hocico","raza","pelaje","bozal"]}

Formato de respuesta — solo el JSON array, sin nada más:
[
  {
    "word": "PALABRA EN MAYÚSCULAS",
    "tabooWords": ["tabú1", "tabú2", "tabú3", "tabú4", "tabú5"],
    "category": "categoría",
    "difficulty": "easy" | "medium" | "hard"
  }
]

Genera exactamente ${count} cartas ahora.`;
}

// Generate N Spanish Taboo cards via the Google Gemini API
// Returns an array of card objects with UUIDs assigned
async function generateCards(count = config.CARDS_PER_GENERATION, category = null) {
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is not set. Copy .env.example to .env and add your key.');
  }

  console.log(`Generating ${count} Spanish Taboo cards${category ? ` [${category}]` : ''}...`);

  const model = genAI.getGenerativeModel({
    model: config.CARD_GENERATION_MODEL,
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  const result = await model.generateContent(buildPrompt(count, category));
  const response = result.response;
  const rawText = response.text()?.trim();

  if (!rawText) throw new Error('Empty response from Gemini API');

  // Parse the JSON array
  let cards;
  try {
    cards = JSON.parse(rawText);
  } catch (err) {
    // Sometimes the model wraps in a code block despite instructions — strip it
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error(`Failed to parse card JSON: ${rawText.slice(0, 200)}`);
    cards = JSON.parse(jsonMatch[0]);
  }

  if (!Array.isArray(cards)) throw new Error('API response is not an array');

  // Validate and enrich each card
  return cards
    .filter(card => card.word && Array.isArray(card.tabooWords) && card.tabooWords.length === 5)
    .map(card => ({
      id:         uuidv4(),
      word:       String(card.word).toUpperCase().trim(),
      tabooWords: card.tabooWords.map(w => String(w).toLowerCase().trim()),
      category:   String(card.category || 'general').toLowerCase(),
      difficulty: ['easy', 'medium', 'hard'].includes(card.difficulty) ? card.difficulty : 'medium',
    }));
}

module.exports = { generateCards };
