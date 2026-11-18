// <openmoq-video> on a MoQ relay, by default moq-playa's local examples/node-relay.
// http://localhost:5173/openmoq-video/
//
// Query params prefill the form, and `ns` connects at once:
//   url=<relay URL>   Defaults to https://127.0.0.1:4433/moq.
//   ns=<namespace>    Defaults to `demo`, the namespace node-relay serves.
//   v=<draft>         MOQT draft version. Defaults to 18, which node-relay needs.
//   hash=<hex>        SHA-256 of a self-signed relay certificate, as printed by node-relay's `gen-cert`.
import '@app/styles.css';
import '@videojs/html/video/player';
import '@videojs/html/video/skin';
import '@videojs/html/video/skin.css';
import '@videojs/html/media/openmoq-video';
import type { OpenMoqSource } from '@videojs/html/media/openmoq-video';

const DEFAULTS = { url: 'https://127.0.0.1:4433/moq', ns: 'demo', v: '18', hash: '' };

type Field = keyof typeof DEFAULTS;

const form = document.querySelector<HTMLFormElement>('#connect')!;
const status = document.querySelector<HTMLElement>('#status')!;
const media = document.querySelector('openmoq-video')!;
const params = new URLSearchParams(location.search);

function field(name: Field): HTMLInputElement | HTMLSelectElement {
  return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = hex.replace(/[^0-9a-f]/gi, '').match(/../g) ?? [];

  return new Uint8Array(bytes.map((byte) => Number.parseInt(byte, 16))).buffer;
}

function connect(): void {
  const hash = field('hash').value.trim();

  media.source = {
    url: field('url').value.trim(),
    namespace: field('ns').value.trim(),
    draftVersion: Number(field('v').value) as NonNullable<OpenMoqSource['draftVersion']>,
    ...(hash && { certHash: hexToBuffer(hash) }),
  };
}

for (const name of Object.keys(DEFAULTS) as Field[]) {
  field(name).value = params.get(name) ?? DEFAULTS[name];
}

for (const type of ['emptied', 'loadstart', 'loadedmetadata', 'play', 'playing', 'pause']) {
  media.addEventListener(type, () => {
    status.textContent = type;
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  connect();
});
document.querySelector('#disconnect')!.addEventListener('click', () => {
  media.source = null;
  status.textContent = 'Not connected.';
});

if (params.has('ns')) connect();
