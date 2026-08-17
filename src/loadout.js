import { HULLS, WEAPONS, BANDS } from './config.js';

/**
 * The pre-match screen: callsign, hull, weapon.
 *
 * The server has always accepted all three in `C_HELLO`, validated them, put
 * them in the roster and broadcast them in `S_JOIN` — every other client builds
 * your tank from exactly that. The client simply never asked, and sent a
 * hardcoded `{ name: 'You', hull: 'hunter', weapon: 'twin' }`, so two people on
 * the same server were two identical Hunters both called "You". Nothing on the
 * wire needed to change for this.
 *
 * Cards are generated from config.js rather than written into the HTML. Balance
 * numbers here move whenever the optimiser runs, and a hand-written card is a
 * second copy of them that silently goes stale.
 */

const KEY = 'tanki.loadout';

// What the hull is FOR, in one word. The stat rows below give the numbers; this
// is so a first-time player does not have to derive the idea from them.
const HULL_ROLE = {
  wasp: 'EVASIVE',
  hunter: 'BALANCED',
  mammoth: 'BRAWLER',
  wraith: 'HOVER · STRAFES',
};

const WEAPON_ROLE = {
  twin: 'SHREDDER',
  thunder: 'SIEGE',
  rail: 'SNIPER',
};

const DEFAULTS = { name: '', hull: 'hunter', weapon: 'twin' };

function stored() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      name: typeof raw.name === 'string' ? raw.name.slice(0, 16) : DEFAULTS.name,
      hull: HULLS[raw.hull] ? raw.hull : DEFAULTS.hull,
      weapon: WEAPONS[raw.weapon] ? raw.weapon : DEFAULTS.weapon,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function remember(lo) {
  try { localStorage.setItem(KEY, JSON.stringify(lo)); } catch { /* private mode */ }
}

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

function card({ key, title, role, swatch, stats }) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'lo-card';
  el.dataset.key = key;

  const rows = stats
    .map(([label, value]) => `<div class="lo-stat"><span>${label}</span><b>${value}</b></div>`)
    .join('');

  el.innerHTML =
    `<div class="lo-name">` +
      (swatch ? `<span class="lo-swatch" style="background:${swatch}"></span>` : '') +
      `${title}</div>` +
    `<div class="lo-role">${role}</div>` +
    `<div class="lo-stats">${rows}</div>`;
  return el;
}

function hullCards() {
  return Object.entries(HULLS).map(([key, h]) => card({
    key,
    title: h.name,
    role: HULL_ROLE[key] ?? '',
    swatch: hex(h.color),
    stats: [
      ['Hull', `${h.hp} HP`],
      ['Top speed', `${h.maxSpeed.toFixed(1)} m/s`],
      ['Turning', `${h.turnRate.toFixed(2)} rad/s`],
      // Hulls differ on mobility, not toughness — the HP spread is 1.05x, so
      // showing HP alone would make them look identical. The last row is where
      // each hull's actual argument lives, so a hover hull spends it saying the
      // thing that makes it different rather than repeating a turret modifier.
      h.hover
        ? ['Strafe', `${Math.round(h.strafeFactor * 100)}% sideways`]
        : ['Turret', `${h.turretMod.toFixed(2)}x`],
    ],
  }));
}

function weaponCards() {
  return Object.entries(WEAPONS).map(([key, w]) => {
    const [from, to] = BANDS[w.band];
    return card({
      key,
      title: w.name,
      role: WEAPON_ROLE[key] ?? '',
      swatch: hex(w.color),
      stats: [
        ['Damage', `${Math.round(w.damage)}${w.splash ? ' + splash' : ''}`],
        // Charge time counts. Rail's fireInterval is a 0.2s post-shot lockout,
        // so quoting 1/fireInterval advertises a 5/s sniper rifle when the real
        // cadence, with the 2.1s wind-up, is closer to one shot every 2.3s.
        ['Rate', `${(1 / (w.fireInterval + (w.chargeTime ?? 0))).toFixed(2)}/s`],
        ['Best at', `${from}-${to} m`],
        [w.chargeTime ? 'Charge' : 'Spread',
          w.chargeTime ? `${w.chargeTime.toFixed(1)} s` : `${(w.spread * 1000).toFixed(0)} mrad`],
      ],
    });
  });
}

function fillRow(row, cards, selected, onPick) {
  for (const c of cards) {
    c.classList.toggle('active', c.dataset.key === selected);
    c.addEventListener('click', () => {
      for (const other of row.children) other.classList.remove('active');
      c.classList.add('active');
      onPick(c.dataset.key);
    });
    row.appendChild(c);
  }
}

/**
 * Show the screen and resolve with the chosen loadout.
 *
 * `join` runs before the promise resolves and may reject — a failed connection
 * has to leave the player on this screen with the reason, not drop them into an
 * empty arena. That is the only reason this takes a callback rather than simply
 * resolving and letting the caller connect.
 */
export function chooseLoadout({ join }) {
  const root = document.getElementById('loadout');
  const nameEl = document.getElementById('lo-name');
  const joinEl = document.getElementById('lo-join');
  const footEl = document.getElementById('lo-foot');
  const hullRow = document.getElementById('lo-hulls');
  const weaponRow = document.getElementById('lo-weapons');

  const lo = stored();
  nameEl.value = lo.name;

  fillRow(hullRow, hullCards(), lo.hull, (k) => { lo.hull = k; });
  fillRow(weaponRow, weaponCards(), lo.weapon, (k) => { lo.weapon = k; });

  document.getElementById('loading')?.remove();
  root.hidden = false;
  // Only steal focus when there is nothing to keep — someone who has played
  // before has a name saved and wants the JOIN button, not the text field.
  (lo.name ? joinEl : nameEl).focus();

  return new Promise((resolve) => {
    const submit = async () => {
      lo.name = (nameEl.value.trim() || 'Tanker').slice(0, 16);
      remember(lo);

      joinEl.disabled = true;
      footEl.textContent = 'connecting…';
      try {
        // `join` gets a way to talk back, because on a host that sleeps when
        // idle the wait can be a minute and silence reads as a broken link.
        await join(lo, (msg) => { footEl.textContent = msg; });
        root.hidden = true;
        resolve(lo);
      } catch (err) {
        // Stay on the screen. Dropping into the arena on a failed connect is
        // how you get a player driving around wondering why nobody is there.
        joinEl.disabled = false;
        footEl.textContent = err?.message ? `could not join — ${err.message}` : 'could not join';
      }
    };

    joinEl.addEventListener('click', submit);
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  });
}
