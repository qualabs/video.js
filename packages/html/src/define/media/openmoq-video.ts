import { OpenMoqVideo } from '../../media/openmoq-video';
import { safeDefine } from '../../registration/safe-define';

export type { OpenMoqAdapter, OpenMoqAdapterProps, OpenMoqSource } from '@videojs/openmoq-video';

/**
 * Media over QUIC media component powered by OpenMoQ Playa and registered as `<openmoq-video>`.
 *
 * @internal
 */
export class OpenMoqVideoElement extends OpenMoqVideo {
  static readonly tagName = 'openmoq-video';
}

safeDefine(OpenMoqVideoElement);

declare global {
  interface HTMLElementTagNameMap {
    [OpenMoqVideoElement.tagName]: OpenMoqVideoElement;
  }
}
