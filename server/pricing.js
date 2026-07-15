'use strict';
/* ------------------------------------------------------------------ */
/* Prix des modèles (USD par million de tokens) → coût estimé en EUR.  */
/* Modèle inconnu : coût null (l'UI n'affiche alors que les tokens).   */
/* ------------------------------------------------------------------ */

const USD_PER_MTOK = {
  /* Anthropic */
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  /* OpenAI */
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 }
};

const EUR_RATE = Number(process.env.LUSINE_EUR_RATE || 0.95); // USD → EUR

function priceFor(model) {
  if (!model) return null;
  if (USD_PER_MTOK[model]) return USD_PER_MTOK[model];
  // correspondance par préfixe (ex: claude-sonnet-4-6-20260115)
  const key = Object.keys(USD_PER_MTOK).find(k => model.startsWith(k));
  return key ? USD_PER_MTOK[key] : null;
}

/* Coût en EUR d'un appel, ou null si le modèle est inconnu. */
function costEUR(model, inTok, outTok) {
  const p = priceFor(model);
  if (!p) return null;
  return ((inTok / 1e6) * p.in + (outTok / 1e6) * p.out) * EUR_RATE;
}

module.exports = { costEUR, priceFor };
