declare module 'music-tempo' {
  interface TempoResult {
    tempo: number;
    beats: number[];
  }

  class MusicTempo {
    constructor(peaks: number[]);
    get tempo(): number;
    get beats(): number[];
  }

  export = MusicTempo;
}
