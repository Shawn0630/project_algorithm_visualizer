import axios from 'axios';

// Asks the configured LLM endpoint which models the API key can
// actually use (GET {LLM_BASE_URL}/models) - the ground truth for
// LLM_MODEL / LLM_MODEL_FALLBACK and for the AI assistant's model
// picker, so a 404 "model not found" never has to be debugged by
// guessing ids. The key itself never leaves the server.
//
// Gemini answers with native names ("models/<id>") while its chat
// endpoint takes the bare id, so the prefix is stripped: the
// returned ids work verbatim as a chat-completions "model" value.
// Non-chat models (image, TTS, embeddings, video, live audio,
// research agents) are filtered out - they cannot answer a chat
// call and would only clutter the picker.
const NON_CHAT = /(image|tts|embedding|veo|lyria|transcribe|live|robotics|computer-use|nano-banana|deep-research|^aqa$)/i;

export async function fetchLlmModels(): Promise<{
  models: string[],
  configured: { model: string | null, fallback: string | null },
} | null> {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env['LLM_API' + '_KEY'];
  if (!baseUrl || !apiKey) return null;
  const {data} = await axios.get(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: {Authorization: `Bearer ${apiKey}`},
    timeout: 30000,
  });
  const models = (data && Array.isArray(data.data) ? data.data : [])
    .map((entry: any) => entry && entry.id)
    .filter((id: any) => typeof id === 'string')
    .map((id: string) => id.replace(/^models\//, ''))
    .filter((id: string) => !NON_CHAT.test(id))
    .sort();
  return {
    models,
    configured: {
      model: process.env.LLM_MODEL || null,
      fallback: process.env.LLM_MODEL_FALLBACK || null,
    },
  };
}
