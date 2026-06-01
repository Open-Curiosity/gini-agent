// STT provider selection + WAV decoder + local-provider tests.
//
// These tests must never pull a real model from the hub: we stub the
// dynamic import via __setTransformersLoaderForTests so the local-provider
// code path runs without the network or the native binding.

import { afterEach, describe, expect, test } from "bun:test";
import {
  __setTransformersLoaderForTests,
  DEFAULT_LOCAL_STT_MODEL,
  decodeWav,
  echoProvider,
  getSttProvider,
  localProvider,
  resolveSttChoice
} from "./stt";

afterEach(() => {
  delete process.env.GINI_STT_PROVIDER;
  delete process.env.GINI_LOCAL_STT_MODEL;
  delete process.env.GINI_STT_DTYPE;
  __setTransformersLoaderForTests(null);
});

// Synthesize a tiny WAV in the format the decoder expects: integer PCM,
// 16-bit, little-endian. Samples are int16 values; channels are interleaved.
function makeWav(samples: number[], sampleRate: number, numChannels: number): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample * numChannels;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeTag(36, "data");
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * bytesPerSample, samples[i]!, true);
  }
  return new Uint8Array(buffer);
}

describe("resolveSttChoice", () => {
  test("default (no env) is local with the default model", () => {
    const choice = resolveSttChoice();
    expect(choice.name).toBe("local");
    expect(choice.model).toBe(DEFAULT_LOCAL_STT_MODEL);
    expect(choice.reason).toBe("default");
  });

  test("explicit GINI_STT_PROVIDER=echo pins echo", () => {
    process.env.GINI_STT_PROVIDER = "echo";
    const choice = resolveSttChoice();
    expect(choice.name).toBe("echo");
    expect(choice.reason).toBe("explicit");
  });

  test("GINI_LOCAL_STT_MODEL overrides the default model id", () => {
    process.env.GINI_LOCAL_STT_MODEL = "onnx-community/whisper-base";
    expect(resolveSttChoice().model).toBe("onnx-community/whisper-base");
  });
});

describe("echo provider", () => {
  test("returns the constant placeholder transcript", async () => {
    const provider = echoProvider();
    expect(provider.name).toBe("echo");
    expect(await provider.transcribe(new Uint8Array(0))).toBe("[voice message]");
  });

  test("getSttProvider honors explicit echo", async () => {
    process.env.GINI_STT_PROVIDER = "echo";
    const provider = getSttProvider();
    expect(provider.name).toBe("echo");
  });
});

describe("WAV decoder", () => {
  test("decodes 16 kHz mono 16-bit PCM to normalized floats", () => {
    const samples = [0, 16384, -16384, 32767, -32768];
    const wav = makeWav(samples, 16000, 1);
    const decoded = decodeWav(wav);
    expect(decoded.length).toBe(samples.length);
    expect(decoded[0]).toBeCloseTo(0, 5);
    expect(decoded[1]).toBeCloseTo(0.5, 4);
    expect(decoded[2]).toBeCloseTo(-0.5, 4);
    expect(decoded[3]).toBeCloseTo(32767 / 32768, 4);
    expect(decoded[4]).toBeCloseTo(-1, 5);
  });

  test("downmixes stereo to mono by averaging channels", () => {
    // Interleaved L,R frames: (16384, -16384) → average 0; (32767, 32767) → ~1.
    const wav = makeWav([16384, -16384, 32767, 32767], 16000, 2);
    const decoded = decodeWav(wav);
    expect(decoded.length).toBe(2);
    expect(decoded[0]).toBeCloseTo(0, 5);
    expect(decoded[1]).toBeCloseTo(32767 / 32768, 4);
  });

  test("resamples 8 kHz to 16 kHz (roughly doubles the sample count)", () => {
    const samples = new Array(100).fill(0).map((_, i) => (i % 2 === 0 ? 8000 : -8000));
    const wav = makeWav(samples, 8000, 1);
    const decoded = decodeWav(wav);
    expect(decoded.length).toBe(200);
  });

  test("rejects non-PCM (IEEE float) audio", () => {
    const wav = makeWav([0, 0], 16000, 1);
    new DataView(wav.buffer).setUint16(20, 3, true); // audioFormat = IEEE float
    expect(() => decodeWav(wav)).toThrow(/unsupported audio format/);
  });
});

describe("local provider via test seam", () => {
  test("decodes WAV, passes a Float32Array to the pipeline, and trims the result", async () => {
    let received: unknown = null;
    __setTransformersLoaderForTests(async () => ({
      pipeline: async (task: string, model: string, options?: { dtype?: string }) => {
        expect(task).toBe("automatic-speech-recognition");
        expect(model).toBe(DEFAULT_LOCAL_STT_MODEL);
        expect(options?.dtype).toBe("q4");
        return async (audio: Float32Array) => {
          received = audio;
          return { text: " hello world " };
        };
      },
      env: {}
    }));
    const provider = localProvider();
    const wav = makeWav([0, 16384, -16384], 16000, 1);
    const text = await provider.transcribe(wav);
    expect(text).toBe("hello world");
    expect(received).toBeInstanceOf(Float32Array);
    expect((received as Float32Array).length).toBe(3);
  });

  test("treats [BLANK_AUDIO] as an empty transcript", async () => {
    __setTransformersLoaderForTests(async () => ({
      pipeline: async () => async () => ({ text: " [BLANK_AUDIO] " }),
      env: {}
    }));
    const provider = localProvider();
    const wav = makeWav([0, 0], 16000, 1);
    expect(await provider.transcribe(wav)).toBe("");
  });

  test("honors GINI_STT_DTYPE", async () => {
    process.env.GINI_STT_DTYPE = "fp32";
    __setTransformersLoaderForTests(async () => ({
      pipeline: async (_task: string, _model: string, options?: { dtype?: string }) => {
        expect(options?.dtype).toBe("fp32");
        return async () => ({ text: "ok" });
      },
      env: {}
    }));
    const provider = localProvider();
    expect(await provider.transcribe(makeWav([0], 16000, 1))).toBe("ok");
  });
});
