import type { Level, Player, PlayerEventMap } from '@openmoq/playa';
import { MediaTracksMixin } from '@videojs/media/media-tracks';
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test';

import { OpenMoqMediaTracksMixin } from '../media-tracks';

// playa's Level.id = msf identityKey(namespace, trackName)
function trackId(trackName: string, namespace = 'live'): string {
  return JSON.stringify([[namespace], trackName]);
}

function createLevel(index: number, trackName: string, attributes: Partial<Level> = {}, namespace = 'live'): Level {
  return {
    index,
    trackName,
    id: trackId(trackName, namespace),
    namespace: [namespace],
    label: trackName,
    codec: 'avc1.640028',
    width: 0,
    height: 0,
    bitrate: 0,
    ...attributes,
  };
}

const LEVELS: Level[] = [
  createLevel(0, 'video-1080', { label: '1080p', width: 1920, height: 1080, bitrate: 6_000_000 }),
  createLevel(1, 'video-720', { label: '720p', codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 3_000_000 }),
  createLevel(2, 'video-unsized', { codec: 'avc1.42e01e' }),
];

class FakePlayer {
  levels: Level[] = [];
  currentLevel = -1;
  setQuality = vi.fn(async (_level: number | 'auto') => {});
  #listeners = new Map<string, Set<(data: any) => void>>();

  on<K extends keyof PlayerEventMap>(event: K, handler: (data: PlayerEventMap[K]) => void): () => void {
    const handlers = this.#listeners.get(event) ?? new Set();

    handlers.add(handler);
    this.#listeners.set(event, handlers);

    return () => handlers.delete(handler);
  }

  emit<K extends keyof PlayerEventMap>(event: K, data: PlayerEventMap[K]): void {
    for (const handler of [...(this.#listeners.get(event) ?? [])]) handler(data);
  }

  loadLevels(levels: Level[]): void {
    this.levels = levels;
    this.emit('levelsloaded', { levels });
  }

  /** Playa sets currentLevel before qualitychange */
  switchTo(level: Level): void {
    this.currentLevel = level.index;
    this.emit('qualitychange', { level, auto: false });
  }
}

class FakeHost extends EventTarget {
  engine: Player | null = null;

  detach(): void {}

  destroy(): void {
    this.detach();
  }
}

const OpenMoqMediaTracks = OpenMoqMediaTracksMixin(MediaTracksMixin(FakeHost));

function load(media: InstanceType<typeof OpenMoqMediaTracks>): FakePlayer {
  const player = new FakePlayer();

  // SAFETY: the fake covers the Player API the mixin uses.
  media.engine = player as unknown as Player;
  media.dispatchEvent(new Event('loadstart'));

  return player;
}

function withLevel4k(levels: Level[]): Level[] {
  const level4k = createLevel(0, 'video-2160', { label: '2160p', width: 3840, height: 2160, bitrate: 12_000_000 });

  return [level4k, ...levels].map((level, index) => ({ ...level, index }));
}

function flush(): Promise<void> {
  return Promise.resolve();
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('OpenMoqMediaTracksMixin', () => {
  it('lists the levels under one selected main track, reading 0 as missing', () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.loadLevels(LEVELS);

    expect(media.videoTracks.length).toBe(1);
    expect(media.videoTracks[0]?.kind).toBe('main');
    expect(media.videoTracks[0]?.selected).toBe(true);
    expect(
      [...media.videoRenditions].map(({ id, width, height, codec, bitrate }) => ({ id, width, height, codec, bitrate }))
    ).toEqual([
      { id: trackId('video-1080'), width: 1920, height: 1080, codec: 'avc1.640028', bitrate: 6_000_000 },
      { id: trackId('video-720'), width: 1280, height: 720, codec: 'avc1.64001f', bitrate: 3_000_000 },
      { id: trackId('video-unsized'), width: undefined, height: undefined, codec: 'avc1.42e01e', bitrate: undefined },
    ]);
  });

  it('lists the levels on loadedmetadata, and keeps the list when levelsloaded announces the same set', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.levels = LEVELS;
    media.dispatchEvent(new Event('loadedmetadata'));
    media.videoRenditions.selectedIndex = 1;
    await flush();
    player.loadLevels(LEVELS);

    expect(media.videoRenditions.length).toBe(3);
    expect(media.videoRenditions.selectedIndex).toBe(1);
  });

  it('switches to the level of the selected rendition', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.loadLevels(LEVELS);
    media.videoRenditions.selectedIndex = 2;
    await flush();

    expect(player.setQuality).toHaveBeenCalledWith(2);
  });

  it('switches to the picked level after playa replaced its levels without an announcement', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.loadLevels([LEVELS[0]!, LEVELS[1]!]);
    player.levels = withLevel4k([LEVELS[0]!, LEVELS[1]!]);
    media.videoRenditions.selectedIndex = 1;
    await flush();

    expect(player.setQuality).toHaveBeenCalledWith(2);
  });

  it('returns to automatic quality when no rendition is selected', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.loadLevels(LEVELS);
    media.videoRenditions.selectedIndex = 1;
    await flush();
    media.videoRenditions.selectedIndex = -1;
    await flush();

    expect(player.setQuality).toHaveBeenLastCalledWith('auto');
  });

