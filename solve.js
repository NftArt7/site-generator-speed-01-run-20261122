// site-generator-speed-01: a faster drop-in for makefun-site 1.0.0.
//
// This file is an independent implementation of the behaviour makefun-site's
// README states (front matter, slug rule, Markdown subset, template dialect,
// report), written to produce the same output tree byte for byte, faster.
// Nothing here is copied from the reference: the pipeline is structured
// differently, and the speed comes from
//   - front matter scanned line by line without splitting the whole body,
//   - Markdown rendered in a single pass over the source, with inline
//     markup handled by one batched scanner instead of per-character
//     escaping and a token list,
//   - slug and long-date work memoised per build, link targets resolved
//     through a cache,
//   - templates compiled once per case into plain JavaScript functions
//     (via the Function constructor) instead of being walked as node
//     trees on every render.
// Every build is answered alone: all caches live inside build() and are
// dropped when it returns, so nothing is carried from one case to the next.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------ text helpers

const ESCAPES = Object.create(null);
ESCAPES['&'] = '&amp;';
ESCAPES['<'] = '&lt;';
ESCAPES['>'] = '&gt;';
ESCAPES['"'] = '&quot;';
ESCAPES["'"] = '&#39;';
const ESCAPE_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  let out = '';
  let p = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ESCAPES[text[i]];
    if (e !== undefined) {
      if (p < i) out += text.slice(p, i);
      out += e;
      p = i + 1;
    }
  }
  if (p < text.length) out += text.slice(p);
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;
const COMBINING = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left. Pure-ASCII input skips the normalisation: NFKD is the
 * identity on ASCII and ASCII holds no combining marks.
 */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. `cache` is per build. */
function longDate(date, cache) {
  let s = cache.get(date);
  if (s === undefined) {
    s = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    cache.set(date, s);
  }
  return s;
}

/** Whether the UTF-16 code unit is JavaScript whitespace (the \s set), as a table. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;
function isWhitespace(code) {
  return WS_TABLE[code] === 1;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWhitespace(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function parseStringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

const DATE_ERROR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

/** A date value: YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function parseDateValue(raw) {
  if (raw.length !== 10) return { error: DATE_ERROR };
  for (let i = 0; i < 10; i++) {
    const c = raw.charCodeAt(i);
    if (i === 4 || i === 7) {
      if (c !== 45) return { error: DATE_ERROR }; // '-'
    } else if (c < 48 || c > 57) return { error: DATE_ERROR };
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERROR };
  return { value: raw };
}

/** A tags value: [a, b, c], each name trimmed, none empty or holding " [ ]. */
function parseTagsValue(raw) {
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const parts = inner.split(',');
  const tags = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    tags[i] = t;
  }
  return { value: tags };
}

/** Whether `raw` is a slug: a-z and 0-9, single - between, at most 64 chars. */
function isSlug(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
      continue;
    }
    if (c === 45 && !prevDash) {
      prevDash = true;
      continue;
    }
    return false;
  }
  return !prevDash;
}

