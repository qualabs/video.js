import { Player, type PlayerEventMap } from '@openmoq/playa';
import { PlayerErrorCode } from '@openmoq/player';
import { MediaError } from '@videojs/media';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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
const MEDIA_ERROR_CODE_BY_PLAYA_ERROR_CODE = new Map<number, number>([
  [PlayerErrorCode.CONTROL_STREAM_LOST, MediaError.MEDIA_ERR_NETWORK],
  [PlayerErrorCode.DATA_STREAM_RESET, MediaError.MEDIA_ERR_NETWORK],
  [PlayerErrorCode.DATAGRAM_DECODE_ERROR, MediaError.MEDIA_ERR_NETWORK],
  [PlayerErrorCode.CONNECTION_LOST, MediaError.MEDIA_ERR_NETWORK],
  [PlayerErrorCode.REQUEST_UPDATE_FAILED, MediaError.MEDIA_ERR_NETWORK],
  [PlayerErrorCode.MEDIA_STARVED, MediaError.MEDIA_ERR_NETWORK],
  [PlayerErrorCode.VIDEO_DECODE_ERROR, MediaError.MEDIA_ERR_DECODE],
  [PlayerErrorCode.AUDIO_DECODE_ERROR, MediaError.MEDIA_ERR_DECODE],
  [PlayerErrorCode.MEDIA_ELEMENT_WEDGED, MediaError.MEDIA_ERR_DECODE],
  [PlayerErrorCode.MEDIA_GAP_UNRECOVERABLE, MediaError.MEDIA_ERR_DECODE],
  [PlayerErrorCode.CODEC_UNSUPPORTED, MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED],
  [PlayerErrorCode.CATALOG_PARSE_ERROR, MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED],
  [PlayerErrorCode.CATALOG_DELTA_ERROR, MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED],
  [PlayerErrorCode.CMAF_INIT_INVALID, MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED],
  [PlayerErrorCode.CMAF_INIT_TIMEOUT, MediaError.MEDIA_ERR_DECODE],
  [PlayerErrorCode.CATALOG_WAIT_TIMEOUT, MediaError.MEDIA_ERR_NETWORK],
  [PlayerErrorCode.SEEK_FAILED, MediaError.MEDIA_ERR_CUSTOM],
  [PlayerErrorCode.LOAD_FAILED, MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED],
  [PlayerErrorCode.SUBSCRIPTION_REFUSED, MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED],
  [PlayerErrorCode.ALL_TRACKS_REFUSED, MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED],
  [PlayerErrorCode.SELECTION_FAILED, MediaError.MEDIA_ERR_CUSTOM],
]);
const PLAYA_ERRORS = Object.entries(PlayerErrorCode).map(([name, playaErrorCode]) => ({
  name,
  playaErrorCode,
  code: MEDIA_ERROR_CODE_BY_PLAYA_ERROR_CODE.get(playaErrorCode),
}));

