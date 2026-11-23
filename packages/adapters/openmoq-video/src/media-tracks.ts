import type { Level, Player } from '@openmoq/playa';
import type { MediaVideoRenditionCapability, MediaVideoTrackCapability } from '@videojs/media';
import type { Constructor } from '@videojs/utils/types';

type OpenMoqEngineHost = EventTarget & {
  readonly engine: Player | null;
  detach(): void;
  destroy(): void;
};

type MediaTracksHost = OpenMoqEngineHost & MediaVideoTrackCapability & MediaVideoRenditionCapability;

/**
 * Mirrors the playa `Player` levels into the media element's `videoRenditions` list, and wires user selection back to
 * `engine.setQuality()`.
 *
 * Levels are hung off a single `'main'` video track. A new `Player` is created for every source, so the mixin binds to
 * each one on `loadstart`.
 *
 * Requires the media-tracks mixin (track-list infrastructure) to be applied earlier in the chain so the host exposes
 * `addVideoTrack`, `videoRenditions`, and friends.
 */
export function OpenMoqMediaTracksMixin<Base extends Constructor<MediaTracksHost>>(BaseClass: Base) {
  class OpenMoqMediaTracks extends (BaseClass as Constructor<MediaTracksHost>) {
    #unsubscribes: (() => void)[] = [];
    // Playa re-announces its levels whenever the catalog is re-received, so a re-announcement of the same set is
    // recognized by what it announced last.
    #levelsKey = '';

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
        engine.on('qualitychange', ({ level }) => this.#setActiveRendition(level.index)),
      ];
    };

    // Playa announces its levels only after `ready`, where the host already announced `loadedmetadata`.
    #onLoadedMetadata = () => {
      const { engine } = this;

      if (engine) this.#mirrorLevels(engine.levels);
    };

    #mirrorLevels(levels: readonly Level[]) {
      const key = levelsKey(levels);

      if (key !== this.#levelsKey) {
        this.#levelsKey = key;
        this.#replaceRenditions(levels);
      }

      this.#seedActiveRendition();
    }

    #replaceRenditions(levels: readonly Level[]) {
      this.#removeVideoTracks();

      const videoTrack = this.addVideoTrack('main');

      // Selecting the track is what puts its renditions in `videoRenditions`, so
      // it happens before any is added and their `addrendition` events land.
      videoTrack.selected = true;

      for (const level of levels) {
        // Playa reports a dimension or bitrate the catalog leaves out as 0.
        const rendition = videoTrack.addRendition(
          '',
          level.width || undefined,
          level.height || undefined,
          level.codec,
          level.bitrate || undefined
        );

        rendition.id = `${level.index}`;
      }
    }

    // Playa adopts the first level after announcing the levels, and reports that adoption with no event of its own,
    // so the level playing is read back once the first frame is rendered.
    #seedActiveRendition = () => {
      this.#setActiveRendition(this.engine?.currentLevel ?? -1);
    };

    #switchRendition = () => {
      const { engine } = this;
      if (!engine?.levels.length) return;

      const selected = this.videoRenditions[this.videoRenditions.selectedIndex];

      engine.setQuality(selected?.id ? Number(selected.id) : 'auto').catch((cause) => {
        if (__DEV__) console.warn('[openmoq-video] Failed to switch the video rendition.', cause);
      });
    };

    #setActiveRendition(levelIndex: number) {
      for (const rendition of this.videoRenditions) {
        rendition.active = rendition.id === `${levelIndex}`;
      }
    }

    #reset = () => {
      for (const unsubscribe of this.#unsubscribes) unsubscribe();

      this.#unsubscribes = [];
      this.#levelsKey = '';
      this.#removeVideoTracks();
    };

    #removeVideoTracks() {
      for (const videoTrack of this.videoTracks) {
        this.removeVideoTrack(videoTrack);
      }
    }
  }

  return OpenMoqMediaTracks as unknown as Base;
}

function levelsKey(levels: readonly Level[]): string {
  return levels
    .map((level) => `${level.id ?? level.trackName}|${level.width}x${level.height}|${level.codec}|${level.bitrate}`)
    .join();
}