  describe('when the levels change', () => {
    const LEVELS_WITHOUT_1080 = [LEVELS[1]!, LEVELS[2]!].map((level, index) => ({ ...level, index }));

    it('keeps the pinned level selected while playa renumbers it, without switching again', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);
      media.videoRenditions.selectedIndex = 1;
      await flush();
      player.loadLevels(LEVELS_WITHOUT_1080);
      await flush();

      expect(media.videoRenditions.getRenditionById(trackId('video-720'))?.selected).toBe(true);
      expect(player.setQuality).toHaveBeenCalledTimes(1);
    });

    it('lists a level added mid-stream in bitrate order', () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels([LEVELS[0]!, LEVELS[1]!]);
      player.loadLevels(withLevel4k([LEVELS[0]!, LEVELS[1]!]));

      expect([...media.videoRenditions].map(({ id }) => id)).toEqual([
        trackId('video-2160'),
        trackId('video-1080'),
        trackId('video-720'),
      ]);
    });

    it('refreshes the attributes of a level that keeps its identity', () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);
      player.loadLevels([LEVELS[0]!, { ...LEVELS[1]!, bitrate: 2_500_000 }, LEVELS[2]!]);

      expect([...media.videoRenditions].map(({ id, bitrate }) => ({ id, bitrate }))).toEqual([
        { id: trackId('video-1080'), bitrate: 6_000_000 },
        { id: trackId('video-720'), bitrate: 2_500_000 },
        { id: trackId('video-unsized'), bitrate: undefined },
      ]);
    });

    it('carries the selected and active rendition over when it moves', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);
      const updated = withLevel4k(LEVELS);

      player.loadLevels(LEVELS);
      media.videoRenditions.selectedIndex = 1;
      await flush();
      player.switchTo(LEVELS[1]!);
      player.currentLevel = 2;
      player.loadLevels(updated);
      await flush();

      expect([...media.videoRenditions].map(({ id, selected, active }) => ({ id, selected, active }))).toEqual([
        { id: trackId('video-2160'), selected: false, active: false },
        { id: trackId('video-1080'), selected: false, active: false },
        { id: trackId('video-720'), selected: true, active: true },
        { id: trackId('video-unsized'), selected: false, active: false },
      ]);
      expect(player.setQuality).toHaveBeenCalledTimes(1);
    });

    it('returns to automatic quality when the pinned level is gone', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);
      media.videoRenditions.selectedIndex = 0;
      await flush();
      player.loadLevels(LEVELS_WITHOUT_1080);
      await flush();

      expect(media.videoRenditions.selectedIndex).toBe(-1);
      expect(player.setQuality).toHaveBeenLastCalledWith('auto');
    });

    it('keeps the renditions when the same levels are announced again', () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);

      const renditions = [...media.videoRenditions];

      player.loadLevels(LEVELS.map((level) => ({ ...level })));

      expect(media.videoRenditions.length).toBe(renditions.length);
      expect([...media.videoRenditions].every((rendition, index) => rendition === renditions[index])).toBe(true);
    });

    it('drops the lowest rendition when it leaves the catalog', () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);
      player.loadLevels([LEVELS[0]!, LEVELS[1]!]);

      expect([...media.videoRenditions].map(({ id }) => id)).toEqual([trackId('video-1080'), trackId('video-720')]);
    });

    it('tells apart levels that share a track name across namespaces', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);
      const levels = [
        createLevel(0, 'video', { width: 1920, height: 1080, bitrate: 6_000_000 }, 'main'),
        createLevel(1, 'video', { width: 1280, height: 720, bitrate: 3_000_000 }, 'backup'),
      ];

      player.loadLevels(levels);
      media.videoRenditions.selectedIndex = 1;
      await flush();
      player.switchTo(levels[1]!);

      expect([...media.videoRenditions].map(({ height, active }) => ({ height, active }))).toEqual([
        { height: 1080, active: false },
        { height: 720, active: true },
      ]);
      expect(player.setQuality).toHaveBeenCalledWith(1);
    });

    it('adds no video track for a stream without video levels', () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels([]);

      expect(media.videoTracks.length).toBe(0);
    });

    it('refuses a pick playa already dropped: restores the previous one and drops it from the list', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);

      media.videoRenditions.selectedIndex = 1;
      await settle();
      player.levels = [LEVELS[1]!, LEVELS[2]!].map((level, index) => ({ ...level, index }));
      media.videoRenditions.selectedIndex = 0;
      await settle();

      expect([...media.videoRenditions].map(({ id, selected }) => ({ id, selected }))).toEqual([
        { id: trackId('video-720'), selected: true },
        { id: trackId('video-unsized'), selected: false },
      ]);
      expect(player.setQuality.mock.calls).toEqual([[1]]);
    });

    it('returns to automatic quality when the video levels come back after going empty under a pin', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);
      media.videoRenditions.selectedIndex = 1;
      await flush();
      player.loadLevels([]);
      player.loadLevels(LEVELS);
      await flush();

      expect(media.videoRenditions.selectedIndex).toBe(-1);
      expect(player.setQuality).toHaveBeenLastCalledWith('auto');

      media.videoRenditions.selectedIndex = 1;
      await flush();

      expect(player.setQuality).toHaveBeenLastCalledWith(1);
    });

    it('leaves automatic quality alone', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);
      player.loadLevels(LEVELS_WITHOUT_1080);
      await flush();

      expect(media.videoRenditions.selectedIndex).toBe(-1);
      expect(player.setQuality).not.toHaveBeenCalled();
    });
  });

  describe('when playa rejects a switch', () => {
    const cause = new Error('Cannot select a track while a switch is committing');

    function setup() {
      const media = new OpenMoqMediaTracks();
      const player = load(media);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      player.loadLevels(LEVELS);
      onTestFinished(() => warn.mockRestore());

      return { media, player, warn };
    }

    it('returns to automatic quality when it was in use, with a warning', async () => {
      const { media, player, warn } = setup();

      player.setQuality.mockRejectedValueOnce(cause);
      media.videoRenditions.selectedIndex = 1;
      await settle();

      expect(warn).toHaveBeenCalledWith('[openmoq-video] Failed to switch the video rendition.', cause);
      expect(media.videoRenditions.selectedIndex).toBe(-1);
      expect(player.setQuality).toHaveBeenLastCalledWith('auto');
    });

    it.each([
      ['before', 0, 1],
      ['after', 2, 1],
    ])(
      'selects the previous rendition, listed %s the rejected one, again without switching to it',
      async (_order, previous, rejected) => {
        const { media, player } = setup();

        media.videoRenditions.selectedIndex = previous;
        await settle();
        player.setQuality.mockRejectedValueOnce(cause);
        media.videoRenditions.selectedIndex = rejected;
        await settle();

        expect([...media.videoRenditions].map((rendition) => rendition.selected)).toEqual(
          LEVELS.map((_level, index) => index === previous)
        );
        expect(player.setQuality.mock.calls).toEqual([[previous], [rejected]]);
      }
    );

    it('returns to automatic quality when the previous rendition is gone', async () => {
      const { media, player } = setup();

      media.videoRenditions.selectedIndex = 0;
      await settle();
      player.levels = [LEVELS[1]!, LEVELS[2]!].map((level, index) => ({ ...level, index }));
      player.setQuality.mockRejectedValueOnce(cause);
      media.videoRenditions.selectedIndex = 1;
      await settle();

      expect(media.videoRenditions.selectedIndex).toBe(-1);
      expect(player.setQuality).toHaveBeenLastCalledWith('auto');
    });

    it('ignores a rejection from the previous Player', async () => {
      const { media, player } = setup();
      let reject: (reason: Error) => void = () => {};

      player.setQuality.mockImplementationOnce(
        () =>
          new Promise((_resolve, rejectSwitch) => {
            reject = rejectSwitch;
          })
      );
      media.videoRenditions.selectedIndex = 1;
      await settle();

      const next = load(media);

      next.loadLevels(LEVELS);
      media.videoRenditions.selectedIndex = 1;
      await settle();
      reject(cause);
      await settle();

      expect(media.videoRenditions.selectedIndex).toBe(1);
      expect(next.setQuality.mock.calls).toEqual([[1]]);
    });

    it('keeps a rendition picked while the rejected switch was pending', async () => {
      const { media, player } = setup();
      let reject: (reason: Error) => void = () => {};

      player.setQuality.mockImplementationOnce(
        () =>
          new Promise((_resolve, rejectSwitch) => {
            reject = rejectSwitch;
          })
      );
      media.videoRenditions.selectedIndex = 1;
      await settle();
      media.videoRenditions.selectedIndex = 2;
      await settle();
      reject(cause);
      await settle();

      expect(media.videoRenditions.selectedIndex).toBe(2);
      expect(player.setQuality.mock.calls).toEqual([[1], [2]]);
    });
  });

  it('does not switch while playa has no levels', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.loadLevels(LEVELS);
    player.levels = [];
    media.videoRenditions.selectedIndex = 1;
    await flush();

    expect(player.setQuality).not.toHaveBeenCalled();
  });

  it('marks the level playa adopts once the first frame is rendered, and follows qualitychange', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.loadLevels(LEVELS);

    expect([...media.videoRenditions].map((rendition) => rendition.active)).toEqual([false, false, false]);

    player.currentLevel = 1;
    media.dispatchEvent(new Event('loadeddata'));

    expect([...media.videoRenditions].map((rendition) => rendition.active)).toEqual([false, true, false]);

    player.switchTo(LEVELS[2]!);
    await flush();

    expect([...media.videoRenditions].map((rendition) => rendition.active)).toEqual([false, false, true]);
  });

  it('marks the current level when the same levels are announced again', () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.loadLevels(LEVELS);
    player.currentLevel = 1;
    player.loadLevels(LEVELS);

    expect([...media.videoRenditions].map((rendition) => rendition.active)).toEqual([false, true, false]);
  });

  it('re-reads levels that changed without an announcement before marking the active one', () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);
    const updated = withLevel4k([LEVELS[0]!, LEVELS[1]!]);

    player.loadLevels([LEVELS[0]!, LEVELS[1]!]);
    player.levels = updated;
    player.switchTo(updated[1]!);

    expect(media.videoRenditions.length).toBe(3);
    expect([...media.videoRenditions].filter((rendition) => rendition.active).map(({ height }) => height)).toEqual([
      1080,
    ]);
  });

  it('announces the renditions it removes', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);
    const onRemoveRendition = vi.fn();

    player.loadLevels(LEVELS);
    media.videoRenditions.addEventListener('removerendition', onRemoveRendition);
    media.dispatchEvent(new Event('emptied'));
    await flush();

    expect(onRemoveRendition).toHaveBeenCalledTimes(LEVELS.length);
  });

  it.each([
    ['loadstart', load],
    ['emptied', (media: InstanceType<typeof OpenMoqMediaTracks>) => media.dispatchEvent(new Event('emptied'))],
    ['detach', (media: InstanceType<typeof OpenMoqMediaTracks>) => media.detach()],
    ['destroy', (media: InstanceType<typeof OpenMoqMediaTracks>) => media.destroy()],
  ])('clears the list and stops listening to the previous Player on %s', (_type, replace) => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    player.loadLevels(LEVELS);
    replace(media);
    player.loadLevels(LEVELS);

    expect(media.videoTracks.length).toBe(0);
    expect(media.videoRenditions.length).toBe(0);
  });
});
