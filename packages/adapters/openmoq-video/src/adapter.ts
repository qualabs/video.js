import { type Level, Player, type PlayerOptions, type PlayerState } from '@openmoq/playa';
import {
  MediaError,
  MediaReadyState,
  type MediaReadyStateValue,
  type MediaStreamType,
  MediaStreamTypes,
  type Video,
} from '@videojs/media';
import { noop } from '@videojs/utils/function';
import { isUndefined } from '@videojs/utils/predicate';

/**
 * Connection fields for one broadcast, passed to the playa `Player` as-is.
 *
 * @internal
 */
export type OpenMoqSource = Pick<PlayerOptions, 'url' | 'namespace' | 'catalogTrackName' | 'certHash' | 'draftVersion'>;

/** @internal */
export interface OpenMoqAdapterProps {
  src: string;
  source: OpenMoqSource | null;
}

/** @internal */
export class OpenMoqAdapter extends EventTarget implements Partial<Video> {
  static readonly defaultProps: OpenMoqAdapterProps = {
    src: '',
    source: null,
  };

  /** Engine this media plays through, reported to analytics such as Mux Data. */
  static readonly engineName: string = 'openmoq-playa';

  #video: HTMLVideoElement | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #player: Player | null = null;
  #unsubscribes: (() => void)[] = [];
  #source: OpenMoqSource | null = OpenMoqAdapter.defaultProps.source;
  #readyState: MediaReadyStateValue = MediaReadyState.HAVE_NOTHING;
  #playerState: PlayerState | null = null;
  #error: MediaError | null = null;
  #volume = 1;
  #muted = false;
  // Last `play()`/`pause()` call, so a `pause()` while `load()` is in flight wins over an earlier `play()`.
  #wantsPlay = false;
  // Guards async player creation across source changes and attach/detach cycles.
  #generation = 0;
  #loading: Promise<void> = Promise.resolve();
  #teardown: Promise<void> = Promise.resolve();

  /** The playa `Player` for the current source (null until one is created). */
  get engine(): Player | null {
    return this.#player;
  }

  get target(): HTMLVideoElement | null {
    return this.#video;
  }

