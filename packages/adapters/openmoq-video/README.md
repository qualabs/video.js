# @videojs/openmoq-video

[OpenMoQ Playa](https://github.com/openmoq/moq-playa) (Media over QUIC) playback adapter for Video.js. It exposes the
adapter, its props, and defaults; the HTML façade lives in `@videojs/html`.

```bash
pnpm add @videojs/html @videojs/openmoq-video
```

## Usage

```ts
import '@videojs/html/media/openmoq-video';

document.querySelector('openmoq-video')!.source = {
  url: 'https://relay.example.com/moq',
  namespace: 'live/stream',
};
```

## License

[Apache-2.0](../../../LICENSE)
