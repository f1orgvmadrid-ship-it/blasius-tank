// battle.training controller — blasius-tank v1 (cup promotedby nov-2026, rules s2.0.0)
//
// Base: el starter oficial + tres mejoras reales:
//  1) STICKY OBJECTIVES: cada unidad se asigna UN objetivo y SE QUEDA a
//     sostenerlo (el starter rota a todos hacia el siguiente → suelta los
//     puntos que ya tenía; los puntos son la condición de victoria).
//  2) Puntería con predicción (lead): apunta a la posición futura del
//     objetivo en movimiento (velocidad de proyectil de las propias rules).
//  3) Esquiva de obuses entrantes (o.incoming): si va a caer cerca, se
//     aparta un tick antes de seguir con su plan.
// Draft: 2 MBT + 2 scouts (12/12) — solo armas directas (sin locks ni
// munición finita) para la v1; iterar tras ver ratings.

const FP = 65536;
const FULL = 4096;

let rules, map, side, hill;
const sticky = {}; // id de unidad -> índice de objetivo (estable en o.objectives)

function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function angleTo(ax, ay, bx, by) {
  return Math.round((Math.atan2(by - ay, bx - ax) / (2 * Math.PI)) * FULL) & (FULL - 1);
}
function angDiff(a, b) { let d = (b - a) & (FULL - 1); return d > FULL / 2 ? d - FULL : d; }
function passable(x, y) {
  const tx = Math.floor(x / FP), ty = Math.floor(y / FP);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
  const t = map.terrain[ty * map.width + tx];
  return t !== 2 && t !== 4 && t !== 6; // agua, roca, ruina
}
/** mejor objetivo por peso/distancia (no re-sostener los nuestros ya tomados) */
function pickObjective(objectives, x, y) {
  let best = -1, score = -1;
  for (let i = 0; i < (objectives || []).length; i++) {
    const o = objectives[i];
    if (o.owner === side && o.state === "held") continue;
    const s = o.weight / (1 + dist(x, y, o.x, o.y) / FP);
    if (s > score) { score = s; best = i; }
  }
  return best;
}
/** apunta a la posición futura del contacto (lead) con la velocidad de proyectil de las rules */
function lead(c, spec, distancia) {
  const sp = spec.gun.shellSpeed;
  if (!sp || sp <= 0) return [c.x, c.y];
  const ticks = distancia / sp; // Q16.16 / Q16.16 = ticks
  const rad = ((c.heading & (FULL - 1)) / FULL) * 2 * Math.PI;
  const v = spec.speed || 0; // FP por tick
  return [
    c.x + Math.round(Math.cos(rad) * v * ticks),
    c.y + Math.round(Math.sin(rad) * v * ticks),
  ];
}

