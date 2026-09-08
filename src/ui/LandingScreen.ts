import { requireElement } from '../utils/dom';

export interface LandingScreenCallbacks {
  onEnterCamera: () => void;
}

export class LandingScreen {
  private readonly root = requireElement<HTMLElement>('landing-screen');
  private readonly infoPanel = requireElement<HTMLElement>('how-it-works-panel');

  constructor(callbacks: LandingScreenCallbacks) {
    const enterBtn = requireElement<HTMLButtonElement>('enter-camera-btn');
    const howItWorksBtn = requireElement<HTMLButtonElement>('how-it-works-btn');
    const closeBtn = requireElement<HTMLButtonElement>('close-how-it-works-btn');

    enterBtn.addEventListener('click', () => callbacks.onEnterCamera());
    howItWorksBtn.addEventListener('click', () => this.infoPanel.classList.remove('hidden'));
    closeBtn.addEventListener('click', () => this.infoPanel.classList.add('hidden'));
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.infoPanel.classList.add('hidden');
  }
}
