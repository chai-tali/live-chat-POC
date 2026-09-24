/** Converts Float32 samples in [-1, 1] (Web Audio's native format) to a
 * little-endian 16-bit PCM ArrayBuffer, matching the Live API's required
 * input format (PCM 16-bit, 16kHz, little-endian). */
export function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    const sample = clamped < 0 ? clamped * 32768 : clamped * 32767;
    view.setInt16(i * 2, sample, true);
  }
  return buffer;
}

/** Converts a little-endian 16-bit PCM ArrayBuffer (the Live API's output
 * format, PCM 16-bit, 24kHz) back to Float32 samples for playback via the
 * Web Audio API. */
export function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  const out = new Float32Array(buffer.byteLength / 2);
  for (let i = 0; i < out.length; i++) {
    const sample = view.getInt16(i * 2, true);
    out[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  return out;
}
