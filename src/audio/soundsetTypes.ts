// Format of public/audio/soundset.json, written by tools/audio and read by src/audio.
// It is CDDA's soundpack model (doc/SOUNDPACKS.md, src/sdlsound.cpp) flattened to one file:
// a `sound_effect` is keyed by (id, variant, season, is_indoors, is_night) and holds files that
// are picked at random. Keys that are omitted mean "any" and act as the fallback.

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface SoundFileRef {
  /** Path relative to public/audio/, e.g. "sfx/plmove/walk_dirt_1.ogg". */
  file: string;
  /** CDDA volume, 0..100+ (100 = as recorded). */
  volume: number;
}

export interface SoundEffectDef {
  id: string;
  /** One entry per CDDA variant string ("default" when the pack gave none). */
  variants: string[];
  season?: Season;
  indoors?: boolean;
  night?: boolean;
  volume: number;
  files: string[];
}

export interface PlaylistDef {
  id: string;
  shuffle: boolean;
  files: SoundFileRef[];
}

export interface AudioFileInfo {
  bytes: number;
  /** seconds, measured with ffprobe after transcoding */
  duration: number;
}

export interface SoundsetFile {
  version: 1;
  /** Where the sounds came from, for the credits screen. */
  sources: { name: string; url: string; license: string }[];
  effects: SoundEffectDef[];
  playlists: PlaylistDef[];
  files: Record<string, AudioFileInfo>;
}
