import type { Level, Player } from '@openmoq/playa';
import type { MediaVideoRenditionCapability, MediaVideoTrackCapability, VideoTrackLike } from '@videojs/media';
import { noop } from '@videojs/utils/function';
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
    #videoTrack: VideoTrackLike | null = null;
    // Identity of the level last asked of playa, or undefined for auto.
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

    // Playa replaces its levels on `catalog_updated` and `selection_changed` without announcing them, so they are
    // re-read before one of them is marked.
    #onQualityChange(engine: Player, level: Level) {
      this.#mirrorLevels(engine.levels);
      this.#setActiveRendition(level);
    }

    // Playa announces its levels only after `ready`, where the host already announced `loadedmetadata`.
    #onLoadedMetadata = () => {
      const { engine } = this;

      if (engine) this.#mirrorLevels(engine.levels);
    };

    // Renditions are matched to levels by identity and updated in place, so they keep their `selected` and `active`
    // flags while playa renumbers its levels.
    #mirrorLevels(levels: readonly Level[]) {
      if (!this.#videoTrack && !levels.length) return;

      const videoTrack = (this.#videoTrack ??= this.#addMainTrack());
      const identities = new Set<string | undefined>(levels.map(levelIdentity));
      const picked = this.videoRenditions[this.videoRenditions.selectedIndex];

      for (const rendition of [...this.videoRenditions]) {
        if (!identities.has(rendition.id)) videoTrack.removeRendition(rendition);
      }

      for (const level of levels) {
        if (!this.videoRenditions.getRenditionById(levelIdentity(level))) addRendition(videoTrack, level);
      }

      // Removing the picked rendition fires no `change`, and this is what returns playa to auto.
      if (picked && !identities.has(picked.id)) this.#switchRendition();

      this.#seedActiveRendition();
    }

    #addMainTrack(): VideoTrackLike {
      const videoTrack = this.addVideoTrack('main');

      // Selecting the track is what puts its renditions in `videoRenditions`, so
      // it happens before any is added and their `addrendition` events land.
      videoTrack.selected = true;

      return videoTrack;
    }

    // Playa adopts the first level after announcing the levels, and reports that adoption with no event of its own,
    // so the level playing is read back once the first frame is rendered.
    #seedActiveRendition = () => {
      const { engine } = this;

      this.#setActiveRendition(engine?.levels[engine.currentLevel]);
    };

    #switchRendition = () => {
      const { engine } = this;
      if (!engine?.levels.length) return;

      const requested = this.videoRenditions[this.videoRenditions.selectedIndex]?.id;
      if (requested === this.#requested) return;

      // Playa renumbers its levels on `catalog_updated` without an event, so the index is looked up at switch time.
      const quality = requested ? engine.levels.findIndex((level) => levelIdentity(level) === requested) : 'auto';

      if (quality === -1) {
        this.#restoreSelection(engine, this.#requested);
        return;
      }

      const previous = this.#requested;

      this.#requested = requested;

      engine.setQuality(quality).catch((cause) => {
        if (__DEV__) console.warn('[openmoq-video] Failed to switch the video rendition.', cause);

        if (engine === this.engine && requested === this.#requested) this.#restoreSelection(engine, previous);
      });
    };

    // A rejected switch, or a pick playa has already dropped, leaves playa on the level it was playing, with ABR off
    // after a rejection. A previous manual pick is that level, so only the list goes back to it; otherwise ABR is turned
    // back on.
    #restoreSelection(engine: Player, previous: string | undefined) {
      const renditions = [...this.videoRenditions];
      const index =
        previous && engine.levels.some((level) => levelIdentity(level) === previous)
          ? renditions.findIndex((rendition) => rendition.id === previous)
          : -1;

      // `selectedIndex` deselects the rejected pick too, which a rendition's own `selected` does not.
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

    // Removing a track announces only `removetrack`, so its renditions are removed first and `videoRenditions` listeners
    // see them go.
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

function addRendition(videoTrack: VideoTrackLike, level: Level): void {
  // Playa reports a dimension or bitrate the catalog leaves out as 0.
  const rendition = videoTrack.addRendition(
    '',
    level.width || undefined,
    level.height || undefined,
    level.codec,
    level.bitrate || undefined
  );

  rendition.id = levelIdentity(level);
}
