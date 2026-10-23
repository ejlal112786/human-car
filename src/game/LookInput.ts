/**
 * Camera look input: drags on the 3D canvas (mouse or one finger) and the mouse wheel.
 * Only one pointer drives the camera at a time (tracked by pointerId), so a second finger
 * on the joystick or pedals never moves the camera, and lifting/cancelling that finger
 * always ends the drag.
 */
export class LookInput {
  /** Accumulated, sensitivity-scaled deltas since the last {@link consume}. */
  private dx = 0;
  private dy = 0;
  private zoomSteps = 0;
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private lastType = 'mouse';
  /** Seconds since the last drag movement (cameras use it to decide when to re-centre). */
  idleTime = 99;
  enabled = true;
  /** The left mouse button is the trigger (weapon out): it does not start a camera drag. */
  primaryFires = false;
  /** Two-finger pinch zooms (garage orbit only: while driving, a second finger never moves the camera). */
  pinchZoom = false;
  private pinchId: number | null = null;
  private pinchX = 0;
  private pinchY = 0;
  private pinchDist = 0;
  cameraSensitivity = 1;
  mouseSensitivity = 1;
  touchSensitivity = 1;
  private readonly abort = new AbortController();

  constructor(
    private readonly dom: HTMLElement,
    private readonly onTouch: () => void,
  ) {
    const opts = { signal: this.abort.signal };
    dom.addEventListener('pointerdown', this.onDown, opts);
    dom.addEventListener('pointermove', this.onMove, opts);
    dom.addEventListener('pointerup', this.onUp, opts);
    dom.addEventListener('pointercancel', this.onUp, opts);
    dom.addEventListener('lostpointercapture', this.onUp, opts);
    dom.addEventListener('wheel', this.onWheel, { ...opts, passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
  }

  get dragging(): boolean {
    return this.pointerId !== null || this.stickHeld;
  }

  /** Controller right stick held this frame (counts as a drag, so cameras re-centre only after it is let go). */
  private stickHeld = false;

  /** Right-stick look for this frame, in drag pixels (the camera sensitivity applies as for any drag). */
  addStick(dx: number, dy: number): void {
    this.stickHeld = this.enabled && (dx !== 0 || dy !== 0);
    if (!this.stickHeld) return;
    this.dx += dx * this.cameraSensitivity;
    this.dy += dy * this.cameraSensitivity;
    this.idleTime = 0;
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') this.onTouch();
    if (this.enabled && this.pinchZoom && e.pointerType === 'touch' && this.pointerId !== null && this.lastType === 'touch' && this.pinchId === null) {
      // Second finger: pinch. The first finger stops orbiting while both are down.
      this.pinchId = e.pointerId;
      this.pinchX = e.clientX;
      this.pinchY = e.clientY;
      this.pinchDist = Math.hypot(this.pinchX - this.lastX, this.pinchY - this.lastY);
      try {
        this.dom.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointers cannot be captured */
      }
      return;
    }
    if (!this.enabled || this.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    // Weapon out: the left button fires instead of dragging the camera (the right button aims and looks).
    if (e.pointerType === 'mouse' && e.button === 0 && this.primaryFires) return;
    this.pointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastType = e.pointerType;
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers cannot be captured */
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (this.pinchId !== null && (e.pointerId === this.pinchId || e.pointerId === this.pointerId)) {
      if (e.pointerId === this.pinchId) {
        this.pinchX = e.clientX;
        this.pinchY = e.clientY;
      } else {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
      const d = Math.hypot(this.pinchX - this.lastX, this.pinchY - this.lastY);
      if (this.pinchDist > 10 && d > 10) this.zoomSteps += Math.log(this.pinchDist / d) / Math.log(1.08);
      this.pinchDist = d;
      this.idleTime = 0;
      return;
    }
    // Mouse chords (one pointerdown/up per pointer): with the weapon out, the right button pressed
    // while the trigger is held starts looking; releasing it while still firing stops looking.
    if (e.pointerType === 'mouse' && this.primaryFires) {
      if (this.pointerId === null && this.enabled && e.buttons & 2) {
        this.pointerId = e.pointerId;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.lastType = 'mouse';
        return;
      }
      if (e.pointerId === this.pointerId && !(e.buttons & 2)) {
        this.pointerId = null;
        return;
      }
    }
    if (e.pointerId !== this.pointerId) return;
    const k = this.cameraSensitivity * (this.lastType === 'touch' ? this.touchSensitivity * 1.6 : this.mouseSensitivity);
    this.dx += (e.clientX - this.lastX) * k;
    this.dy += (e.clientY - this.lastY) * k;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.idleTime = 0;
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.pinchId) {
      this.pinchId = null;
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.pinchId !== null) {
      // The second finger carries on as the orbit finger.
      this.pointerId = this.pinchId;
      this.lastX = this.pinchX;
      this.lastY = this.pinchY;
      this.pinchId = null;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.enabled) this.zoomSteps += e.deltaY > 0 ? 1 : -1;
  };

  /** Read and reset accumulated deltas (pixels, sensitivity applied) and wheel steps. */
  consume(out: { dx: number; dy: number; zoom: number }): void {
    out.dx = this.dx;
    out.dy = this.dy;
    out.zoom = this.zoomSteps;
    this.dx = 0;
    this.dy = 0;
    this.zoomSteps = 0;
  }

  tick(dt: number): void {
    if (!this.dragging) this.idleTime += dt;
  }

  /** Drop the active drag and any pending movement (pause, mode change). */
  clear(): void {
    if (this.pointerId !== null) {
      try {
        this.dom.releasePointerCapture(this.pointerId);
      } catch {
        /* already released */
      }
    }
    if (this.pinchId !== null) {
      try {
        this.dom.releasePointerCapture(this.pinchId);
      } catch {
        /* already released */
      }
    }
    this.pointerId = null;
    this.pinchId = null;
    this.stickHeld = false;
    this.dx = 0;
    this.dy = 0;
    this.zoomSteps = 0;
  }

  dispose(): void {
    this.abort.abort();
  }
}
