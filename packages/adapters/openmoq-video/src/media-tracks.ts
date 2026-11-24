import type { Level, Player } from '@openmoq/playa';
import type {
  MediaVideoRenditionCapability,
  MediaVideoTrackCapability,
  VideoRenditionLike,
  VideoTrackLike,
} from '@videojs/media';
import { noop } from '@videojs/utils/function';
import type { Constructor } from '@videojs/utils/types';

type OpenMoqEngineHost = EventTarget & {
  readonly engine: Player | null;
  detach(): void;
  destroy(): void;
};

type MediaTracksHost = OpenMoqEngineHost & MediaVideoTrackCapability & MediaVideoRenditionCapability;

/**
 * Mirrors playa levels into `videoRenditions` under one `main` track; selection goes to `setQuality()`. Needs
 * `MediaTracksMixin` earlier in the chain.
 */
export function OpenMoqMediaTracksMixin<Base extends Constructor<MediaTracksHost>>(BaseClass: Base) {
  class OpenMoqMediaTracks extends (BaseClass as Constructor<MediaTracksHost>) {
    #unsubscribes: (() => void)[] = [];
    #videoTrack: VideoTrackLike | null = null;
    // level identity last sent to playa; undefined = auto
    #requested: string | undefined;

    constructor(...args: any[]) {
      super(...args);

      this.addEventListener('loadstart', this.#onLoadStart);
      this.addEventListener('loadedmetadata', this.#onLoadedMetadata);
      this.addEventListener('loadeddata', this.#seedActiveRendition);
      this.addEventListener('emptied', this.#reset);
      this.videoRenditions.addEventListener('change', this.#switchRendition);
    }

    detach() {
      this.#reset();

      super.detach();
    }

    destroy() {
      this.removeEventListener('loadstart', this.#onLoadStart);
      this.removeEventListener('loadedmetadata', this.#onLoadedMetadata);
      this.removeEventListener('loadeddata', this.#seedActiveRendition);
      this.removeEventListener('emptied', this.#reset);
      this.videoRenditions.removeEventListener('change', this.#switchRendition);

      super.destroy();
    }

    #onLoadStart = () => {
      this.#reset();

      const { engine } = this;
      if (!engine) return;

      this.#unsubscribes = [
        engine.on('levelsloaded', ({ levels }) => this.#mirrorLevels(levels)),
        engine.on('qualitychange', ({ level }) => this.#onQualityChange(engine, level)),
      ];
    };

    // playa swaps levels on catalog_updated/selection_changed w/o event; re-read before marking
    #onQualityChange(engine: Player, level: Level) {
      this.#mirrorLevels(engine.levels);
      this.#setActiveRendition(level);
    }

    // playa's levelsloaded comes after the host's loadedmetadata
    #onLoadedMetadata = () => {
      const { engine } = this;

      if (engine) this.#mirrorLevels(engine.levels);
    };

    // list only keeps insertion order: re-add from the first mismatch on, carrying `selected` by identity
    #mirrorLevels(levels: readonly Level[]) {
      if (!this.#videoTrack && !levels.length) return;

      const videoTrack = (this.#videoTrack ??= this.#addMainTrack());
      const renditions = [...this.videoRenditions];
      const picked = this.videoRenditions[this.videoRenditions.selectedIndex];

      const changedAt = renditions.findIndex((rendition, index) => !matchesLevel(rendition, levels[index]));
      const kept = changedAt === -1 ? renditions.length : changedAt;

      for (const rendition of renditions.slice(kept)) videoTrack.removeRendition(rendition);

      for (const level of levels.slice(kept)) {
        const previous = renditions.find((rendition) => rendition.id === levelIdentity(level));
        const rendition = addRendition(videoTrack, level);

        rendition.selected = previous?.selected ?? false;
      }

      // removing the picked rendition fires no change; send playa back to auto
      if (picked && !levels.some((level) => levelIdentity(level) === picked.id)) this.#switchRendition();

      this.#seedActiveRendition();
    }

    #addMainTrack(): VideoTrackLike {
      const videoTrack = this.addVideoTrack('main');

      // select before adding, or addrendition events don't fire
      videoTrack.selected = true;

      return videoTrack;
    }

    // playa adopts its first level w/o event; read it back at first frame
    #seedActiveRendition = () => {
      const { engine } = this;

      this.#setActiveRendition(engine?.levels[engine.currentLevel]);
    };

    #switchRendition = () => {
      const { engine } = this;
      if (!engine?.levels.length) return;

      const requested = this.videoRenditions[this.videoRenditions.selectedIndex]?.id;
      if (requested === this.#requested) return;

      // playa renumbers levels w/o event; look the index up now
      const quality = requested ? engine.levels.findIndex((level) => levelIdentity(level) === requested) : 'auto';

      // restore before re-reading, or the previous pin goes to auto
      if (quality === -1) {
        this.#restoreSelection(engine, this.#requested);
        this.#mirrorLevels(engine.levels);
        return;
      }

      const previous = this.#requested;

      this.#requested = requested;

      engine.setQuality(quality).catch((cause) => {
        if (__DEV__) console.warn('[openmoq-video] Failed to switch the video rendition.', cause);

        if (engine === this.engine && requested === this.#requested) this.#restoreSelection(engine, previous);
      });
    };

    // failed switch: playa stays on the playing level (ABR off). Re-select the previous pick, else back to auto
    #restoreSelection(engine: Player, previous: string | undefined) {
      const renditions = [...this.videoRenditions];
      const index =
        previous && engine.levels.some((level) => levelIdentity(level) === previous)
          ? renditions.findIndex((rendition) => rendition.id === previous)
          : -1;

      // selectedIndex also clears the rejected pick; rendition.selected wouldn't
      this.#requested = renditions[index]?.id;
      this.videoRenditions.selectedIndex = index;

      if (index === -1) engine.setQuality('auto').catch(noop);
    }

    #setActiveRendition(level: Level | undefined) {
      const identity = level && levelIdentity(level);

      for (const rendition of this.videoRenditions) {
        rendition.active = rendition.id === identity;
      }
    }

    #reset = () => {
      for (const unsubscribe of this.#unsubscribes) unsubscribe();

      this.#unsubscribes = [];
      this.#videoTrack = null;
      this.#requested = undefined;
      this.#removeVideoTracks();
    };

    // removeVideoTrack only fires removetrack; remove renditions first
    #removeVideoTracks() {
      for (const videoTrack of this.videoTracks) {
        for (const rendition of [...this.videoRenditions]) videoTrack.removeRendition(rendition);

        this.removeVideoTrack(videoTrack);
      }
    }
  }

  return OpenMoqMediaTracks as unknown as Base;
}

function levelIdentity(level: Level): string {
  return level.id ?? level.trackName;
}

// playa reports missing size/bitrate as 0
function toRendition(level: Level) {
  return {
    id: levelIdentity(level),
    width: level.width || undefined,
    height: level.height || undefined,
    codec: level.codec,
    bitrate: level.bitrate || undefined,
  };
}

function matchesLevel(rendition: VideoRenditionLike, level: Level | undefined): boolean {
  if (!level) return false;

  const { id, width, height, codec, bitrate } = toRendition(level);

  return (
    rendition.id === id &&
    rendition.width === width &&
    rendition.height === height &&
    rendition.codec === codec &&
    rendition.bitrate === bitrate
  );
}

function addRendition(videoTrack: VideoTrackLike, level: Level): VideoRenditionLike {
  const { id, width, height, codec, bitrate } = toRendition(level);
  const rendition = videoTrack.addRendition('', width, height, codec, bitrate);

  rendition.id = id;

  return rendition;
}