// jsdom has neither `VideoDecoder` nor `MediaSource`, so playa reports itself unsupported.
beforeEach(() => {
  vi.spyOn(Player, 'checkSupport').mockReturnValue({ ...Player.checkSupport(), supported: true });
});

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
    it('reports a failed load as a fatal network error with its default message', async () => {
      const media = setup();
      const onError = vi.fn();

      media.addEventListener('error', onError);
      media.source = SOURCE;
      await flush();

      expect(onError).toHaveBeenCalledOnce();
      expect(media.error).toMatchObject({
        code: MediaError.MEDIA_ERR_NETWORK,
        fatal: true,
        message: MediaError.defaultMessages[MediaError.MEDIA_ERR_NETWORK],
      });
      expect(media.error?.data).toEqual({ cause: expect.any(Error) });
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

    it.each(PLAYA_ERRORS)('reports a fatal $name as MediaError code $code', async ({ playaErrorCode, code }) => {
      const emit = stubPlaya();
      const media = setup();
      const onError = vi.fn();

      media.addEventListener('error', onError);
      await loadMetadata(media, emit);
      emit('error', { severity: 'fatal', code: playaErrorCode, message: 'playa failure' });

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]?.[0]).toMatchObject({ error: media.error, message: media.error?.message });
      expect(media.error).toMatchObject({ code, fatal: true, data: { playaErrorCode, message: 'playa failure' } });
    });

    it("shows the default message of the mapped code instead of playa's", async () => {
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);
      emit('error', { severity: 'fatal', code: PlayerErrorCode.CONNECTION_LOST, message: 'playa failure' });

      expect(media.error?.message).toBe(MediaError.defaultMessages[MediaError.MEDIA_ERR_NETWORK]);
    });

    it("warns with playa's code and message", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);
      emit('error', { severity: 'fatal', code: PlayerErrorCode.SUBSCRIPTION_REFUSED, message: 'catalog refused' });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('0x1302: catalog refused'));
    });

    it("reports an unknown fatal code as a custom error with playa's message", async () => {
      const emit = stubPlaya();
      const media = setup();

      await loadMetadata(media, emit);
      emit('error', { severity: 'fatal', code: 0x1fff, message: 'playa failure' });

      expect(media.error).toMatchObject({
        code: MediaError.MEDIA_ERR_CUSTOM,
        fatal: true,
        message: 'playa failure',
        data: { playaErrorCode: 0x1fff, message: 'playa failure' },
      });
    });

    it('ignores a recoverable error', async () => {
      const emit = stubPlaya();
      const media = setup();
      const onError = vi.fn();

      media.addEventListener('error', onError);
      await loadMetadata(media, emit);
      emit('error', { severity: 'recoverable', code: PlayerErrorCode.SUBSCRIPTION_REFUSED, message: 'track refused' });

      expect(media.error).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    });

    it('keeps the first fatal error', async () => {
      const emit = stubPlaya();
      const media = setup();
      const onError = vi.fn();

      media.addEventListener('error', onError);
      await loadMetadata(media, emit);
      emit('error', { severity: 'fatal', code: PlayerErrorCode.CONNECTION_LOST, message: 'connection lost' });
      emit('error', { severity: 'fatal', code: PlayerErrorCode.VIDEO_DECODE_ERROR, message: 'decode failed' });

      expect(onError).toHaveBeenCalledOnce();
      expect(media.error?.code).toBe(MediaError.MEDIA_ERR_NETWORK);
    });

    it('keeps a refused catalog reported before playa rejects the load', async () => {
      const emit = stubPlaya();
      const media = setup();
      const onError = vi.fn();

      vi.spyOn(Player.prototype, 'load').mockImplementation(async () => {
        emit('error', { severity: 'fatal', code: PlayerErrorCode.SUBSCRIPTION_REFUSED, message: 'catalog refused' });
        throw new Error('catalog refused');
      });
      media.addEventListener('error', onError);
      media.source = SOURCE;
      await flush();

      expect(onError).toHaveBeenCalledOnce();
      expect(media.error?.code).toBe(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED);
    });

    it('keeps a rejected load reported before playa reports a refused catalog', async () => {
      const emit = stubPlaya();
      const media = setup();
      const onError = vi.fn();

      vi.spyOn(Player.prototype, 'load').mockRejectedValue(new Error('catalog refused'));
      media.addEventListener('error', onError);
      media.source = SOURCE;
      await flush();
      emit('error', { severity: 'fatal', code: PlayerErrorCode.SUBSCRIPTION_REFUSED, message: 'catalog refused' });

      expect(onError).toHaveBeenCalledOnce();
      expect(media.error?.code).toBe(MediaError.MEDIA_ERR_NETWORK);
    });

    it('fails an unsupported browser before building a Player', async () => {
      const media = setup();
      const loadstart = vi.fn();
      const onError = vi.fn();

      const support = { ...Player.checkSupport(), supported: false, reason: 'No decoder available' };

      vi.spyOn(Player, 'checkSupport').mockReturnValue(support);
      media.addEventListener('loadstart', loadstart);
      media.addEventListener('error', onError);
      media.source = SOURCE;
      await flush();

      expect(onError).toHaveBeenCalledOnce();
      expect(media.error).toMatchObject({
        code: MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED,
        fatal: true,
        message: MediaError.defaultMessages[MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED],
        data: { support },
      });
      expect(loadstart).not.toHaveBeenCalled();
      expect(media.engine).toBeNull();
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