/** Whether `raw` is a template name: a-z, 0-9 and -. */
function isTemplateName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = parseStringValue(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return parseDateValue(raw);
    case 'tags':
      return parseTagsValue(raw);
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isTemplateName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** One front-matter line, `key: value` with one space after the colon. */
function parseFmLine(line, lineNo, data) {
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (!((c >= 97 && c <= 122) || c === 95)) break; // a-z or _
    k++;
  }
  if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` }; // ':'
  const key = line.slice(0, k);
  let raw;
  if (k + 1 === line.length) raw = '';
  else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
  else return { error: `line ${lineNo} is not "key: value"` };
  raw = raw.replace(/[ \t]+$/, '');
  if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
  if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
  if (raw === '') return { error: `key "${key}" has no value` };
  const v = valueOf(key, raw);
  if ('error' in v) return v;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The close line is
 * found first (a missing close is reported before any bad line in it), then
 * the lines between are read, and the body is the text after the close line.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const firstEnd = nl0 === -1 ? text.length : nl0;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (
      end - pos === 3 &&
      text.charCodeAt(pos) === 45 &&
      text.charCodeAt(pos + 1) === 45 &&
      text.charCodeAt(pos + 2) === 45
    ) {
      closeStart = pos;
      closeEnd = end;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = nl0 === -1 ? text.length : nl0 + 1;
  let lineNo = 2;
  while (lineStart < closeStart) {
    const nl = text.indexOf('\n', lineStart);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, end);
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // '#' opens a comment
      const err = parseFmLine(line, lineNo, data);
      if (err !== null) return err;
    }
    lineStart = end + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ------------------------------------------------------------ Markdown

/**
 * The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
 * (as UTF-16 code units).
 */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const wlen = what.length;
  for (let j = from; j <= n - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < n && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_TEST = /\s/;

/** The characters inline rendering treats specially, as one global pattern. */
const INLINE_RE = /[\\`*\[]|[&<>"']/g;

/**
 * `s` rendered inline, as one string. `env.link(target)` is a link's href.
 * The pattern jumps straight to the next special character, so plain runs
 * are appended whole and the loop only runs once per markup opener or
 * escaped character. A construct that turns out to be literal leaves its
 * characters in the plain run, and the scan resumes just past them. The
 * result is built with +=, which V8 keeps as a rope until it is read. The
 * pattern's lastIndex is set explicitly after every construct, so the
 * recursive calls for nested markup cannot disturb the outer scan.
 */
function inlineTo(s, env) {
  const n = s.length;
  let out = '';
  let p = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null) {
    const i = m.index;
    const code = m[0].charCodeAt(0);
    if (code === 92) {
      // '\': an escapable character after it is written escaped
      const d = i + 1 < n ? s.charCodeAt(i + 1) : -1;
      if (d !== -1 && d < 128 && ESCAPABLE[d] === 1) {
        if (p < i) out += s.slice(p, i);
        out += d === 62 ? '&gt;' : String.fromCharCode(d);
        p = i + 2;
        INLINE_RE.lastIndex = i + 2;
        continue;
      }
      continue;
    }
    if (code === 96) {
      // '`': a code span to the next backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (p < i) out += s.slice(p, i);
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        p = j + 1;
        INLINE_RE.lastIndex = j + 1;
        continue;
      }
      continue;
    }
    if (code === 42) {
      // '*': strong, or emphasis on a single star
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (p < i) out += s.slice(p, i);
          out += '<strong>' + inlineTo(s.slice(i + 2, j), env) + '</strong>';
          p = j + 2;
          INLINE_RE.lastIndex = j + 2;
          continue;
        }
        // No closer: both stars stay plain, as the scanner would leave them.
        INLINE_RE.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (p < i) out += s.slice(p, i);
        out += '<em>' + inlineTo(s.slice(i + 1, j), env) + '</em>';
        p = j + 1;
        INLINE_RE.lastIndex = j + 1;
        continue;
      }
      continue;
    }
    if (code === 91) {
      // '[': a link, [text](target) with no whitespace in the target
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_TEST.test(target)) {
        if (p < i) out += s.slice(p, i);
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inlineTo(s.slice(i + 1, k), env) + '</a>';
        p = mm + 1;
        INLINE_RE.lastIndex = mm + 1;
        continue;
      }
      continue;
    }
    // One of the five escaped characters.
    if (p < i) out += s.slice(p, i);
    out += code === 38 ? '&amp;' : code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;';
    p = i + 1;
  }
  if (p < n) out += s.slice(p, n);
  return out;
}

