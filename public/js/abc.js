// Pure ABC-notation helpers (no DOM) — templates, pitch/duration edits, header parsing.

export const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'Dm', 'Gm', 'Cm', 'Fm'];
export const METERS = ['4/4', '3/4', '2/4', '6/8', '9/8', '12/8', '2/2', 'C', 'C|'];

export const TEMPLATES = {
  melody: 'Single staff (melody)',
  leadsheet: 'Lead sheet (melody + chords)',
  piano: 'Piano (grand staff)',
  satb: 'SATB choir (4 staves)',
  satbPiano: 'SATB choir + piano',
  blank: 'Blank (header only)',
};

// Bar length in eighth notes (we use L:1/8 in templates).
function barEighths(meter) {
  if (meter === 'C' || meter === 'C|') return 8;
  const [n, d] = meter.split('/').map(Number);
  return Math.round((n * 8) / d) || 8;
}

export function makeTemplate({ template = 'melody', title = 'Untitled score', composer = '', key = 'C', meter = '4/4', tempo = 100, bars = 8 }) {
  const rest = `z${barEighths(meter)}`;
  const compound = /^(6|9|12)\/8$/.test(meter);
  const q = compound ? `3/8=${tempo}` : `1/4=${tempo}`;
  const line = (r, n = 4) => Array.from({ length: n }, () => r).join(' | ');
  const body = (r) => {
    const lines = [];
    for (let i = 0; i < bars; i += 4) lines.push(line(r, Math.min(4, bars - i)) + (i + 4 >= bars ? ' |]' : ' |'));
    return lines;
  };
  const head = ['X:1', `T:${title}`, composer ? `C:${composer}` : null, `M:${meter}`, 'L:1/8', `Q:${q}`].filter(Boolean);

  switch (template) {
    case 'blank':
      return [...head, `K:${key}`, ''].join('\n');
    case 'leadsheet':
      return [...head, `K:${key}`, ...body(`"${key.replace(/m$/, 'm')}" ${rest}`)].join('\n');
    case 'piano': {
      const rh = body(rest), lh = body(rest);
      const out = [...head, '%%score {RH | LH}', 'V:RH clef=treble name="Piano"', 'V:LH clef=bass', '%%MIDI program 0', `K:${key}`];
      rh.forEach((l, i) => out.push(`[V:RH] ${l}`, `[V:LH] ${lh[i]}`));
      return out.join('\n');
    }
    case 'satb':
    case 'satbPiano': {
      const voices = [['S', 'treble', 'Soprano'], ['A', 'treble', 'Alto'], ['T', 'treble-8', 'Tenor'], ['B', 'bass', 'Bass']];
      const piano = template === 'satbPiano';
      const out = [...head, piano ? '%%score [S A T B] {RH | LH}' : '%%score [S A T B]'];
      for (const [id, clef, name] of voices) out.push(`V:${id} clef=${clef} name="${name}" sname="${id}"`);
      if (piano) out.push('V:RH clef=treble name="Piano"', 'V:LH clef=bass');
      out.push('%%MIDI program 52', `K:${key}`);
      const b = body(rest);
      b.forEach((l) => {
        for (const [id] of voices) out.push(`[V:${id}] ${l}`);
        if (piano) out.push(`[V:RH] ${l}`, `[V:LH] ${l}`);
      });
      return out.join('\n');
    }
    default:
      return [...head, `K:${key}`, ...body(rest)].join('\n');
  }
}

