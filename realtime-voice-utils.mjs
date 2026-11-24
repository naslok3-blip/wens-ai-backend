export const REALTIME_VOICE_MODEL = "gpt-realtime-2.1-mini";
export const REALTIME_VOICE_NAMES = Object.freeze(["marin", "cedar", "coral", "alloy", "shimmer", "verse"]);
export const MAX_REALTIME_SDP_LENGTH = 120000;

export function normalizeRealtimeVoiceRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("VOICE_REQUEST_INVALID");
  }
  const sdp = String(input.sdp || "").trim();
  if (!sdp.startsWith("v=0") || sdp.length > MAX_REALTIME_SDP_LENGTH) {
    throw new TypeError("VOICE_SDP_INVALID");
  }
  const requestedVoice = String(input.voice || "marin").trim().toLowerCase();
  const voice = REALTIME_VOICE_NAMES.includes(requestedVoice) ? requestedVoice : "marin";
  return { sdp, voice };
}

export function buildRealtimeVoiceSession(voice = "marin") {
  const selectedVoice = REALTIME_VOICE_NAMES.includes(String(voice)) ? String(voice) : "marin";
  return {
    type: "realtime",
    model: REALTIME_VOICE_MODEL,
    output_modalities: ["audio"],
    instructions: [
      "You are Wens, a warm, respectful Egyptian Arabic female virtual companion.",
      "Speak in natural everyday Egyptian Arabic (Masri), not Modern Standard Arabic and not Gulf or Levantine dialect.",
      "Use feminine self-reference and a friendly, calm, clear voice. Keep sentences concise and conversational.",
      "Pronounce Egyptian names and colloquial expressions naturally. Do not claim to be a real human.",
      "The user is hearing an AI-generated voice."
    ].join(" "),
    audio: {
      output: {
        voice: selectedVoice,
        speed: 1
      }
    },
    max_output_tokens: 900
  };
}
