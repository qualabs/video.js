import { Player } from '@openmoq/playa';
import { isMediaVolumeCapable, MediaError } from '@videojs/media';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { OpenMoqAdapter, type OpenMoqSource } from '../index';

const SOURCE: OpenMoqSource = { url: 'https://relay.example.com/moq', namespace: 'live' };
const OTHER_URL = 'https://relay.example.com/other';

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

/** Without WebTransport in jsdom, a load fails, or is cut short by destroy, within a task. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * The Web Audio surface playa touches, which jsdom lacks. jsdom also lacks WebCodecs and MSE, so playa takes the LOC
 * path.
 */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'suspended';
  destination = {};
  resume = vi.fn(async () => {
    this.state = 'running';
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return { gain: { value: 1 }, connect: vi.fn() };
  }

  async close() {
    this.state = 'closed';
  }
}

/** An `AudioContext` the browser refuses to start, as without a user gesture. */
class RejectingAudioContext extends FakeAudioContext {
  override resume = vi.fn(async () => {
    throw new DOMException('Not allowed', 'NotAllowedError');
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

  describe('pause', () => {
    it('leaves a Player that is still loading alone', async () => {
      const media = setup();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');

      expect(() => media.pause()).not.toThrow();
      expect(media.engine?.state).toBe('loading');
    });
  });

  describe('volume', () => {
    beforeEach(() => {
      FakeAudioContext.instances = [];
      vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('is volume capable before a Player exists', () => {
      const media = new OpenMoqAdapter();

      expect(isMediaVolumeCapable(media)).toBe(true);
      expect(media).toMatchObject({ volume: 1, muted: false });
    });

    it('sets the Player level and relays its volumechange once', async () => {
      const media = setup();
      const onVolumeChange = vi.fn();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');
      media.addEventListener('volumechange', onVolumeChange);
      media.volume = 0.5;
      media.volume = 0.5;

      expect(media.engine?.volume).toBe(0.5);
      expect(media.volume).toBe(0.5);
      expect(onVolumeChange).toHaveBeenCalledOnce();
    });

    it('throws like a media element for a level outside [0, 1] and keeps the current one', async () => {
      const media = setup();
      const onVolumeChange = vi.fn();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');
      media.addEventListener('volumechange', onVolumeChange);

      expect(() => {
        media.volume = 1.5;
      }).toThrow(expect.objectContaining({ name: 'IndexSizeError' }));
      expect(() => {
        media.volume = -0.1;
      }).toThrow(expect.objectContaining({ name: 'IndexSizeError' }));
      expect(() => {
        media.volume = Number.NaN;
      }).toThrow(TypeError);
      expect(() => {
        media.volume = Number.POSITIVE_INFINITY;
      }).toThrow(TypeError);
      expect(media.volume).toBe(1);
      expect(media.engine?.volume).toBe(1);
      expect(onVolumeChange).not.toHaveBeenCalled();
    });

    it('announces a level and mute set while no Player exists', () => {
      const media = setup();
      const onVolumeChange = vi.fn();

      media.addEventListener('volumechange', onVolumeChange);
      media.volume = 0.5;
      media.volume = 0.5;
      media.muted = true;
      media.muted = true;

      expect(onVolumeChange).toHaveBeenCalledTimes(2);
    });

    it('passes a level set before the source to the Player', async () => {
      const media = setup();

      media.volume = 0.3;
      media.muted = true;
      media.source = SOURCE;
      await nextEvent(media, 'loadstart');

      expect(media.engine).toMatchObject({ volume: 0.3, muted: true });
    });

    it('keeps the level and mute across a source change', async () => {
      const media = setup();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');
      media.volume = 0.4;
      media.muted = true;
      media.src = OTHER_URL;
      await nextEvent(media, 'loadstart');

      expect(media.engine).toMatchObject({ volume: 0.4, muted: true });
    });
  });

  describe('muted', () => {
    beforeEach(() => {
      FakeAudioContext.instances = [];
      vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('mutes the Player and relays its volumechange', async () => {
      const media = setup();
      const onVolumeChange = vi.fn();

      media.source = SOURCE;
      await nextEvent(media, 'loadstart');
      media.addEventListener('volumechange', onVolumeChange);
      media.muted = true;
      media.muted = true;

      expect(media.engine?.muted).toBe(true);
      expect(onVolumeChange).toHaveBeenCalledOnce();
    });

    it('resumes LOC audio within the unmuting call, then reports the unmute', async () => {
      const media = setup();
      const onVolumeChange = vi.fn();

      media.muted = true;
      media.source = SOURCE;
      await nextEvent(media, 'loadstart');
      media.addEventListener('volumechange', onVolumeChange);
      media.muted = false;

      expect(FakeAudioContext.instances.at(-1)?.resume).toHaveBeenCalledOnce();
      expect(media.muted).toBe(false);

      await nextEvent(media, 'volumechange');

      expect(media.engine?.muted).toBe(false);
      expect(onVolumeChange).toHaveBeenCalledOnce();
    });

    it('reports the mute back when audio fails to start on unmute', async () => {
      const media = setup();
      const onVolumeChange = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.stubGlobal('AudioContext', RejectingAudioContext);
      media.muted = true;
      media.source = SOURCE;
      await nextEvent(media, 'loadstart');
      media.addEventListener('volumechange', onVolumeChange);
      media.muted = false;
      await flush();

      expect(media.engine?.muted).toBe(true);
      expect(media.muted).toBe(true);
      expect(onVolumeChange).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('[openmoq-video] Failed to start audio on unmute.', expect.any(DOMException));

      warn.mockRestore();
    });

    it('ignores a failed unmute of a Player replaced since', async () => {
      const media = setup();
      const onVolumeChange = vi.fn();

      vi.stubGlobal('AudioContext', RejectingAudioContext);
      media.muted = true;
      media.source = SOURCE;
      await nextEvent(media, 'loadstart');
      media.addEventListener('volumechange', onVolumeChange);
      media.muted = false;
      media.src = OTHER_URL;
      await nextEvent(media, 'loadstart');

      expect(media.muted).toBe(false);
      expect(media.engine?.muted).toBe(false);
      expect(onVolumeChange).not.toHaveBeenCalled();
    });
  });
});
