const WHISPER_SAMPLE_RATE = 16_000;

/** Mix an AudioBuffer to mono and resample only the selected source range. */
export function audioBufferToWhisperSamples(
  audioBuffer: AudioBuffer,
  startTime = 0,
  endTime = audioBuffer.duration,
): Float32Array {
  const startFrame = Math.max(
    0,
    Math.min(audioBuffer.length, Math.floor(startTime * audioBuffer.sampleRate)),
  );
  const endFrame = Math.max(
    startFrame,
    Math.min(audioBuffer.length, Math.ceil(endTime * audioBuffer.sampleRate)),
  );
  return audioChannelsToWhisperSamples(
    Array.from(
      { length: audioBuffer.numberOfChannels },
      (_, index) => audioBuffer.getChannelData(index).subarray(startFrame, endFrame),
    ),
    audioBuffer.sampleRate,
  );
}

export function audioChannelsToWhisperSamples(
  channels: readonly ArrayLike<number>[],
  sourceRate: number,
  maxSourceFrames?: number,
): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || channels.length === 0) {
    throw new RangeError("Audio samples need a positive sample rate and at least one channel");
  }
  const channelLength = channels[0]?.length ?? 0;
  if (channels.some((channel) => channel.length !== channelLength)) {
    throw new RangeError("Audio channels must have equal sample counts");
  }
  if (maxSourceFrames !== undefined && (!Number.isSafeInteger(maxSourceFrames) || maxSourceFrames < 0)) {
    throw new RangeError("Audio source-frame cap must be a non-negative integer");
  }
  const sourceLength = maxSourceFrames === undefined
    ? channelLength
    : Math.min(channelLength, maxSourceFrames);
  if (sourceLength === 0) return new Float32Array();

  const outputLength = Math.max(
    1,
    Math.round((sourceLength * WHISPER_SAMPLE_RATE) / sourceRate),
  );
  const output = new Float32Array(outputLength);
  const sourceFramesPerOutput = sourceRate / WHISPER_SAMPLE_RATE;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourcePosition = outputIndex * sourceFramesPerOutput;
    const leftIndex = Math.min(sourceLength - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(sourceLength - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    let mixed = 0;
    for (const channel of channels) {
      mixed +=
        Number(channel[leftIndex]) +
        (Number(channel[rightIndex]) - Number(channel[leftIndex])) * fraction;
    }
    output[outputIndex] = mixed / channels.length;
  }
  return output;
}

export { WHISPER_SAMPLE_RATE };
