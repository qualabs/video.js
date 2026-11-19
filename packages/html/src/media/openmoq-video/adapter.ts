import { CustomMediaElement, VideoCSSVars } from '@videojs/media/dom';
import { OpenMoqAdapter } from '@videojs/openmoq-video';
import { serializeAttributes } from '@videojs/utils/dom';

import { MediaAttachMixin } from '../../store/media-attach-mixin';

class OpenMoqCustomMediaElement extends CustomMediaElement('video', OpenMoqAdapter) {
  // Playa renders CMAF through the `<video>` and LOC onto the `<canvas>`; the adapter shows the one the catalog picks.
  static override getTemplateHTML = (attrs: Record<string, string>): string => /*html*/ `
    <style>
      :host {
        display: contents;
      }

      video,
      canvas {
        display: block;
        width: 100%;
        height: 100%;
        border-radius: var(${VideoCSSVars.borderRadius});
        object-fit: var(${VideoCSSVars.objectFit}, contain);
        object-position: var(${VideoCSSVars.objectPosition}, center);
      }

      video[hidden],
      canvas[hidden] {
        display: none;
      }
    </style>
    <slot name="media">
      <video${serializeAttributes(attrs)}></video>
      <canvas part="canvas" hidden width="0" height="0"></canvas>
    </slot>
    <slot></slot>
  `;
}

export class OpenMoqVideo extends MediaAttachMixin(OpenMoqCustomMediaElement) {}
