import { type Level, Player, type PlayerEventMap } from '@openmoq/playa';
import { MediaError } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { OpenMoqAdapter, type OpenMoqSource } from '../index';

const SOURCE: OpenMoqSource = { url: 'https://relay.example.com/moq', namespace: 'live' };
const OTHER_URL = 'https://relay.example.com/other';
const UNKNOWN_LIVE_VALUES = {
  streamType: 'unknown',
  duration: Number.NaN,
  targetLiveWindow: Number.NaN,
  liveEdgeStart: Number.NaN,
};
const LIVE_EVENTS = ['loadedmetadata', 'durationchange', 'streamtypechange', 'targetlivewindowchange', 'emptied'];
const ON_DEMAND_TRACK: CatalogVideoTrack = {
  name: 'video-720p',
  packaging: 'cmaf',
  isLive: false,
  trackDuration: 30_000,
};

type CatalogVideoTrack = Player['videoGroups'][number]['tracks'][number];

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mirrors the host template: the canvas playa may draw into sits beside the video. */
function setup() {
  const container = document.createElement('div');
  const video = document.createElement('video');
  const media = new OpenMoqAdapter();

  container.append(video, document.createElement('canvas'));
  media.attach(video);

  return media;
}

function nextEvent(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(type, () => resolve(), { once: true });
  });
}

function recordEvents(target: EventTarget, types: string[]): string[] {
  const events: string[] = [];

  for (const type of types) target.addEventListener(type, () => events.push(type));

  return events;
}

function liveValues(media: OpenMoqAdapter) {
  const { streamType, duration, targetLiveWindow, liveEdgeStart } = media;

  return { streamType, duration, targetLiveWindow, liveEdgeStart };
}

/** Stubs the relay session out of `load()` and lets a test emit the events playa would. */
function stubPlaya() {
  const handlers = new Map<string, (data: never) => void>();
  const on = Player.prototype.on;

  vi.spyOn(Player.prototype, 'load').mockResolvedValue();
  vi.spyOn(Player.prototype, 'on').mockImplementation(function (this: Player, event, handler) {
    handlers.set(event, handler);
    return on.call(this, event, handler);
  });

  return <K extends keyof PlayerEventMap>(event: K, data: PlayerEventMap[K]): void => {
    // SAFETY: The handler stored for `event` was registered by `on(event)`, so it takes this event's payload.
    handlers.get(event)?.(data as never);
  };
}

function stubCatalog(tracks: CatalogVideoTrack[]): void {
  vi.spyOn(Player.prototype, 'videoGroups', 'get').mockReturnValue([{ altGroup: 1, tracks }]);
}

function level(index: number, trackName: string): Level {
  return { index, trackName, label: trackName, codec: 'avc1.640028', width: 1280, height: 720, bitrate: 1_000_000 };
}

/** Playa's order up to the catalog: `statechange` to `loading`, then `ready`. */
async function loadMetadata(media: OpenMoqAdapter, emit: ReturnType<typeof stubPlaya>): Promise<void> {
  media.source = SOURCE;
  await nextEvent(media, 'loadstart');

  emit('statechange', { state: 'loading' });
  emit('ready', { levels: [], audioTracks: [] });
}