/** Any character inline rendering treats specially: markup openers and the escaped five. */
const INLINE_SPECIAL = /[\\`*\[]|[&<>"']/;

/**
 * `s` rendered inline, as one string. Text holding no markup opener and
 * none of the escaped characters is itself (it needs no escaping either).
 */
function inlineStr(s, env) {
  if (!INLINE_SPECIAL.test(s)) return s;
  return inlineTo(s, env);
}

// --- block line classifiers: each works on src[a, b), a line without '\n'.

/**
 * A fence opener's language ("" for a bare fence), or null when the line is
 * not one: three backticks, an optional language, then spaces or tabs only.
 */
function fenceOpenLang(src, a, b) {
  if (b - a < 3 || src.charCodeAt(a) !== 96 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  const langStart = i;
  while (i < b) {
    const c = src.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  const lang = src.slice(langStart, i);
  while (i < b) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether the line closes a fence: three backticks, then spaces or tabs. */
function isFenceClose(src, a, b) {
  if (b - a < 3 || src.charCodeAt(a) !== 96 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * One line's block kind, from its first character alone: 0 other (paragraph
 * text), 1 blank, 2 fence opener, 3 heading, 4 thematic break, 5 blockquote,
 * 6 list opener. The data for kinds 2, 3 and 6 comes from fenceOpenLang,
 * headingOf and listStart, called only when the kind matches.
 */
function classifyLine(src, a, b) {
  if (a >= b) return 1;
  const c0 = src.charCodeAt(a);
  if (c0 === 32 || c0 === 9) {
    for (let i = a; i < b; i++) {
      const c = src.charCodeAt(i);
      if (c !== 32 && c !== 9) return 0;
    }
    return 1;
  }
  if (c0 === 96) {
    if (b - a < 3 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return 0;
    let i = a + 3;
    while (i < b) {
      const c = src.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
      i++;
    }
    while (i < b) {
      const c = src.charCodeAt(i);
      if (c !== 32 && c !== 9) return 0;
      i++;
    }
    return 2;
  }
  if (c0 === 35) {
    let hashes = 0;
    while (a + hashes < b && src.charCodeAt(a + hashes) === 35) hashes++;
    if (hashes === 0 || hashes > 6) return 0;
    let i = a + hashes;
    if (i >= b) return 0;
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return 0;
    while (i < b && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
    let end = b;
    while (end > i && (src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9)) end--;
    if (end <= i) return 0;
    return 3;
  }
  if (c0 === 45 || c0 === 42) {
    if (b - a >= 3) {
      const c1 = src.charCodeAt(a + 1);
      const c2 = src.charCodeAt(a + 2);
      if ((c0 === 45 && c1 === 45 && c2 === 45) || (c0 === 42 && c1 === 42 && c2 === 42)) {
        let blank = true;
        for (let i = a + 3; i < b; i++) {
          const c = src.charCodeAt(i);
          if (c !== 32 && c !== 9) {
            blank = false;
            break;
          }
        }
        if (blank) return 4;
      }
    }
    if (a + 1 < b && src.charCodeAt(a + 1) === 32) return 6;
    return 0;
  }
  if (c0 === 62) return 5;
  if (c0 >= 48 && c0 <= 57) {
    let i = a;
    let digits = 0;
    while (i < b && digits < 10) {
      const c = src.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
      digits++;
    }
    if (digits >= 1 && digits <= 9 && i + 1 < b && src.charCodeAt(i) === 46 && src.charCodeAt(i + 1) === 32) return 6;
    return 0;
  }
  return 0;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(src, a, b) {
  let hashes = 0;
  while (a + hashes < b && src.charCodeAt(a + hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  let i = a + hashes;
  if (i >= b) return null;
  const c = src.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < b && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  let end = b;
  while (end > i && (src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9)) end--;
  if (end <= i) return null;
  return { depth: hashes, text: src.slice(i, end) };
}

/** A line trimmed of spaces and tabs at both ends. */
function trimRange(src, a, b) {
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return src.slice(a, b);
}

/**
 * A list opener: { ordered, start, content } or null. A bullet is "- " or
 * "* "; an ordered list is 1-9 digits and ". ". The content is trimmed.
 */
function listStart(src, a, b) {
  const c0 = src.charCodeAt(a);
  if ((c0 === 45 || c0 === 42) && a + 1 < b && src.charCodeAt(a + 1) === 32) {
    return { ordered: false, start: 1, content: trimRange(src, a + 2, b) };
  }
  let i = a;
  let digits = 0;
  while (i < b && digits < 10) {
    const c = src.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
    digits++;
  }
  if (digits >= 1 && digits <= 9 && i + 1 < b && src.charCodeAt(i) === 46 && src.charCodeAt(i + 1) === 32) {
    return { ordered: true, start: Number(src.slice(a, i)), content: trimRange(src, i + 2, b) };
  }
  return null;
}

/** Whether the line continues a list item: two or more spaces, then a non-space. */
function isContinued(src, a, b) {
  if (b - a < 3) return false;
  if (src.charCodeAt(a) !== 32 || src.charCodeAt(a + 1) !== 32) return false;
  let i = a + 2;
  while (i < b && src.charCodeAt(i) === 32) i++;
  if (i >= b) return false;
  return !isWhitespace(src.charCodeAt(i));
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading) and
 * its excerpt (the first paragraph's inline HTML, or ""). `slugify` is the
 * build's memoised slug function; `env.link(target)` resolves a link.
 */
function renderMarkdown(src, env, slugify) {
  const N = src.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let pos = 0;
  while (pos <= N) {
    const nl = src.indexOf('\n', pos);
    const a = pos;
    const b = nl === -1 ? N : nl;
    const next = nl === -1 ? N + 1 : nl + 1;
    const kind = classifyLine(src, a, b);
    if (kind === 1) {
      pos = next;
      continue;
    }
    if (kind === 2) {
      const lang = fenceOpenLang(src, a, b);
      const lines = [];
      pos = next;
      while (pos <= N) {
        const nl2 = src.indexOf('\n', pos);
        const a2 = pos;
        const b2 = nl2 === -1 ? N : nl2;
        if (isFenceClose(src, a2, b2)) {
          pos = nl2 === -1 ? N + 1 : nl2 + 1;
          break;
        }
        lines.push(src.slice(a2, b2));
        pos = nl2 === -1 ? N + 1 : nl2 + 1;
      }
      let body = '';
      if (lines.length > 0) {
        const esc = [];
        for (const l of lines) {
          esc.push(escapeHtml(l));
          esc.push('\n');
        }
        body = esc.join('');
      }
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      parts.push(`<pre><code${cls}>${body}</code></pre>\n`);
      continue;
    }
    if (kind === 3) {
      const hd = headingOf(src, a, b);
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inlineStr(hd.text, env);
      parts.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      pos = next;
      continue;
    }
    if (kind === 4) {
      parts.push('<hr>\n');
      pos = next;
      continue;
    }
    if (kind === 5) {
      // '>': a blockquote
      const qlines = [];
      while (pos <= N) {
        const nl2 = src.indexOf('\n', pos);
        const a2 = pos;
        const b2 = nl2 === -1 ? N : nl2;
        if (src.charCodeAt(a2) !== 62) break;
        let s2 = a2 + 1;
        if (s2 < b2 && src.charCodeAt(s2) === 32) s2++;
        qlines.push(trimRange(src, s2, b2));
        pos = nl2 === -1 ? N + 1 : nl2 + 1;
      }
      const kept = qlines.filter((l) => l !== '');
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push(`<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    if (kind === 6) {
      const ls = listStart(src, a, b);
      const ordered = ls.ordered;
      const startNum = ls.start;
      const items = [];
      let cur = [ls.content];
      items.push(cur);
      pos = next;
      while (pos <= N) {
        const nl2 = src.indexOf('\n', pos);
        const a2 = pos;
        const b2 = nl2 === -1 ? N : nl2;
        const m = listStart(src, a2, b2);
        if (m !== null && m.ordered === ordered) {
          cur = [m.content];
          items.push(cur);
          pos = nl2 === -1 ? N + 1 : nl2 + 1;
          continue;
        }
        if (isContinued(src, a2, b2)) {
          cur.push(trimRange(src, a2, b2));
          pos = nl2 === -1 ? N + 1 : nl2 + 1;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      const li = [];
      for (const it of items) li.push(`<li>${inlineStr(it.join('\n'), env)}</li>\n`);
      parts.push(`${open}\n${li.join('')}</${tag}>\n`);
      continue;
    }
    const plines = [trimRange(src, a, b)];
    pos = next;
    while (pos <= N) {
      const nl2 = src.indexOf('\n', pos);
      const a2 = pos;
      const b2 = nl2 === -1 ? N : nl2;
      // A blank line, fence, heading or thematic break ends the paragraph;
      // a quote or list line is paragraph text here.
      const k2 = classifyLine(src, a2, b2);
      if (k2 !== 0 && k2 !== 5 && k2 !== 6) break;
      plines.push(trimRange(src, a2, b2));
      pos = nl2 === -1 ? N + 1 : nl2 + 1;
    }
    const html = inlineStr(plines.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[a, b) holds only spaces or tabs. */
function isSpacesOnly(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src, lineStart, open) && isSpacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- rendering helpers, shared by every compiled template.

/** The value at `name` in the scope chain: the nearest scope holding it. */
function lk0(sc, name) {
  for (let s = sc; s !== null; s = s.parent) {
    if (Object.hasOwn(s.vars, name)) return s.vars[name];
  }
  return undefined;
}

/** One more step down a path: an own property of an object, else undefined. */
function lkP(v, k) {
  return v === null || typeof v !== 'object' || !Object.hasOwn(v, k) ? undefined : v[k];
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tx(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tx).join(', ');
  return '';
}

const HELPERS = { lk0, lkP, tr, tx };

// --- compilation: a parsed template becomes one JavaScript function.
//
// The function takes (sc, E, T, D, H): the scope chain, the HTML escape, the
// map of compiled templates, the include depth, and HELPERS. It builds its
// output in `o` and returns it. A for loop's element and loop record are
// also bound to fresh locals, so a path starting at the loop variable reads
// straight from the local; every other first name goes through lk0, and
// each further step through lkP.

/** JavaScript source for the value at `path` in the current scope. */
function lookupExpr(g, path) {
  const first = path[0];
  let base;
  if (first === 'loop' && g.frames.length > 0) {
    base = g.frames[g.frames.length - 1].loopLocal;
  } else {
    for (let i = g.frames.length - 1; i >= 0; i--) {
      if (g.frames[i].varName === first) {
        base = g.frames[i].varLocal;
        break;
      }
    }
    if (base === undefined) base = `lk0(sc,${JSON.stringify(first)})`;
  }
  let expr = base;
  for (let k = 1; k < path.length; k++) expr = `lkP(${expr},${JSON.stringify(path[k])})`;
  return expr;
}

/** JavaScript source for `nodes`, appended to g.code. */
function emitNodes(g, nodes) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      g.code.push(`o+=${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var') {
      g.code.push(`o+=E(tx(${lookupExpr(g, n.path)}));`);
    } else if (n.kind === 'raw') {
      g.code.push(`o+=tx(${lookupExpr(g, n.path)});`);
    } else if (n.kind === 'if') {
      const cond = n.not ? `!tr(${lookupExpr(g, n.path)})` : `tr(${lookupExpr(g, n.path)})`;
      g.code.push(`if(${cond}){`);
      emitNodes(g, n.then);
      if (n.else !== null) {
        g.code.push('}else{');
        emitNodes(g, n.else);
      }
      g.code.push('}');
    } else if (n.kind === 'for') {
      const id = g.counter++;
      const arr = `_a${id}`;
      const len = `_n${id}`;
      const key = `_k${id}`;
      const el = `_x${id}`;
      const loop = `_l${id}`;
      const saved = `_s${id}`;
      g.code.push(`{const ${arr}=${lookupExpr(g, n.path)};`);
      g.code.push(`if(Array.isArray(${arr})){const ${len}=${arr}.length;`);
      g.code.push(`for(let ${key}=0;${key}<${len};${key}++){const ${el}=${arr}[${key}];`);
      g.code.push(`const ${loop}={index:${key}+1,first:${key}===0,last:${key}===${len}-1,length:${len}};`);
      g.code.push(`const ${saved}=sc;sc={vars:{${JSON.stringify(n.name)}:${el},loop:${loop}},parent:${saved}};`);
      g.frames.push({ varName: n.name, varLocal: el, loopLocal: loop });
      emitNodes(g, n.body);
      g.frames.pop();
      // closes the for body, the Array.isArray guard and the outer block
      g.code.push(`sc=${saved};}}}`);
    } else if (n.kind === 'include') {
      g.code.push(`{if(D<8){const _f=T.get(${JSON.stringify(n.name)});if(_f!==undefined)o+=_f(sc,E,T,D+1,H);}}`);
    }
  }
}

/**
 * A template's source compiled to a render function
 * (sc, E, T, D, H) => string. Throws TemplateError when it does not parse.
 */
function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  const g = { code: ['const{lk0,lkP,tr,tx}=H;', 'let o="";'], counter: 0, frames: [] };
  emitNodes(g, nodes);
  g.code.push('return o;');
  return new Function('sc', 'E', 'T', 'D', 'H', g.code.join('\n'));
}

// ------------------------------------------------------------ the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (https:, mailto: ...). */
function hasScheme(target) {
  if (target.length < 2) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true; // ':'
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b, slugify) {
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b, slugify, resolveCache) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // '/' or '#'
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let path;
      if (rel === '') {
        path = null;
      } else {
        const key = `${dir}\n${rel}`;
        path = resolveCache.get(key);
        if (path === undefined) {
          path = resolvePath(dir, rel);
          resolveCache.set(key, path);
        }
      }
      if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
      b.broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link }, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b, slugify) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
function linkOf(s, dateCache) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) };
}

/** A post's card, as lists show it. */
function cardOf(s, dateCache) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b, dateCache) {
  // One card per source, built once and shared by the lists and the page record.
  for (const s of b.sources) s._card = cardOf(s, dateCache);
  for (const p of b.posts) b.cards.set(p, p._card);
  for (const s of b.sources) {
    s._page = {
      ...s._card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.post ? s.newer : null, dateCache),
      older: linkOf(s.post ? s.older : null, dateCache),
      is_post: s.post,
    };
  }
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const baseVars = { site, tags: allTags, recent };
  const render = (name, extra) => {
    const f = b.templates.get(name);
    if (f === undefined) return null;
    return f({ vars: { ...baseVars, ...extra }, parent: null }, escapeHtml, b.templates, 0, HELPERS);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: s._page });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) },
    });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function reportOut(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
function build(input) {
  // Per-build caches only: nothing is carried from one case to the next.
  const slugCache = new Map();
  const dateCache = new Map();
  const resolveCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b, slugify);
  markdown(b, slugify, resolveCache);
  collections(b);
  tags(b, slugify);
  layouts(b, dateCache);
  reportOut(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
