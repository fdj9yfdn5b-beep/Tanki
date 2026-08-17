/**
 * Touch controls: two floating sticks, a fire button, and auto-fire.
 *
 * Shape follows the tank games people already know on a phone — drive with the
 * left thumb, aim with the right, and let the gun fire itself once a target
 * crosses the barrel. Auto-fire is not a convenience here, it is what makes the
 * game playable at all: this tank aims by *rate* (the turret traverses at a
 * speed, it does not snap to a cursor), so lining a shot up and pressing a
 * button at the right instant needs a precision a thumb on glass does not have.
 *
 * The sticks FLOAT — the base appears wherever the thumb lands inside its half
 * rather than sitting at a fixed spot. A fixed stick has to be found by feel
 * first, and on a screen with nothing to feel that means looking down at the
 * controls instead of at the fight.
 *
 * Everything is exposed as plain numbers in `state`, in exactly the units
 * main.js already builds its keyboard input from, so the two paths merge instead
 * of forking. Nothing in here knows about the game.
 */

const DEADZONE = 0.14;   // fraction of travel ignored, against thumb tremor
const TRAVEL = 62;       // px from base to full deflection

export function isTouchDevice() {
  const forced = new URLSearchParams(location.search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  // `maxTouchPoints` alone is true for touchscreen laptops, where the keyboard
  // is still the better input. Requiring a coarse primary pointer as well keeps
  // this to devices where touch is genuinely the only way in.
  return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
}

class Stick {
  constructor(zone) {
    this.zone = zone;
    this.base = zone.querySelector('.tc-base');
    this.knob = zone.querySelector('.tc-knob');
    this.id = null;      // the pointerId that owns this stick
    this.x = 0;
    this.y = 0;

    zone.addEventListener('pointerdown', (e) => {
      if (this.id !== null) return;
      this.id = e.pointerId;
      // Capture keeps the stick following a thumb that slides outside its half —
      // which happens constantly, since the zones meet in the middle of the
      // screen. Not fatal if the browser refuses it, so never let it throw.
      try { zone.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.style.opacity = '1';
      this._move(e);
      e.preventDefault();
    });

    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.id) return;
      this._move(e);
      e.preventDefault();
    });

    // Every way a touch can end. A stick left stuck on means a tank driving into
    // a wall forever with the player's thumb already off the glass.
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
      zone.addEventListener(ev, (e) => {
        if (e.pointerId !== this.id) return;
        this.id = null;
        this.x = 0;
        this.y = 0;
        this.base.style.opacity = '0';
        this.knob.style.transform = 'translate(-50%, -50%)';
      });
    }
  }

  _move(e) {
    let dx = (e.clientX - this.originX) / TRAVEL;
    let dy = (e.clientY - this.originY) / TRAVEL;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }

    // Rescale past the deadzone rather than clipping, so the first responsive
    // movement is gentle instead of jumping straight to 14%.
    const mag = Math.hypot(dx, dy);
    if (mag < DEADZONE) {
      this.x = 0; this.y = 0;
    } else {
      const scaled = (mag - DEADZONE) / (1 - DEADZONE) / mag;
      this.x = dx * scaled;
      this.y = dy * scaled;
    }
    this.knob.style.transform =
      `translate(calc(-50% + ${dx * TRAVEL}px), calc(-50% + ${dy * TRAVEL}px))`;
  }
}

export function createTouchControls() {
  const root = document.getElementById('touch');
  root.hidden = false;
  document.body.classList.add('touch');

  const move = new Stick(document.getElementById('tc-move'));
  const aim = new Stick(document.getElementById('tc-aim'));

  const fireBtn = document.getElementById('tc-fire');
  const autoBtn = document.getElementById('tc-auto');

  const state = {
    // The drive stick is published as a raw vector, not as throttle/steer.
    // Which way the tank should point for a given thumb position depends on
    // where the camera is looking and which way the hull already faces, and
    // none of that belongs in here — main.js turns this into a heading. See the
    // driving-model note there.
    moveX: 0, moveY: 0, moveMag: 0,
    turretSteer: 0, pitch: 0,
    fire: false,          // the button
    autoFire: true,       // whether the game may fire on its own
    onTarget: false,      // written back by the game, purely to light the button
  };

  let held = false;
  fireBtn.addEventListener('pointerdown', (e) => {
    held = true; fireBtn.classList.add('held'); e.preventDefault();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    fireBtn.addEventListener(ev, () => { held = false; fireBtn.classList.remove('held'); });
  }
  // A touch that ends anywhere else still ends the press.
  addEventListener('pointerup', () => { held = false; fireBtn.classList.remove('held'); });
  addEventListener('blur', () => { held = false; fireBtn.classList.remove('held'); });

  autoBtn.addEventListener('click', () => {
    state.autoFire = !state.autoFire;
    autoBtn.classList.toggle('on', state.autoFire);
  });
  autoBtn.classList.toggle('on', state.autoFire);

  return {
    state,
    /** Sample the sticks. Called once per simulation step by main.js. */
    read() {
      state.moveX = move.x;
      state.moveY = move.y;
      state.moveMag = Math.min(1, Math.hypot(move.x, move.y));
      // Right stick: horizontal traverses the turret, vertical pitches the
      // camera. Sign matches Z/X and Q/E — pushing right swings the gun right.
      state.turretSteer = -aim.x;
      state.pitch = -aim.y;
      state.fire = held;
      return state;
    },
    /** The game tells us whether the barrel is on someone, to light the button. */
    setOnTarget(on) {
      if (state.onTarget === on) return;
      state.onTarget = on;
      fireBtn.classList.toggle('on-target', on);
    },
  };
}
