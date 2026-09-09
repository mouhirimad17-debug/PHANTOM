import { requireElement } from '../utils/dom';

export interface LandingScreenCallbacks {
  onEnterCamera: () => void;
}

export class LandingScreen {
  private readonly root = requireElement<HTMLElement>('landing-screen');
  private readonly infoPanel = requireElement<HTMLElement>('how-it-works-panel');
  private readonly closeBtn = requireElement<HTMLButtonElement>('close-how-it-works-btn');
  private readonly enterBtn = requireElement<HTMLButtonElement>('enter-camera-btn');
  private readonly unsupportedNote = requireElement<HTMLElement>('landing-unsupported-note');

  constructor(callbacks: LandingScreenCallbacks) {
    const howItWorksBtn = requireElement<HTMLButtonElement>('how-it-works-btn');

    const closeInfoPanel = (): void => {
      this.infoPanel.classList.add('hidden');
      document.removeEventListener('keydown', handleKeydown);
      howItWorksBtn.focus();
    };
    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeInfoPanel();
    };

    this.enterBtn.addEventListener('click', () => callbacks.onEnterCamera());
    howItWorksBtn.addEventListener('click', () => {
      this.infoPanel.classList.remove('hidden');
      this.closeBtn.focus();
      document.addEventListener('keydown', handleKeydown);
    });
    this.closeBtn.addEventListener('click', closeInfoPanel);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.infoPanel.classList.add('hidden');
  }

  /**
   * Proactively disables ENTER CAMERA and explains why, for a device/browser
   * that's already known (before the user even taps in) to be missing WebGL
   * or camera API support — an inline note instead of letting the user hit
   * a dead end after the fact.
   */
  setUnsupported(message: string): void {
    this.enterBtn.disabled = true;
    this.unsupportedNote.textContent = message;
    this.unsupportedNote.classList.remove('hidden');
  }
}