export function headerField(abc, field) {
  const m = abc.match(new RegExp(`^${field}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

// Unit note length as a fraction [num, den]
export function unitLength(abc) {
  const l = headerField(abc, 'L');
  const m = l.match(/^(\d+)\/(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [1, 8];
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
// Duration suffix for a note whose length is num/den of a whole note, relative to the unit length.
export function durationSuffix(num, den, abc) {
  const [ln, ld] = unitLength(abc);
  let n = num * ld, d = den * ln;
  const g = gcd(n, d); n /= g; d /= g;
  if (d === 1) return n === 1 ? '' : String(n);
  if (n === 1 && d === 2) return '/';
  return n === 1 ? `/${d}` : `${n}/${d}`;
}

// MIDI number -> ABC pitch (sharps for black keys)
const PC = ['C', '^C', 'D', '^D', 'E', 'F', '^F', 'G', '^G', 'A', '^A', 'B'];
export function midiToAbc(midi) {
  const name = PC[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  const acc = name.length > 1 ? name[0] : '';
  const letter = name.slice(-1);
  if (octave >= 5) return acc + letter.toLowerCase() + "'".repeat(octave - 5);
  return acc + letter + ','.repeat(Math.max(0, 4 - octave));
}

// Mask quoted chord symbols, !decorations!, +decorations+ and comments so edits only touch real notes.
function maskNonNotes(s) {
  return s.replace(/"[^"]*"|![^!\n]*!|\+[^+\n]*\+|%.*$/gm, (m) => '\u0000'.repeat(m.length));
}
const NOTE_G = /(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)/g;
const LETTERS = 'CDEFGAB';

function noteToStep(letter, octs) {
  let step = LETTERS.indexOf(letter.toUpperCase()) + (letter === letter.toLowerCase() ? 7 : 0);
  for (const c of octs) step += c === "'" ? 7 : -7;
  return step; // 0 = C (middle C)
}
function stepToNote(step) {
  const oct = Math.floor(step / 7);
  const letter = LETTERS[((step % 7) + 7) % 7];
  if (oct >= 1) return letter.toLowerCase() + "'".repeat(oct - 1);
  return letter + ','.repeat(-oct);
}

// Replace every note inside `token` using fn(acc, letter, octs) -> string
function mapNotes(token, fn) {
  const mask = maskNonNotes(token);
  let out = '', last = 0, m;
  NOTE_G.lastIndex = 0;
  while ((m = NOTE_G.exec(mask))) {
    out += token.slice(last, m.index) + fn(m[1] || '', m[2], m[3] || '');
    last = m.index + m[0].length;
  }
  return out + token.slice(last);
}

// Move notes up/down by diatonic steps (drops explicit accidentals so the note follows the key).
export function shiftPitch(token, steps) {
  return mapNotes(token, (acc, letter, octs) => stepToNote(noteToStep(letter, octs) + steps));
}

// Replace the pitch letter of single notes / rests with a new letter (keeps octave closest to the old note).
export function setPitchLetter(token, newLetter) {
  const L = newLetter.toUpperCase();
  const mask = maskNonNotes(token);
  if (!/[A-Ga-g]/.test(mask)) {
    const i = mask.search(/[zx]/);
    return i < 0 ? token : token.slice(0, i) + L + token.slice(i + 1);
  }
  let done = false;
  return mapNotes(token, (acc, letter, octs) => {
    if (done) return acc + letter + octs;
    done = true;
    const old = noteToStep(letter, octs);
    const base = Math.floor(old / 7) * 7 + LETTERS.indexOf(L);
    const candidates = [base - 7, base, base + 7];
    const best = candidates.reduce((a, b) => (Math.abs(b - old) < Math.abs(a - old) ? b : a));
    return stepToNote(best);
  });
}

// Split a note/chord/rest token into [body, duration, trailing]
export function splitDuration(token) {
  const m = token.match(/^([\s\S]*[A-Ga-gzZxX\]][,']*)(\d*(?:\/+\d*)?)([^A-Ga-g\]]*)$/);
  return m ? [m[1], m[2], m[3]] : [token, '', ''];
}
export function setDuration(token, suffix) {
  const [body, , tail] = splitDuration(token);
  return body + suffix + tail;
}
export function toRest(token) {
  const [, dur, tail] = splitDuration(token);
  return 'z' + dur + tail.replace(/-/g, '');
}
export function toggleAccidental(token, acc) {
  let done = false;
  return mapNotes(token, (a, letter, octs) => {
    if (done) return a + letter + octs;
    done = true;
    return (a === acc ? '' : acc) + letter + octs;
  });
}

// Split a full transcription into header (through K: and any following V:/%% lines) and body.
export function splitHeader(abc) {
  const lines = abc.split('\n');
  let k = lines.findIndex((l) => /^K:/.test(l));
  if (k < 0) return { header: '', body: abc };
  while (k + 1 < lines.length && /^(V:|%%|I:)/.test(lines[k + 1])) k++;
  return { header: lines.slice(0, k + 1).join('\n'), body: lines.slice(k + 1).join('\n') };
}

export function cleanAiAbc(text) {
  let t = text.replace(/\r/g, '');
  const fence = t.match(/```(?:abc)?\n([\s\S]*?)(```|$)/);
  if (fence) t = fence[1];
  return t.trim();
}

// For continuation pages, drop any header lines the model repeated anyway.
export function stripRepeatedHeader(text) {
  const lines = cleanAiAbc(text).split('\n');
  let i = 0;
  while (i < lines.length && (/^[XTCMLQKRSOZ]:/.test(lines[i]) || /^V:\S+\s+.*(clef|name)=/.test(lines[i]) || /^%%score/.test(lines[i]))) i++;
  return lines.slice(i).join('\n').trim();
}
