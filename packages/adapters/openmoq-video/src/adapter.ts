import { type Level, Player, type PlayerOptions } from '@openmoq/playa';
import { MediaReadyState, type MediaReadyStateValue, type Video } from '@videojs/media';
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
  // Guards async player creation across source changes and attach/detach cycles.
  #generation = 0;
  #loading: Promise<void> = Promise.resolve();
  #teardown: Promise<void> = Promise.resolve();

  /** The playa `Player` for the current source (null until one is created). */
  get engine(): Player | null {
    return this.#player;
  }

  /** Bind the `<video>` and the `<canvas>` the host renders beside it; playa draws into whichever the catalog needs. */
  attach(target: HTMLVideoElement | null): void {
    if (!target || this.#video === target) return;

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
    return false;
  }

  get seeking(): boolean {
    return false;
  }

  async play(): Promise<void> {
    await this.#loading;

    const player = this.#player;
    if (!player || player.state === 'playing') return;

    player.play();
  }

  pause(): void {
    // Playa throws when pausing from any state but `playing`.
    if (this.#player?.state === 'playing') this.#player.pause();
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
    this.#loading = this.#rebuild().catch((error: unknown) => {
      if (__DEV__) console.warn('[openmoq-video] Failed to load the source.', error);
    });
  }

  async #rebuild(): Promise<void> {
    const generation = ++this.#generation;
    const replaced = !!this.#player;

    this.#release();

    if (replaced) this.dispatchEvent(new Event('emptied'));

    // Players borrow the same `<video>`, and a destroyed one still clears its `src` on the way out.
    await this.#teardown;

    const source = this.#source;
    const video = this.#video;
    const canvas = this.#canvas;
    if (generation !== this.#generation || !source?.url || !source.namespace || !video || !canvas) return;

    const player = new Player(null, { ...source, video, canvas });

    this.#player = player;
    this.#unsubscribes = [
      player.on('ready', () => this.#onReady(player, video, canvas)),
      player.on('qualitychange', ({ level }) => sizeCanvas(canvas, level)),
      player.on('play', () => this.#onPlay()),
      player.on('pause', () => this.dispatchEvent(new Event('pause'))),
      player.on('playing', () => this.#onPlaying()),
      player.on('timeupdate', () => this.dispatchEvent(new Event('timeupdate'))),
      player.on('durationchange', () => this.dispatchEvent(new Event('durationchange'))),
    ];
    this.dispatchEvent(new Event('loadstart'));

    await player.load();
  }

  #release(): void {
    const player = this.#player;

    for (const unsubscribe of this.#unsubscribes) unsubscribe();

    this.#unsubscribes = [];
    this.#player = null;
    this.#readyState = MediaReadyState.HAVE_NOTHING;

    if (player) this.#teardown = player.destroy().catch(noop);
  }

  #onReady(player: Player, video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
    const onCanvas = player.activeMediaType === 'canvas';
    const level = player.levels[player.currentLevel] ?? player.levels[0];

    video.hidden = onCanvas;
    canvas.hidden = !onCanvas;

    if (level) sizeCanvas(canvas, level);

    this.#readyState = MediaReadyState.HAVE_METADATA;
    this.dispatchEvent(new Event('loadedmetadata'));
    this.dispatchEvent(new Event('durationchange'));
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
