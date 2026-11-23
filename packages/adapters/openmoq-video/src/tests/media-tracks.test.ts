import type { Level, Player, PlayerEventMap } from '@openmoq/playa';
import { MediaTracksMixin } from '@videojs/media/media-tracks';
import { describe, expect, it, vi } from 'vite-plus/test';

import { OpenMoqMediaTracksMixin } from '../media-tracks';

const LEVELS: Level[] = [
  {
    index: 0,
    trackName: 'video-1080',
    label: '1080p',
    codec: 'avc1.640028',
    width: 1920,
    height: 1080,
    bitrate: 6_000_000,
  },
  {
    index: 1,
    trackName: 'video-720',
    label: '720p',
    codec: 'avc1.64001f',
    width: 1280,
    height: 720,
    bitrate: 3_000_000,
  },
  { index: 2, trackName: 'video-unsized', label: 'video', codec: 'avc1.42e01e', width: 0, height: 0, bitrate: 0 },
];

class FakePlayer {
  levels: Level[] = [];
  currentLevel = -1;
  autoQuality = true;
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
}

class FakeHost extends EventTarget {
  engine: Player | null = null;

  detach(): void {}

  destroy(): void {
    this.detach();
  }
}

const OpenMoqMediaTracks = OpenMoqMediaTracksMixin(MediaTracksMixin(FakeHost));

/** Binds a new Player the way the adapter does: set as `engine`, then announced by `loadstart`. */
function load(media: InstanceType<typeof OpenMoqMediaTracks>): FakePlayer {
  const player = new FakePlayer();

  // SAFETY: The fake implements the Player members and events used by this mixin, which does not need its nominal brand.
  media.engine = player as unknown as Player;
  media.dispatchEvent(new Event('loadstart'));

  return player;
}

function flush(): Promise<void> {
  return Promise.resolve();
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
      { id: '0', width: 1920, height: 1080, codec: 'avc1.640028', bitrate: 6_000_000 },
      { id: '1', width: 1280, height: 720, codec: 'avc1.64001f', bitrate: 3_000_000 },
      { id: '2', width: undefined, height: undefined, codec: 'avc1.42e01e', bitrate: undefined },
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

    it('re-applies the pinned level under its new index', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);
      media.videoRenditions.selectedIndex = 1;
      await flush();
      player.autoQuality = false;
      player.loadLevels(LEVELS_WITHOUT_1080);
      await flush();

      expect(media.videoRenditions.selectedIndex).toBe(0);
      expect(media.videoRenditions[0]?.height).toBe(720);
      expect(player.setQuality).toHaveBeenLastCalledWith(0);
    });

    it('returns to automatic quality when the pinned level is gone', async () => {
      const media = new OpenMoqMediaTracks();
      const player = load(media);

      player.loadLevels(LEVELS);
      media.videoRenditions.selectedIndex = 0;
      await flush();
      player.autoQuality = false;
      player.loadLevels(LEVELS_WITHOUT_1080);
      await flush();

      expect(media.videoRenditions.selectedIndex).toBe(-1);
      expect(player.setQuality).toHaveBeenLastCalledWith('auto');
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

  it('ignores a switch that playa rejects, with a warning', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cause = new Error('track unavailable');

    player.setQuality.mockRejectedValueOnce(cause);
    player.loadLevels(LEVELS);
    media.videoRenditions.selectedIndex = 1;
    await flush();
    await flush();

    expect(warn).toHaveBeenCalledWith('[openmoq-video] Failed to switch the video rendition.', cause);

    warn.mockRestore();
  });

  it('does not switch before playa has levels', () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);

    media.videoRenditions.dispatchEvent(new Event('change'));

    expect(player.setQuality).not.toHaveBeenCalled();
  });

  it('marks the level playa adopts once the first frame is rendered, and follows qualitychange', async () => {
    const media = new OpenMoqMediaTracks();
    const player = load(media);
    const onActiveChange = vi.fn();

    media.videoRenditions.addEventListener('activechange', onActiveChange);
    player.loadLevels(LEVELS);

    expect([...media.videoRenditions].map((rendition) => rendition.active)).toEqual([false, false, false]);

    player.currentLevel = 1;
    media.dispatchEvent(new Event('loadeddata'));

    expect([...media.videoRenditions].map((rendition) => rendition.active)).toEqual([false, true, false]);

    player.emit('qualitychange', { level: LEVELS[2]!, auto: true });
    await flush();

    expect([...media.videoRenditions].map((rendition) => rendition.active)).toEqual([false, false, true]);
    expect(onActiveChange).toHaveBeenCalled();
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
    const reordered = [LEVELS[1]!, LEVELS[0]!].map((level, index) => ({ ...level, index }));

    player.loadLevels(LEVELS);
    player.levels = reordered;
    player.emit('qualitychange', { level: reordered[1]!, auto: true });

    expect([...media.videoRenditions].map(({ height, active }) => ({ height, active }))).toEqual([
      { height: 720, active: false },
      { height: 1080, active: true },
    ]);
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