  /** Bind the `<video>` and the `<canvas>` the host renders beside it; playa draws into whichever the catalog needs. */
  attach(target: HTMLVideoElement | null): void {
    if (!target) {
      this.detach();
      return;
    }

    if (this.#video === target) return;

    if (this.#video) this.detach();

    this.#video = target;
    this.#canvas = target.parentNode?.querySelector('canvas') ?? null;
    this.#reload();
  }

  detach(): void {
    if (!this.#video) return;

    this.#generation++;
    this.#release();
    this.#video = null;
    this.#canvas = null;
  }

  destroy(): void {
    this.detach();
  }

  get src(): string {
    return this.#source?.url ?? '';
  }
  /** Relay URL. Setting it keeps the rest of `source`. */
  set src(value: string) {
    this.source = value ? { namespace: '', ...this.#source, url: value } : null;
  }

  get currentSrc(): string {
    return this.#player ? this.src : '';
  }

  get source(): OpenMoqSource | null {
    return this.#source;
  }
  set source(value: OpenMoqSource | null) {
    if (value === this.#source) return;

    this.#source = value;
    this.#reload();
    this.dispatchEvent(new Event('sourcechange'));
  }

  get readyState(): MediaReadyStateValue {
    return this.#readyState;
  }

  load(): void {
    this.#reload();
  }

  get paused(): boolean {
    return this.#player?.state !== 'playing';
  }

  get ended(): boolean {
    return this.#playerState === 'ended';
  }

  get seeking(): boolean {
    return false;
  }

  get streamType(): MediaStreamType {
    return this.#readyState >= MediaReadyState.HAVE_METADATA ? MediaStreamTypes.LIVE : MediaStreamTypes.UNKNOWN;
  }

  get error(): MediaError | null {
    return this.#error;
  }

  async play(): Promise<void> {
    this.#wantsPlay = true;

    await this.#loading;

    const player = this.#player;
    if (!this.#wantsPlay || (player?.state !== 'loading' && player?.state !== 'paused')) return;

    player.play();
  }

  pause(): void {
    this.#wantsPlay = false;

    // Playa throws when pausing from any state but `playing`.
    if (this.#player?.state === 'playing') this.#player.pause();
  }

  get volume(): number {
    return this.#volume;
  }
  // Throws as `HTMLMediaElement` does; playa would clamp the level, and its `<video>` throws on a non-finite one.
  set volume(value: number) {
    if (!Number.isFinite(value)) throw new TypeError('The provided volume is non-finite.');

    if (value < 0 || value > 1) {
      throw new DOMException(`The volume provided (${value}) is outside the range [0, 1].`, 'IndexSizeError');
    }

    if (this.#volume === value) return;

    this.#volume = value;

    if (this.#player) {
      this.#player.setVolume(value);
    } else {
      this.dispatchEvent(new Event('volumechange'));
    }
  }

  get muted(): boolean {
    return this.#muted;
  }
  set muted(value: boolean) {
    if (this.#muted === value) return;

    this.#muted = value;

    const player = this.#player;

    if (!player) {
      this.dispatchEvent(new Event('volumechange'));
    } else if (value) {
      player.mute();
    } else {
      // Playa activates LOC audio inside `unmute()`, which must run within the user gesture.
      player.unmute().catch((cause) => this.#onUnmuteFailed(player, cause));
    }
  }

  get currentTime(): number {
    return (this.#player?.currentTime ?? 0) / 1000;
  }
  // Seeking is not supported yet. A settled seek is still announced, so callers awaiting `seeked` resume.
  set currentTime(_value: number) {
    this.dispatchEvent(new Event('seeking'));
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }

  get duration(): number {
    if (this.#readyState < MediaReadyState.HAVE_METADATA) return Number.NaN;

    const duration = this.#player?.duration;

    return isUndefined(duration) ? Number.POSITIVE_INFINITY : duration / 1000;
  }

  #reload(): void {
    const generation = ++this.#generation;

    this.#loading = this.#rebuild(generation).catch((cause) => {
      if (generation !== this.#generation) return;

      if (__DEV__) console.warn('[openmoq-video] Failed to load the source.', cause);

      const message = cause instanceof Error ? cause.message : String(cause);

      this.#fail(new MediaError(message, MediaError.MEDIA_ERR_NETWORK, true));
    });
  }

  async #rebuild(generation: number): Promise<void> {
    const replaced = !!this.#player;

    this.#release();

    if (replaced) this.dispatchEvent(new Event('emptied'));

    // Players borrow the same `<video>`, and a destroyed one still clears its `src` on the way out.
    await this.#teardown;

    const source = this.#source;
    const video = this.#video;
    const canvas = this.#canvas;
    if (generation !== this.#generation || !source?.url || !source.namespace || !video || !canvas) return;

    const player = new Player(null, { ...source, video, canvas, volume: this.#volume, muted: this.#muted });

    this.#player = player;
    this.#unsubscribes = [
      player.on('ready', () => this.#onReady(player, video, canvas)),
      player.on('qualitychange', ({ level }) => sizeCanvas(canvas, level)),
      player.on('play', () => this.#onPlay()),
      player.on('pause', () => this.dispatchEvent(new Event('pause'))),
      player.on('playing', () => this.#onPlaying()),
      player.on('timeupdate', () => this.dispatchEvent(new Event('timeupdate'))),
      player.on('durationchange', () => this.dispatchEvent(new Event('durationchange'))),
      player.on('volumechange', ({ volume, muted }) => this.#onVolumeChange(volume, muted)),
      player.on('statechange', ({ state }) => this.#onStateChange(state)),
      player.on('ended', () => this.dispatchEvent(new Event('ended'))),
      player.on('error', ({ severity, code, message }) => this.#onError(severity, code, message)),
    ];
    this.#playerState = player.state;
    this.dispatchEvent(new Event('loadstart'));

    await player.load();
  }

  #release(): void {
    const player = this.#player;
    const streamTypeKnown = this.streamType !== MediaStreamTypes.UNKNOWN;

    for (const unsubscribe of this.#unsubscribes) unsubscribe();

    this.#unsubscribes = [];
    this.#player = null;
    this.#playerState = null;
    this.#readyState = MediaReadyState.HAVE_NOTHING;
    this.#error = null;

    if (player) this.#teardown = player.destroy().catch(noop);

    if (streamTypeKnown) this.dispatchEvent(new Event('streamtypechange'));
  }

  #fail(error: MediaError): void {
    if (this.#error) return;

    this.#error = error;
    this.dispatchEvent(new Event('error'));
  }

  #onReady(player: Player, video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
    const onCanvas = player.activeMediaType === 'canvas';
    const level = player.levels[player.currentLevel] ?? player.levels[0];

    video.hidden = onCanvas;
    canvas.hidden = !onCanvas;

    if (level) sizeCanvas(canvas, level);

    if (this.#readyState >= MediaReadyState.HAVE_METADATA) return;

    this.#readyState = MediaReadyState.HAVE_METADATA;
    this.dispatchEvent(new Event('loadedmetadata'));
    this.dispatchEvent(new Event('durationchange'));
    this.dispatchEvent(new Event('streamtypechange'));
  }

  // Playa reaches `ended` straight from `playing` without a `pause`, which a media element fires before `ended`.
  #onStateChange(state: PlayerState): void {
    const previous = this.#playerState;

    this.#playerState = state;

    if (state === 'ended' && previous === 'playing') this.dispatchEvent(new Event('pause'));
  }

  // Only a fatal error stops playback; playa keeps going after a recoverable one.
  #onError(severity: 'fatal' | 'recoverable', code: number, message: string): void {
    if (severity !== 'fatal') return;

    const error = new MediaError(message, MediaError.MEDIA_ERR_CUSTOM, true);

    error.data = { playaErrorCode: code };
    this.#fail(error);
  }

  // Playa settles `unmute()` asynchronously, so its report is the state that holds.
  #onVolumeChange(volume: number, muted: boolean): void {
    this.#volume = volume;
    this.#muted = muted;
    this.dispatchEvent(new Event('volumechange'));
  }

  #onUnmuteFailed(player: Player, cause: unknown): void {
    if (player !== this.#player) return;

    if (__DEV__) console.warn('[openmoq-video] Failed to start audio on unmute.', cause);

    this.#muted = player.muted;
    this.dispatchEvent(new Event('volumechange'));
  }

  #onPlay(): void {
    this.dispatchEvent(new Event('play'));

    if (this.#readyState >= MediaReadyState.HAVE_FUTURE_DATA) this.dispatchEvent(new Event('playing'));
  }

  // Playa reports its first rendered frame, which the MSE path presents before `play()`. Starting after it is announced
  // by `#onPlay`.
  #onPlaying(): void {
    if (this.#readyState === MediaReadyState.HAVE_ENOUGH_DATA) return;

    this.#readyState = MediaReadyState.HAVE_ENOUGH_DATA;

    for (const type of ['loadeddata', 'canplay', 'canplaythrough']) {
      this.dispatchEvent(new Event(type));
    }

    if (!this.paused) this.dispatchEvent(new Event('playing'));
  }
}

// Playa draws each frame scaled to the canvas bitmap and never resizes it. Assigning a dimension clears the bitmap,
// even when the value is unchanged.
function sizeCanvas(canvas: HTMLCanvasElement, { width, height }: Level): void {
  if (canvas.width === width && canvas.height === height) return;

  canvas.width = width;
  canvas.height = height;
}
