import test from "node:test";
import assert from "node:assert/strict";
import {
  REALTIME_VOICE_MODEL,
  REALTIME_VOICE_NAMES,
  MAX_REALTIME_SDP_LENGTH,
  normalizeRealtimeVoiceRequest,
  buildRealtimeVoiceSession
} from "../realtime-voice-utils.mjs";

test("Realtime voice request accepts a valid SDP offer and supported voice", () => {
  const result = normalizeRealtimeVoiceRequest({ sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1", voice: "marin" });
  assert.equal(result.voice, "marin");
  assert.match(result.sdp, /^v=0/);
});

test("Realtime voice request falls back to the safe default voice", () => {
  assert.equal(normalizeRealtimeVoiceRequest({ sdp: "v=0\r\no=- 1", voice: "unknown" }).voice, "marin");
});

test("Realtime voice request rejects malformed and oversized SDP", () => {
  assert.throws(() => normalizeRealtimeVoiceRequest({ sdp: "not-sdp" }), /VOICE_SDP_INVALID/);
  assert.throws(() => normalizeRealtimeVoiceRequest({ sdp: "v=0" + "x".repeat(MAX_REALTIME_SDP_LENGTH) }), /VOICE_SDP_INVALID/);
  assert.throws(() => normalizeRealtimeVoiceRequest(null), /VOICE_REQUEST_INVALID/);
});

test("Realtime session uses the current supported model and a natural Egyptian voice prompt", () => {
  const session = buildRealtimeVoiceSession("marin");
  assert.equal(session.type, "realtime");
  assert.equal(session.model, REALTIME_VOICE_MODEL);
  assert.deepEqual(session.output_modalities, ["audio"]);
  assert.equal(session.audio.output.voice, "marin");
  assert.match(session.instructions, /Egyptian Arabic/);
  assert.match(session.instructions, /not Modern Standard Arabic/);
  assert.match(session.instructions, /AI-generated voice/);
  assert.ok(REALTIME_VOICE_NAMES.includes(session.audio.output.voice));
});

test("Realtime voice names are normalized before allowlist selection", () => {
  assert.equal(normalizeRealtimeVoiceRequest({ sdp: "v=0\\r\\no=- 1", voice: "MARIN" }).voice, "marin");
});
