declare module 'web-audio-api' {
  class AudioContext {
    decodeAudioData(
      audioData: ArrayBuffer,
      successCallback: (decodedData: AudioBuffer) => void,
      errorCallback?: (error: DOMException) => void
    ): void;
  }

  interface AudioBuffer {
    readonly sampleRate: number;
    readonly length: number;
    readonly duration: number;
    readonly numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
    copyFromChannel(destination: Float32Array, channelNumber: number, startInChannel?: number): void;
    copyToChannel(source: Float32Array, channelNumber: number, startInChannel?: number): void;
  }

  export { AudioContext, AudioBuffer };
}