globalThis.controller = {
  draft(h) {
    const d = h.draft;
    if (!d) return undefined;
    const pick = ["mbt", "mbt", "scout", "scout"];
    const cost = pick.reduce((c, k) => c + (d.costs[k] ?? 99), 0);
    return cost <= d.budget && pick.every((k) => d.roster.includes(k)) ? pick : undefined;
  },

  hello(h) {
    rules = h.rules;
    map = h.map;
    side = h.side;
    hill = [
      Math.floor(map.width / 2) * FP + FP / 2,
      Math.floor(map.height / 2) * FP + FP / 2,
    ];
    for (const k of Object.keys(sticky)) delete sticky[k];
  },

  tick(o) {
    const units = [];
    for (const u of o.units) {
      if (!u.alive) continue;
      const spec = rules.units[u.kind];
      const order = { id: u.id };

      // --- contacto: preferimos el de menor vida DENTRO de alcance; si no, el más cercano ---
      let target = null, best = Infinity, bestHp = Infinity;
      for (const c of o.contacts) {
        const d = dist(u.x, u.y, c.x, c.y);
        if (d <= spec.gun.maxRange && spec.gun.mode !== "none") {
          if (!target || c.hpFrac < bestHp || (c.hpFrac === bestHp && d < best)) {
            target = c; best = d; bestHp = c.hpFrac;
          }
        }
      }
      if (!target) {
        for (const c of o.contacts) {
          const d = dist(u.x, u.y, c.x, c.y);
          if (d < best) { best = d; target = c; }
        }
      }

      // --- objetivo pegajoso: asignar y sostener ---
      let oi = sticky[u.id];
      if (oi === undefined || !o.objectives[oi]) {
        oi = pickObjective(o.objectives, u.x, u.y);
        sticky[u.id] = oi;
      }
      let obj = oi >= 0 ? o.objectives[oi] : null;
      // si el enemigo se lo queda, reasignar a otro; si es nuestro, quedarse
      if (obj && obj.owner !== undefined && obj.owner !== side && obj.owner !== null) {
        const nuevo = pickObjective(o.objectives, u.x, u.y);
        // si el mejor sigue siendo este, se queda (lo disputamos)
        sticky[u.id] = (nuevo >= 0) ? nuevo : oi;
        obj = sticky[u.id] >= 0 ? o.objectives[sticky[u.id]] : null;
      }
      let goal = obj ? [obj.x, obj.y] : hill;

      // --- esquiva de obuses entrantes ---
      let dodging = false;
      for (const inc of o.incoming || []) {
        if (dist(u.x, u.y, inc.x, inc.y) < 3 * FP) {
          goal = [2 * u.x - inc.x, 2 * u.y - inc.y];
          dodging = true;
          break;
        }
      }

      // --- combate: pararse a disparar si el enemigo está cerca (menos drones) ---
      if (target && !dodging && u.kind !== "drone" &&
          best < spec.gun.maxRange * 0.8 && spec.gun.mode !== "none") {
        goal = null; // planta y dispara
      }
      if (u.kind === "artillery" && target && !dodging) {
        goal = best < spec.gun.minRange * 1.5
          ? [u.x * 2 - target.x, u.y * 2 - target.y]
          : null;
      }

      // --- movimiento (fan anti-obstáculos del starter) ---
      if (goal && o.canMove) {
        const llegando = dist(u.x, u.y, goal[0], goal[1]) < FP * 1.2;
        if (llegando && !target) {
          order.throttle = 0; // aparca en su objetivo
        } else {
          let want = angleTo(u.x, u.y, goal[0], goal[1]);
          const offsets = [0, 341, -341, 683, -683, 1024, -1024];
          for (const off of offsets) {
            const a = (want + off) & (FULL - 1);
            const rad = (a / FULL) * 2 * Math.PI;
            if (passable(u.x + Math.cos(rad) * FP * 1.5, u.y + Math.sin(rad) * FP * 1.5)) { want = a; break; }
          }
          const d = angDiff(u.heading, want);
          order.steer = Math.max(-FP, Math.min(FP, Math.round((d / (spec.turnRate || 1)) * FP)));
          order.throttle = Math.abs(d) > 512 ? Math.round(FP * 0.2) : FP;
          if (u.blocked) { order.throttle = -FP; order.steer = FP; }
        }
      }

      // --- armas (lead en la puntería) ---
      if (target) {
        const punto = lead(target, spec, best);
        if (spec.gun.mode === "none") {
          // drones sin arma
        } else if (spec.gun.mode === "direct") {
          order.aimAt = punto;
          const aimed = Math.abs(angDiff(u.turret, angleTo(u.x, u.y, punto[0], punto[1]))) <= spec.gun.aimTolerance;
          if (u.reload === 0 && aimed && best <= spec.gun.maxRange) order.fire = true;
        } else if (u.reload === 0 && best >= spec.gun.minRange && best <= spec.gun.maxRange) {
          order.fire = punto; // indirecto
        }
      }
      units.push(order);
    }
    return { units };
  },
};
