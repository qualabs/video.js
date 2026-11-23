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
    #levels: readonly Level[] = [];

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

    // Playa replaces its levels on `catalog_updated` and `selection_changed` without announcing them, so the level
    // indexes are re-read before one of them is marked.
    #onQualityChange(engine: Player, level: Level) {
      this.#mirrorLevels(engine.levels);
      this.#setActiveRendition(level.index);
    }

    // Playa announces its levels only after `ready`, where the host already announced `loadedmetadata`.
    #onLoadedMetadata = () => {
      const { engine } = this;

      if (engine) this.#mirrorLevels(engine.levels);
    };

    #mirrorLevels(levels: readonly Level[]) {
      if (levelsKey(levels) !== levelsKey(this.#levels)) {
        const pinned = this.engine?.autoQuality === false ? this.#selectedLevel() : undefined;

        this.#levels = levels;
        this.#replaceRenditions(levels);

        if (pinned) this.#repin(pinned);
      }

      this.#seedActiveRendition();
    }

    #selectedLevel(): Level | undefined {
      const selected = this.videoRenditions[this.videoRenditions.selectedIndex];

      return selected?.id ? this.#levels[Number(selected.id)] : undefined;
    }

    // A new set renumbers the levels, so the pinned one is looked up again by its identity. Selecting it re-applies the
    // pin through `change`; when it is gone, nothing is selected and playa returns to auto.
    #repin(pinned: Level) {
      const level = this.#levels.find((level) => levelIdentity(level) === levelIdentity(pinned));
      const rendition = level && this.videoRenditions.getRenditionById(`${level.index}`);

      if (rendition) rendition.selected = true;
      else this.#switchRendition();
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
      this.#levels = [];
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

function levelIdentity(level: Level): string {
  return level.id ?? level.trackName;
}

function levelsKey(levels: readonly Level[]): string {
  return levels
    .map((level) => `${levelIdentity(level)}|${level.width}x${level.height}|${level.codec}|${level.bitrate}`)
    .join();
}
