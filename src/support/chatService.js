const config = require('../config');
const { systemPrompt } = require('./knowledge');

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 30000;

const isEnabled = () => Boolean(config.groqApiKey);

class SupportUnavailable extends Error {}

/** Modellspezifische Optionen: Denkschritte kurz halten und nicht mitsenden */
function modelOptions(model) {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low', include_reasoning: false };
  if (model.startsWith('qwen/')) return { reasoning_format: 'hidden' };
  return {};
}

async function callModel(model, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.4, max_completion_tokens: 600, ...modelOptions(model) }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${model} ${res.status}: ${data.error ? data.error.message : 'unbekannter Fehler'}`);
      err.status = res.status;
      throw err;
    }
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    const text = msg ? String(msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
    if (!text) throw new Error(`${model}: leere Antwort`);
    return { text, model, usage: data.usage || null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Antwort des Support-Bots. history: [{ role: 'user'|'assistant', content }] (ohne die neue Nachricht).
 * Die Modelle werden der Reihe nach versucht (jedes hat ein eigenes Gratis-Limit pro Minute).
 */
async function reply({ username, history, message }) {
  if (!isEnabled()) throw new SupportUnavailable('Der Support-Chat ist gerade nicht verfügbar.');
  const messages = [{ role: 'system', content: systemPrompt({ username }) }, ...history, { role: 'user', content: message }];
  let limited = false;
  for (const model of config.groqModels) {
    try {
      return await callModel(model, messages);
    } catch (err) {
      if (err.status === 429) limited = true;
      else console.error('Support-Bot:', err.message);
    }
  }
  throw new SupportUnavailable(
    limited
      ? 'Warren hat gerade zu viele Anfragen auf dem Tisch – bitte versuch es in einer Minute noch einmal.'
      : 'Warren ist gerade in einer Aktionärsversammlung – bitte versuch es gleich noch einmal.'
  );
}

module.exports = { isEnabled, reply, SupportUnavailable };
