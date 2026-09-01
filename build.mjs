/* Build: src/{index.html,app.css,*.js} -> dist/kortz.html, one self-contained file.
 *
 *   node build.mjs            minified (default)
 *   node build.mjs --raw      readable output, comments intact — for debugging
 *   node build.mjs --out X    write somewhere else
 *
 * Zero dependencies on purpose: no npm install, no lockfile, nothing to rot.
 * The minifiers below are conservative — they remove comments and layout
 * whitespace and nothing else. They never rename, reorder or rewrite code, so
 * a bug can only ever be in this file, not in something a bundler inferred.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const raw = args.includes("--raw");
const outArg = args.indexOf("--out");
const out = outArg >= 0 ? args[outArg + 1] : join(here, "dist", "kortz.html");

/* ---------------------------------------------------------------------------
   JavaScript: strip comments, indentation and blank lines.

   Line breaks are KEPT, so automatic semicolon insertion behaves exactly as it
   does in the source — this is why no semicolon audit is needed. The scanner
   tracks strings, template literals and regex literals so a `//` or `/*` inside
   one is left alone.
--------------------------------------------------------------------------- */
export function minifyJs(src){
  let out = "";
  let i = 0;
  let lastSig = "";                       // last non-whitespace code character
  // A `/` starts a regex (not a division) when the previous token cannot end
  // an expression.
  const regexOk = () => lastSig === "" || "(,=:[!&|?{};+-*%~^<>\n".includes(lastSig);

  while (i < src.length){
    const c = src[i], d = src[i + 1];

    if (c === "/" && d === "/"){                       // line comment
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*"){                       // block comment
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || (c === "/" && regexOk())){
      // Copy the literal verbatim, honouring backslash escapes. Character
      // classes are why the regex branch also tracks `[` ... `]`.
      const quote = c;
      let inClass = false;
      out += c; i++;
      while (i < src.length){
        const ch = src[i];
        if (ch === "\\"){ out += ch + (src[i + 1] ?? ""); i += 2; continue; }
        if (quote === "/" && ch === "["){ inClass = true; }
        else if (quote === "/" && ch === "]"){ inClass = false; }
        else if (ch === quote && !inClass){ out += ch; i++; break; }
        out += ch; i++;
      }
      lastSig = quote === "/" ? "/" : quote;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    else if (c === "\n") lastSig = "\n";
    i++;
  }

  return out
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .join("\n");
}

/* ---------------------------------------------------------------------------
   CSS: strip comments and collapse whitespace. Whitespace is only removed
   around punctuation where it can never be a descendant combinator.
--------------------------------------------------------------------------- */
export function minifyCss(src){
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

/* ---------------------------------------------------------------------------
   HTML: collapse only the indentation between tags — a whitespace run is
   removed only when it spans a line break, so any deliberate single space
   inside a line survives.
--------------------------------------------------------------------------- */
const minifyHtml = src => src.replace(/>\s*\n\s*</g, "><").trim();

/* Comments go even in --raw mode: the header comment describes the very tags
   the injection step searches for, and would otherwise be hit instead. */
const stripHtmlComments = src => src.replace(/<!--[\s\S]*?-->/g, "").trim();

/* ---------------------------------------------------------------------------
   The build itself. Guarded so test.mjs can import the minifiers above without
   triggering a write.
--------------------------------------------------------------------------- */
/* Load order, and the order they are concatenated in. app.js calls into both of
   the others at load, so it goes last. */
const SCRIPTS = ["kortz.js", "clock.js", "app.js"];

function main(){
const read = f => readFileSync(join(here, "src", f), "utf8");
let html = stripHtmlComments(read("index.html"));
let css  = read("app.css");
let js   = SCRIPTS.map(read).join("\n");

if (!raw){ html = minifyHtml(html); css = minifyCss(css); js = minifyJs(js); }

/* Swap each source reference for the inlined thing, loudly. A silent no-match
   here would ship a page that quietly loads nothing. */
const swap = (src, needle, repl) => {
  if (!src.includes(needle))
    throw new Error(`src/index.html does not contain ${needle} — the build looks for it by exact `
      + "text; see the comment at the top of that file");
  return src.replace(needle, () => repl);
};

html = swap(html, '<link rel="stylesheet" href="app.css">', "<style>" + css + "</style>");
for (const f of SCRIPTS.slice(0, -1)) html = swap(html, `<script src="${f}"></script>`, "");
html = swap(html, `<script src="${SCRIPTS.at(-1)}"></script>`, "<script>" + js + "<\/script>");

const banner = "<!-- Kortz Code Helper — built from src/ by build.mjs. Edit the sources, not this file. -->\n";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, banner + html + "\n");

const kb = n => (n / 1024).toFixed(1) + " kB";
console.log(`${out}  ${kb(html.length)}${raw ? "  (raw)" : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
