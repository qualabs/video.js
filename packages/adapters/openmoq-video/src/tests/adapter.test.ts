import { type Level, Player, type PlayerEventMap } from '@openmoq/playa';
import { MediaError, type TimeRangeLike } from '@videojs/media';
import { noop } from '@videojs/utils/function';
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

type Emit = ReturnType<typeof stubPlaya>;

interface Playhead {
  position: number;
  buffered: [number, number][];
}

const adapters: OpenMoqAdapter[] = [];

afterEach(() => {
  for (const media of adapters.splice(0)) media.destroy();

  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Mirrors the host template: the canvas playa may draw into sits beside the video. */
function setup() {
  const container = document.createElement('div');
  const video = document.createElement('video');
  const media = new OpenMoqAdapter();

  adapters.push(media);
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
async function loadMetadata(media: OpenMoqAdapter, emit: Emit): Promise<void> {
  media.source = SOURCE;
  await nextEvent(media, 'loadstart');

  emit('statechange', { state: 'loading' });
  emit('ready', { levels: [], audioTracks: [] });
}

/** Plays a loaded live stream from 12.5 s and pauses it, with playa's state order. */
async function playThenPause(media: OpenMoqAdapter, emit: Emit): Promise<void> {
  const state = vi.spyOn(Player.prototype, 'state', 'get').mockReturnValue('playing');

  vi.spyOn(Player.prototype, 'currentTime', 'get').mockReturnValue(12_500);
  await loadMetadata(media, emit);
  emit('statechange', { state: 'playing' });
  emit('playing', {});
  state.mockReturnValue('paused');
  emit('statechange', { state: 'paused' });
  emit('pause', {});
}

/** Plays a loaded live stream on the given path, with a playhead and a `<video>` buffer the test can move. */
async function playLive(media: OpenMoqAdapter, emit: Emit, mediaType: 'video' | 'canvas' = 'video') {
  const playhead: Playhead = { position: 12.5, buffered: [[0, 14]] };
  const state = vi.spyOn(Player.prototype, 'state', 'get').mockReturnValue('playing');
  const play = vi.spyOn(Player.prototype, 'play').mockImplementation(() => {
    state.mockReturnValue('playing');
    emit('statechange', { state: 'playing' });
    emit('play', {});
  });

  vi.spyOn(Player.prototype, 'activeMediaType', 'get').mockReturnValue(mediaType);
  vi.spyOn(Player.prototype, 'currentTime', 'get').mockImplementation(() => playhead.position * 1000);
  vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockImplementation(() => playhead.position);
  vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation((value) => {
    playhead.position = value;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'buffered', 'get').mockImplementation(() => timeRanges(playhead.buffered));
  await loadMetadata(media, emit);
  emit('statechange', { state: 'playing' });
  emit('playing', {});

  const pause = () => {
    state.mockReturnValue('paused');
    emit('statechange', { state: 'paused' });
    emit('pause', {});
  };

  return { playhead, play, pause };
}

function timeRanges(ranges: [number, number][]): TimeRanges {
  return { length: ranges.length, start: (i) => ranges[i]![0], end: (i) => ranges[i]![1] };
}

function ranges(timeRanges: TimeRangeLike): [number, number][] {
  return Array.from({ length: timeRanges.length }, (_, i) => [timeRanges.start(i), timeRanges.end(i)]);
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
    it('runs on wall time from the first playing on CMAF, ahead of a stopped playhead', async () => {
      const emit = stubPlaya();
      const media = setup();
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      const currentTime = vi.spyOn(Player.prototype, 'currentTime', 'get').mockReturnValue(12_500);

      vi.spyOn(Player.prototype, 'activeMediaType', 'get').mockReturnValue('video');
      vi.spyOn(Player.prototype, 'state', 'get').mockReturnValue('playing');
      await loadMetadata(media, emit);
      emit('playing', {});
      now.mockReturnValue(4_000);

      expect(media.liveEdgeStart).toBe(15.5);

      currentTime.mockReturnValue(13_000);
      emit('play', {});

      expect(media.liveEdgeStart).toBe(15.5);
    });

    it('restarts from the playback position on every playing on LOC', async () => {
      const emit = stubPlaya();
      const media = setup();
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);

      vi.spyOn(Player.prototype, 'currentTime', 'get').mockReturnValue(12_500);
      vi.spyOn(Player.prototype, 'activeMediaType', 'get').mockReturnValue('canvas');
      vi.spyOn(Player.prototype, 'state', 'get').mockReturnValue('playing');
      await loadMetadata(media, emit);
      emit('playing', {});
      now.mockReturnValue(4_000);
      emit('play', {});
      now.mockReturnValue(5_000);

      expect(media.liveEdgeStart).toBe(13.5);
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

  describe('seekable', () => {
    it('is empty before metadata and once ended', async () => {
      const emit = stubPlaya();
      const media = setup();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');

      expect(media.seekable.length).toBe(0);

      emit('statechange', { state: 'loading' });
      emit('ready', { levels: [], audioTracks: [] });

      expect(media.seekable.length).toBe(1);

      emit('statechange', { state: 'ended' });

      expect(media.seekable.length).toBe(0);
    });

    it('is empty on demand', async () => {
      const emit = stubPlaya();
      const media = setup();

      stubCatalog([ON_DEMAND_TRACK]);
      await loadMetadata(media, emit);

      expect(media.seekable.length).toBe(0);
    });

    it('runs from the playback position to the live edge', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead } = await playLive(media, emit);

      expect(ranges(media.seekable)).toEqual([[12.5, 12.5]]);

      vi.advanceTimersByTime(4_000);

      expect(ranges(media.seekable)).toEqual([[12.5, 16.5]]);

      playhead.position = 17;

      expect(ranges(media.seekable)).toEqual([[16.5, 16.5]]);
    });
  });

  describe('buffered', () => {
    it('is the video buffer on CMAF', async () => {
      const emit = stubPlaya();
      const media = setup();
      const { playhead } = await playLive(media, emit);

      playhead.buffered = [
        [0, 14],
        [20, 25],
      ];

      expect(ranges(media.buffered)).toEqual(playhead.buffered);
    });

    it('is empty on LOC and before a Player exists', async () => {
      const emit = stubPlaya();
      const media = setup();

      expect(media.buffered.length).toBe(0);

      await playLive(media, emit, 'canvas');

      expect(media.buffered.length).toBe(0);
    });
  });

  describe('progress', () => {
    it('fires every second on live, playing and paused, so the live edge is read again as it moves', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const edges: number[] = [];

      media.addEventListener('progress', () => edges.push(media.liveEdgeStart));

      const { pause } = await playLive(media, emit);

      vi.advanceTimersByTime(3_000);
      pause();
      vi.advanceTimersByTime(3_000);

      expect(edges).toEqual([13.5, 14.5, 15.5, 16.5, 17.5, 18.5]);
    });

    it('keeps a single tick across a pause and a resume', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      const emit = stubPlaya();
      const media = setup();
      const { pause } = await playLive(media, emit);

      pause();
      await media.play();

      const events = recordEvents(media, ['progress']);

      vi.advanceTimersByTime(1_000);

      expect(events).toEqual(['progress']);
    });

    it.each(['ended', 'error'] as const)('stops on %s', async (state) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      const emit = stubPlaya();
      const media = setup();

      await playThenPause(media, emit);

      const events = recordEvents(media, ['progress']);

      vi.advanceTimersByTime(1_000);
      emit('statechange', { state });
      vi.advanceTimersByTime(3_000);

      expect(events).toEqual(['progress']);
    });

    it('stops when the source is cleared', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      const emit = stubPlaya();
      const media = setup();

      await playLive(media, emit);

      const events = recordEvents(media, ['progress']);

      media.source = null;
      vi.advanceTimersByTime(3_000);

      expect(events).toEqual([]);
    });

    it('does not fire on demand', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      stubCatalog([ON_DEMAND_TRACK]);

      const emit = stubPlaya();
      const media = setup();

      await playThenPause(media, emit);
      emit('statechange', { state: 'playing' });
      emit('play', {});

      const events = recordEvents(media, ['progress']);

      vi.advanceTimersByTime(3_000);

      expect(events).toEqual([]);
    });
  });

  describe('currentTime', () => {
    it('jumps to 2 s before the end of a newer buffered range and takes it as the live edge on CMAF', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead } = await playLive(media, emit);
      const events = recordEvents(media, ['seeking', 'seeked']);

      vi.advanceTimersByTime(10_000);
      playhead.buffered = [
        [0, 14],
        [20, 25],
      ];
      media.currentTime = media.liveEdgeStart;
      await nextEvent(media, 'seeked');

      expect(playhead.position).toBe(23);
      expect(media.liveEdgeStart).toBe(23);
      expect(events).toEqual(['seeking', 'seeked']);
    });

    it('jumps to the start of a newer range shorter than 2 s', async () => {
      const emit = stubPlaya();
      const media = setup();
      const { playhead } = await playLive(media, emit);

      playhead.buffered = [
        [0, 14],
        [20, 21],
      ];
      media.currentTime = 30;

      expect(playhead.position).toBe(20);
    });

    it('waits for a newer range while playing, settling the seek at once', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead } = await playLive(media, emit);
      const seeked = nextEvent(media, 'seeked');

      media.currentTime = 20;
      await seeked;

      expect(playhead.position).toBe(12.5);

      playhead.buffered = [
        [0, 14],
        [20, 25],
      ];
      vi.advanceTimersByTime(1_000);

      expect(playhead.position).toBe(23);

      playhead.buffered.push([40, 45]);
      vi.advanceTimersByTime(1_000);

      expect(playhead.position).toBe(23);
    });

    it('resumes a paused stream and jumps once a newer range is buffered on CMAF', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead, play, pause } = await playLive(media, emit);

      vi.advanceTimersByTime(1_000);
      pause();
      vi.advanceTimersByTime(10_000);
      media.currentTime = media.liveEdgeStart;
      await nextEvent(media, 'seeked');

      expect(play).toHaveBeenCalledOnce();
      expect(media.paused).toBe(false);

      vi.advanceTimersByTime(2_000);

      expect(playhead.position).toBe(12.5);

      playhead.buffered = [
        [0, 14],
        [30, 34],
      ];
      vi.advanceTimersByTime(1_000);

      expect(playhead.position).toBe(32);
      expect(media.liveEdgeStart).toBe(32);
    });

    it('leaves a paused playhead alone until playa plays again', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead, play, pause } = await playLive(media, emit);

      play.mockImplementation(noop);
      pause();
      playhead.buffered = [
        [0, 14],
        [20, 25],
      ];
      media.currentTime = 20;

      expect(playhead.position).toBe(12.5);
    });

    it.each<{ cancel: string; run: (media: OpenMoqAdapter, emit: Emit, pause: () => void) => void | Promise<void> }>([
      { cancel: 'a pause', run: (_media, _emit, pause) => pause() },
      {
        cancel: 'a pause and a resume',
        run: (media, _emit, pause) => {
          pause();
          return media.play();
        },
      },
      {
        cancel: 'an earlier target',
        run: (media) => {
          media.currentTime = 5;
        },
      },
      {
        cancel: 'a cleared source',
        run: (media) => {
          media.source = null;
        },
      },
      { cancel: 'an error', run: (_media, emit) => emit('statechange', { state: 'error' }) },
      {
        cancel: 'a 10 s wait',
        run: () => {
          vi.advanceTimersByTime(10_000);
        },
      },
    ])('drops a waiting jump on $cancel', async ({ run }) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const live = await playLive(media, emit);

      media.currentTime = 20;
      await run(media, emit, live.pause);
      live.playhead.buffered = [
        [0, 14],
        [20, 25],
      ];
      vi.advanceTimersByTime(1_000);

      expect(live.playhead.position).toBe(12.5);
    });

    it('drops a waiting jump with the Player it was asked of', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead } = await playLive(media, emit);

      media.currentTime = 20;
      media.load();
      await nextEvent(media, 'loadstart');
      emit('statechange', { state: 'loading' });
      emit('ready', { levels: [], audioTracks: [] });
      emit('statechange', { state: 'playing' });
      emit('playing', {});
      playhead.buffered = [
        [0, 14],
        [20, 25],
      ];
      vi.advanceTimersByTime(1_000);

      expect(playhead.position).toBe(12.5);
    });

    it('ignores an earlier target, settling the seek', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead, play, pause } = await playLive(media, emit);
      const events = recordEvents(media, ['seeking', 'seeked']);

      playhead.buffered = [
        [0, 14],
        [20, 25],
      ];
      vi.advanceTimersByTime(10_000);
      pause();
      media.currentTime = 5;
      await nextEvent(media, 'seeked');

      expect(playhead.position).toBe(12.5);
      expect(play).not.toHaveBeenCalled();
      expect(media.liveEdgeStart).toBe(22.5);
      expect(events).toEqual(['seeking', 'seeked']);
    });

    it('takes the playback position as the live edge on LOC, where playa is already at live', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead } = await playLive(media, emit, 'canvas');
      const setVideoTime = vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set');

      vi.advanceTimersByTime(5_000);
      playhead.position = 14;
      media.currentTime = media.liveEdgeStart;

      expect(media.liveEdgeStart).toBe(14);
      expect(setVideoTime).not.toHaveBeenCalled();
    });

    it('takes a target just behind the live edge as live too', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead } = await playLive(media, emit, 'canvas');

      vi.advanceTimersByTime(1_000);
      playhead.position = 14;
      media.currentTime = 13.5;

      expect(media.liveEdgeStart).toBe(14);
    });

    it('resumes a paused stream on LOC, which takes the live edge from the next playing', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

      const emit = stubPlaya();
      const media = setup();
      const { playhead, play, pause } = await playLive(media, emit, 'canvas');

      pause();
      vi.advanceTimersByTime(10_000);
      playhead.position = 13;
      media.currentTime = media.liveEdgeStart;
      await nextEvent(media, 'playing');

      expect(play).toHaveBeenCalledOnce();
      expect(media.liveEdgeStart).toBe(13);
    });

    it('ignores every target on demand', async () => {
      const emit = stubPlaya();
      const media = setup();
      const play = vi.spyOn(Player.prototype, 'play').mockImplementation(noop);
      const setVideoTime = vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set');

      stubCatalog([ON_DEMAND_TRACK]);
      vi.spyOn(Player.prototype, 'activeMediaType', 'get').mockReturnValue('video');
      await playThenPause(media, emit);
      media.currentTime = 25;
      await nextEvent(media, 'seeked');

      expect(play).not.toHaveBeenCalled();
      expect(setVideoTime).not.toHaveBeenCalled();
    });

    it('ignores a forward target before the stream first plays', async () => {
      const emit = stubPlaya();
      const media = setup();
      const play = vi.spyOn(Player.prototype, 'play').mockImplementation(noop);

      vi.spyOn(Player.prototype, 'state', 'get').mockReturnValue('loading');
      await loadMetadata(media, emit);
      media.currentTime = 25;
      await flush();

      expect(play).not.toHaveBeenCalled();
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
