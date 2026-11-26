const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyC', 'KeyF', 'KeyR', 'KeyE', 'KeyQ',
  'ShiftLeft', 'ShiftRight', 'KeyM', 'Tab', 'AltLeft', 'Digit1', 'Digit2', 'KeyV', 'KeyH',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** Keyboard + mouse. Mouse look uses pointer lock, or click-and-drag when pointer lock is unavailable. */
export class Input {
  constructor(lockTarget) {
    this.lockTarget = lockTarget;
    this.keys = new Set();
    this.pressed = new Set();
    this.buttons = new Set();
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    this.enabled = false;
    this.typed = '';
    this.dragLook = false;

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (GAME_KEYS.has(e.code) || e.ctrlKey) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.key.length === 1) this.typed = (this.typed + e.key.toUpperCase()).slice(-16);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.buttons.clear(); });
    addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement === this.lockTarget || (this.dragLook && this.buttons.size)) {
        this.mouseDX += e.movementX; this.mouseDY += e.movementY;
      }
    });
    lockTarget.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.buttons.add(e.button); this.pressed.add(`Mouse${e.button}`);
    });
    addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    lockTarget.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { if (this.enabled) this.wheel += Math.sign(e.deltaY); }, { passive: true });
  }
  down(...codes) { return codes.some((c) => this.keys.has(c)); }
  hit(...codes) { return codes.some((c) => this.pressed.has(c)); }
  mouse(b) { return this.buttons.has(b); }
  endFrame() { this.pressed.clear(); this.mouseDX = this.mouseDY = this.wheel = 0; }
  reset() { this.keys.clear(); this.buttons.clear(); this.endFrame(); }
}