/** Without WebTransport in jsdom, a load fails, or is cut short by destroy, within a task. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('OpenMoqAdapter', () => {
  describe('attach', () => {
    it('builds no Player for a video without a sibling canvas', async () => {
      const container = document.createElement('div');
      const video = document.createElement('video');
      const media = new OpenMoqAdapter();
      const loadstart = vi.fn();

      container.append(video);
      media.addEventListener('loadstart', loadstart);
      media.attach(video);
      media.source = SOURCE;
      await flush();

      expect(media.engine).toBeNull();
      expect(loadstart).not.toHaveBeenCalled();
    });
  });

  describe('detach', () => {
    it('destroys the Player and ignores its load failing afterwards', async () => {
      const media = setup();
      const onError = vi.fn();

      media.addEventListener('error', onError);
      media.source = SOURCE;
      await nextEvent(media, 'loadstart');

      const player = media.engine;

      media.detach();
      await flush();

      expect(media.engine).toBeNull();
      expect(player?.state).toBe('idle');
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('src', () => {
    it('keeps the rest of the source', () => {
      const media = new OpenMoqAdapter();

      media.source = { ...SOURCE, catalogTrackName: 'catalog' };
      media.src = OTHER_URL;

      expect(media.source).toEqual({ ...SOURCE, catalogTrackName: 'catalog', url: OTHER_URL });
    });

    it('clears the source and drops the load in flight when emptied', async () => {
      const media = setup();
      const onError = vi.fn();

      media.addEventListener('error', onError);
      media.source = SOURCE;
      await nextEvent(media, 'loadstart');

      const player = media.engine;

      media.src = '';
      await flush();

      expect(media.source).toBeNull();
      expect(media.engine).toBeNull();
      expect(player?.state).toBe('idle');
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('source', () => {
    it('builds a playa Player and fires loadstart', async () => {
      const media = setup();
      const loadstart = nextEvent(media, 'loadstart');

      media.source = SOURCE;
      await loadstart;

      expect(media.engine).toBeInstanceOf(Player);
    });

    it('destroys the previous Player before building one for a new source', async () => {
      const media = setup();
      const emptied = vi.fn();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');

      const previous = media.engine;

      media.addEventListener('emptied', emptied);
      media.source = { ...SOURCE, url: OTHER_URL };
      await nextEvent(media, 'loadstart');

      expect(emptied).toHaveBeenCalledOnce();
      expect(previous?.state).toBe('idle');
      expect(media.engine).toBeInstanceOf(Player);
      expect(media.engine).not.toBe(previous);
    });
  });

  describe('error', () => {
    it('reports a failed load as a fatal network error', async () => {
      const media = setup();
      const onError = vi.fn();

      media.addEventListener('error', onError);
      media.source = SOURCE;
      await flush();

      expect(onError).toHaveBeenCalledOnce();
      expect(media.error).toMatchObject({ code: MediaError.MEDIA_ERR_NETWORK, fatal: true });
    });

    it('clears for a new source and reports its failure again', async () => {
      const media = setup();
      const onError = vi.fn();

      media.addEventListener('error', onError);
      media.source = SOURCE;
      await flush();

      media.src = OTHER_URL;

      expect(media.error).toBeNull();

      await flush();

      expect(onError).toHaveBeenCalledTimes(2);
    });
  });

  describe('live state', () => {
    it('is unknown with every live value NaN before metadata', async () => {
      stubPlaya();

      const media = setup();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');

      expect(liveValues(media)).toEqual(UNKNOWN_LIVE_VALUES);
    });

    it('turns live on metadata, with a live edge at the playback position', async () => {
      const emit = stubPlaya();
      const media = setup();
      const events = recordEvents(media, LIVE_EVENTS);

      vi.spyOn(Player.prototype, 'currentTime', 'get').mockReturnValue(12_500);
      await loadMetadata(media, emit);

      expect(events).toEqual(['loadedmetadata', 'durationchange', 'streamtypechange', 'targetlivewindowchange']);
      expect(liveValues(media)).toEqual({
        streamType: 'live',
        duration: Number.POSITIVE_INFINITY,
        targetLiveWindow: 0,
        liveEdgeStart: 12.5,
      });
    });

    it.each([
      { from: 'playing', events: ['timeupdate', 'pause', 'ended'] },
      { from: 'paused', events: ['timeupdate', 'ended'] },
    ] as const)('has no live edge once playa ends while $from', async ({ from, events: expected }) => {
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);
      emit('statechange', { state: from });

      const events = recordEvents(media, ['timeupdate', 'pause', 'ended']);

      emit('statechange', { state: 'ended' });
      emit('ended', {});

      expect(events).toEqual(expected);
      expect(liveValues(media)).toEqual({
        streamType: 'live',
        duration: Number.POSITIVE_INFINITY,
        targetLiveWindow: 0,
        liveEdgeStart: Number.NaN,
      });
    });

    it('fires no change when playa is ready again', async () => {
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);

      const events = recordEvents(media, LIVE_EVENTS);

      emit('ready', { levels: [], audioTracks: [] });

      expect(events).toEqual([]);
    });

    it('resets before emptied when the source is cleared', async () => {
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);

      const events = recordEvents(media, LIVE_EVENTS);

      media.source = null;

      expect(events).toEqual(['streamtypechange', 'targetlivewindowchange', 'emptied']);
      expect(liveValues(media)).toEqual(UNKNOWN_LIVE_VALUES);
    });

    it('resets on detach', async () => {
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);

      const events = recordEvents(media, LIVE_EVENTS);

      media.detach();

      expect(events).toEqual(['streamtypechange', 'targetlivewindowchange']);
      expect(liveValues(media)).toEqual(UNKNOWN_LIVE_VALUES);
    });
  });

  describe('streamType', () => {
    it('is on-demand for an on-demand catalog track, with its duration and no live window', async () => {
      const emit = stubPlaya();
      const media = setup();
      const events = recordEvents(media, LIVE_EVENTS);

      stubCatalog([ON_DEMAND_TRACK]);
      await loadMetadata(media, emit);

      expect(events).toEqual(['loadedmetadata', 'durationchange', 'streamtypechange']);
      expect(liveValues(media)).toEqual({
        streamType: 'on-demand',
        duration: 30,
        targetLiveWindow: Number.NaN,
        liveEdgeStart: Number.NaN,
      });
    });

    it('has no duration for an on-demand track without one', async () => {
      const emit = stubPlaya();
      const media = setup();

      stubCatalog([{ name: 'video-720p', packaging: 'cmaf', isLive: false }]);
      await loadMetadata(media, emit);

      expect(media.streamType).toBe('on-demand');
      expect(media.duration).toBeNaN();
    });

    it('follows the catalog track of the current level', async () => {
      const emit = stubPlaya();
      const media = setup();

      stubCatalog([{ name: 'video-1080p', packaging: 'cmaf', isLive: true }, ON_DEMAND_TRACK]);
      vi.spyOn(Player.prototype, 'levels', 'get').mockReturnValue([level(0, 'video-1080p'), level(1, 'video-720p')]);
      vi.spyOn(Player.prototype, 'currentLevel', 'get').mockReturnValue(1);
      await loadMetadata(media, emit);

      expect(media.streamType).toBe('on-demand');
    });

    it('resets from on-demand without a live window change when the source is cleared', async () => {
      const emit = stubPlaya();
      const media = setup();

      stubCatalog([ON_DEMAND_TRACK]);
      await loadMetadata(media, emit);

      const events = recordEvents(media, LIVE_EVENTS);

      media.source = null;

      expect(events).toEqual(['streamtypechange', 'emptied']);
      expect(liveValues(media)).toEqual(UNKNOWN_LIVE_VALUES);
    });
  });

  describe('liveEdgeStart', () => {
    it('runs on wall time from the first playing, ahead of a stopped playhead', async () => {
      const emit = stubPlaya();
      const media = setup();
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      const currentTime = vi.spyOn(Player.prototype, 'currentTime', 'get').mockReturnValue(12_500);

      vi.spyOn(Player.prototype, 'state', 'get').mockReturnValue('playing');
      await loadMetadata(media, emit);
      emit('playing', {});
      now.mockReturnValue(4_000);

      expect(media.liveEdgeStart).toBe(15.5);

      currentTime.mockReturnValue(13_000);
      emit('play', {});

      expect(media.liveEdgeStart).toBe(15.5);
    });

    it('follows the playback position again for a new source until it plays', async () => {
      const emit = stubPlaya();
      const media = setup();
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);

      vi.spyOn(Player.prototype, 'currentTime', 'get').mockReturnValue(12_500);
      vi.spyOn(Player.prototype, 'state', 'get').mockReturnValue('playing');
      await loadMetadata(media, emit);
      emit('playing', {});
      now.mockReturnValue(4_000);
      media.load();
      await nextEvent(media, 'loadstart');
      emit('statechange', { state: 'loading' });
      emit('ready', { levels: [], audioTracks: [] });

      expect(media.liveEdgeStart).toBe(12.5);
    });
  });

  describe('duration', () => {
    it('stays Infinity when playa reports a duration', async () => {
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);

      const events = recordEvents(media, LIVE_EVENTS);

      vi.spyOn(Player.prototype, 'duration', 'get').mockReturnValue(5_000);
      emit('durationchange', { duration: 5_000 });

      expect(media.duration).toBe(Number.POSITIVE_INFINITY);
      expect(events).toEqual([]);
    });
  });

  describe('pause', () => {
    it('fires timeupdate before pause, as a media element does', async () => {
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);
      emit('statechange', { state: 'playing' });

      const events = recordEvents(media, ['timeupdate', 'pause']);

      emit('statechange', { state: 'paused' });
      emit('pause', {});

      expect(events).toEqual(['timeupdate', 'pause']);
    });

    it('leaves a Player that is still loading alone', async () => {
      const media = setup();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');

      expect(() => media.pause()).not.toThrow();
      expect(media.engine?.state).toBe('loading');
    });
  });
});
