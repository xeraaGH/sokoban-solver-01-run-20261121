// Push-optimal per-room Sokoban solver.
//
// Strategy: a Sokoban level from this competition's generator is a hallway with
// 1-4 rooms off it (3-4 boxes each). A box pushed through a door into the hallway
// can never come back, so every box stays in its room and the level's push-optimal
// count is the sum of its rooms' optima. The solver therefore
//   1. cuts the hallway's dead squares out of the floor and splits what is left
//      into rooms (each room holds as many boxes as goals),
//   2. solves each room on its own with a breadth-first search over pushes --
//      the first solved state a BFS meets is push-optimal -- with the other
//      rooms' boxes standing as walls,
//   3. walks the player from room to room, stitching the rooms' move strings.
//
// The push search prunes two deadlocks that can never be undone: a box on a dead
// square (no push, ignoring the other boxes, ever brings it to a goal) and a box
// in a frozen 2x2 block of walls and boxes with a box off its goal. A state is
// the boxes' squares (a BigInt bitmask) plus the lowest square of the player's
// reachable region, so two states that differ only in where the player stands
// inside one region are the same state.
//
// Deterministic: no clock, no randomness, fixed expansion order. The only budget
// is a count of expanded states, never wall time, so two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** A level: width, height, walls (1 = wall), goal squares, box squares, player square. */
type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

/** [dx, dy, step letter] in a fixed order, so every tie breaks the same way. */
const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

/** The most states one room search keeps, and the most states the whole set spends. */
const MAX_STATES_PER_ROOM = 2_000_000;
const MAX_STATES_WHOLE_SET = 12_000_000;

let statesSpent = 0;

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  // Tolerate CRLF/CR line endings: a stray carriage return must never become a floor square.
  const rows = text.replace(/\r\n?/g, '\n').split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the player's region from `from` with `occupied` in the way, marking
 * `seen` with `stamp`; returns the region's lowest square, the state's player key.
 */
function reachLow(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/**
 * The push-optimal solution of `level`: {pushes, moves}, or null when the search
 * gives up (or the level has no solution). Breadth-first over pushes: states are
 * expanded in order of pushes made, so the first solved state met is optimal.
 */
function solvePushOptimal(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // A state's key: the boxes' bitmask and the region's lowest square.
  const keyOf = (boxes: number[], low: number): bigint => {
    let mask = 0n;
    for (const b of boxes) mask |= 1n << BigInt(b);
    return (mask << 9n) | BigInt(low);
  };

  const statesBoxes: number[][] = [level.boxes.slice()];
  const statesPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const index = new Map<bigint, number>();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, reachLow(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  let found = solved(level.boxes) ? 0 : -1;
  let expanded = 0;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    if (++expanded > maxStates || ++statesSpent > MAX_STATES_WHOLE_SET) return null;
    const boxes = statesBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reachLow(level, occupied, statesPlayer[head], seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // The player must reach the square behind the box, and the box must land on open, live floor.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: bigint = -1n;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reachLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) return null;
        index.set(key, statesBoxes.length);
        statesBoxes.push(next!);
        statesPlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushTo.push(t);
        if (solved(next!)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[2];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * Replay `moves` on `level`: {solved, pushes}, or null when a step is illegal
 * (into a wall, or pushing a box into a wall or another box). The solver checks
 * every answer it writes this way before it writes it, so a reconstruction bug
 * can never ship an illegal answer: an invalid replay is answered empty.
 */
function verifyReplay(level: Level, moves: string): { solved: boolean; pushes: number } | null {
  const { w, wall, goals } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const occupied = new Uint8Array(wall.length);
  for (const b of level.boxes) occupied[b] = 1;
  let player = level.player;
  let pushes = 0;
  for (const ch of moves.toLowerCase()) {
    const d = ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
    const q = player + d;
    if (wall[q]) return null;
    if (occupied[q]) {
      const t = q + d;
      if (wall[t] || occupied[t]) return null;
      occupied[q] = 0;
      occupied[t] = 1;
      pushes++;
    }
    player = q;
  }
  return { solved: goals.every((g) => occupied[g]), pushes };
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; done?: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box
 * there reaches no goal) out of the floor, and each part left that holds a box is
 * a room. Null when some part holds more or fewer boxes than goals, or a box
 * starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the
 * other rooms' boxes standing as walls (on their goals once their room is done),
 * the player walking on from where the last room left it. A box never leaves its
 * room, so the rooms' optima add up to the level's. Falls back to a whole-level
 * search when the level is no set of rooms.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, MAX_STATES_PER_ROOM);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = solvePushOptimal(sub, MAX_STATES_PER_ROOM);
    // Second chance on a budget miss: the generator keeps a room only when the
    // reference search solves it in 250k states, so a miss here is a budget
    // artefact, not an unsolvable room -- retry once with a doubled budget.
    if (solved === null) solved = solvePushOptimal(sub, MAX_STATES_PER_ROOM * 2);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Solve one level's text; an empty answer (worth no points) on any failure, never a crash. */
function solve(text: string): string {
  try {
    const level = parseLevel(text);
    const solved = solveByRooms(level);
    if (solved === null) return '';
    // Verify the stitched answer replays to a solved level in exactly the
    // pushes the search promised; anything else is answered empty.
    const replay = verifyReplay(level, solved.moves);
    if (replay === null || !replay.solved || replay.pushes !== solved.pushes) return '';
    return solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
