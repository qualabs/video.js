import { Player } from '@openmoq/playa';
import { MediaError } from '@videojs/media';
import { describe, expect, it, vi } from 'vite-plus/test';

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
});
