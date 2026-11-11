// Updates the profile README: stat badges with exact numbers from the GitHub API
// and the game cards. Runs in GitHub Actions (see ../workflows/update-profile.yml),
// but also works locally with `node .github/scripts/update-profile.mjs`.
//
// A game whose repository is private gets a card without link and a
// "coming soon" badge. As soon as the repository is public, the next run
// adds the link, the version and the download count by itself.

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { contributions, diamondCalendarSvg, ornamentSvg } from './calendar.mjs';

const USER = 'ILIuIcIaI';

const GAMES = [
  { title: 'DarkHour', repo: 'DarkHour', image: 'darkhour.jpg', runsOn: 'Windows' },
  { title: 'Grappling Hook Prototype', repo: 'enterhaken-prototyp', image: 'grappling-hook.jpg', runsOn: 'Browser' },
  { title: 'Call of Duty Black Warfare 69', repo: 'Call-of-Duty-Black-Warfare-69', image: 'black-warfare.jpg', runsOn: 'Windows · Browser' },
];

// red = the jacket in the banner GIF (most frequent jacket colour, measured over all frames)
const COLOR = { label: '0e0e12', red: '802726', blue: '9fd3f2', gray: '3a3a46' };
const BADGES = 'assets/badges';
const README = 'README.md';

const token = process.env.GITHUB_TOKEN;
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': `${USER}-profile`,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
  return res.json();
}

async function pages(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const releaseCache = new Map();
async function releasesOf(repo) {
  if (releaseCache.has(repo)) return releaseCache.get(repo);
  const releases = await pages(`/repos/${USER}/${repo}/releases`);
  // GitHub's release list sometimes leaves out a published release that is
  // reachable through its tag, so every tag without a listed release is checked too.
  const listed = new Set(releases.map((r) => r.tag_name));
  for (const tag of await pages(`/repos/${USER}/${repo}/tags`)) {
    if (listed.has(tag.name)) continue;
    const release = await api(`/repos/${USER}/${repo}/releases/tags/${encodeURIComponent(tag.name)}`);
    if (release) releases.push(release);
  }
  const published = releases.filter((r) => !r.draft);
  releaseCache.set(repo, published);
  return published;
}

// Only real game files count as downloads; screenshots or videos attached to
// release notes are loaded by everyone who reads the notes.
const GAME_FILE = /\.(zip|7z|rar|exe|msi|tar\.gz|tgz|apk|dmg|appimage)$/i;
const gameFiles = (release) => release.assets.filter((a) => GAME_FILE.test(a.name));
const downloadsOf = (releases) => releases.reduce((sum, r) => sum + gameFiles(r).reduce((s, a) => s + a.download_count, 0), 0);
const hasGameFiles = (releases) => releases.some((r) => gameFiles(r).length > 0);

// Platforms from the file names of the newest release that names any, e.g.
// "Game-1.0-Windows.zip" + "Game-1.0-Browser.zip" -> "Windows · Browser".
const PLATFORMS = [['Windows', /\bwin(dows|64|32)?\b|\.exe$|\.msi$/i], ['Browser', /browser|web/i], ['Linux', /linux|appimage/i], ['macOS', /mac|osx|\.dmg$/i], ['Android', /android|\.apk$/i]];
function platformsOf(releases) {
  const newest = [...releases].sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  for (const r of newest) {
    const names = gameFiles(r).map((a) => a.name.replace(/[-_.]/g, ' '));
    const found = PLATFORMS.filter(([, re]) => names.some((n) => re.test(n))).map(([p]) => p);
    if (found.length) return found.join(' · ');
  }
  return null;
}

// Platforms from the repository topics (the tags on the repo page), e.g. "windows", "browser-game".
const TOPIC_PLATFORMS = [['Windows', /^windows/], ['Browser', /^(browser|web|webgl|html5)/], ['Linux', /^linux/], ['macOS', /^(macos|mac|osx)$/], ['Android', /^android/]];
const topicPlatforms = (topics = []) => {
  const found = TOPIC_PLATFORMS.filter(([, re]) => topics.some((t) => re.test(t))).map(([p]) => p);
  return found.length ? found.join(' · ') : null;
};

// Number of commits on the default branch, read from the "last page" link.
async function commitCount(repo, branch) {
  const res = await fetch(`https://api.github.com/repos/${USER}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`, { headers });
  if (res.status === 409 || res.status === 404) return 0; // empty repository
  if (!res.ok) throw new Error(`GitHub API commits ${repo}: ${res.status}`);
  const last = /[?&]page=(\d+)>; rel="last"/.exec(res.headers.get('link') || '');
  return last ? Number(last[1]) : (await res.json()).length;
}

// Renders a badge through shields.io's static endpoint (no GitHub API involved)
// and stores it in the repository, so the profile never depends on shields.io
// being reachable when someone opens it. If shields.io fails, the old file stays.
const used = new Set();
let badgeFailures = 0;
async function badge(name, label, message, color, style = 'flat-square') {
  const params = new URLSearchParams({ label, message, color, labelColor: COLOR.label, style });
  const file = `${BADGES}/${name}.svg`;
  used.add(`${name}.svg`);
  try {
    const res = await fetch(`https://img.shields.io/static/v1?${params}`);
    const svg = await res.text();
    if (!res.ok || !svg.startsWith('<svg')) throw new Error(`status ${res.status}`);
    const old = await readFile(file, 'utf8').catch(() => null);
    if (old !== svg) await writeFile(file, svg);
  } catch (err) {
    badgeFailures++;
    console.warn(`badge ${name} not updated: ${err.message}`);
  }
  return `<img src="${file}" alt="${label}: ${message}">`;
}

const fmt = (n) => n.toLocaleString('en-US');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function ago(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function replaceSection(text, name, html) {
  const start = `<!-- ${name}:start -->`, end = `<!-- ${name}:end -->`;
  const from = text.indexOf(start), to = text.indexOf(end);
  if (from < 0 || to < 0) throw new Error(`README is missing the ${start} / ${end} markers`);
  return text.slice(0, from) + `${start}\n${html}\n${end}` + text.slice(to + end.length);
}

// ---------- totals over all public repositories ----------
async function stats() {
  const user = await api(`/users/${USER}`);
  const repos = (await pages(`/users/${USER}/repos?type=owner`)).filter((r) => !r.fork && !r.private && r.name !== USER);
  let stars = 0, downloads = 0, releases = 0, commits = 0, releasesThisMonth = 0;
  const now = new Date();
  for (const r of repos) {
    stars += r.stargazers_count;
    const rel = await releasesOf(r.name);
    releases += rel.length;
    downloads += downloadsOf(rel);
    commits += await commitCount(r.name, r.default_branch);
    for (const x of rel) {
      const t = new Date(x.published_at || x.created_at);
      if (t.getUTCFullYear() === now.getUTCFullYear() && t.getUTCMonth() === now.getUTCMonth()) releasesThisMonth++;
    }
  }
  const lastPush = repos.reduce((t, r) => Math.max(t, new Date(r.pushed_at).getTime()), 0);
  const lastActive = lastPush ? ago(new Date(lastPush).toISOString()) : 'not yet';
  const onGithub = since(user.created_at);
  console.log({ location: user.location, projects: repos.length, releases, commits, lastActive, followers: user.followers, stars, downloads, releasesThisMonth, onGithub });
  const grid = await badgeGrid('stats-grid', [
    [ // red, blue, red, blue
      user.location ? ['from', 'from', user.location] : ['since', 'on github since', String(new Date(user.created_at).getFullYear())],
      ['followers', 'followers', fmt(user.followers)],
      ['stars', 'stars', fmt(stars)],
      ['last-active', 'last active', lastActive],
    ],
    [ // blue, red, blue, red
      ['projects', 'projects', fmt(repos.length)],
      ['releases', 'releases', fmt(releases)],
      ['commits', 'commits', fmt(commits)],
      ['downloads', 'downloads', fmt(downloads)],
    ],
  ], [
    [ // free row below the chessboard, fixed colours: red left, blue right
      ['releases-this-month', 'releases this month', fmt(releasesThisMonth), COLOR.red],
      ['on-github-for', 'on github for', onGithub, COLOR.blue],
    ],
  ]);
  return `<a href="https://github.com/${USER}?tab=repositories"><img src="${grid.file}" alt="${esc(grid.alt)}"></a>`;
}

// "19 days", "5 months", "2 years"
function since(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 60) return `${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 730) return `${Math.floor(days / 30)} months`;
  return `${Math.floor(days / 365)} years`;
}

// Puts the badges into one image, coloured like a chessboard (jacket red / hair blue).
// `gridRows` share fixed columns, so no two badges of the same colour touch, neither
// side by side nor above each other; shorter rows are centred on the grid
// (5 / 3 -> the short row takes the middle three columns). `freeRows` follow below
// with a little more space, each centred on its own, still alternating red and blue.
async function badgeGrid(name, gridRows, freeRows = []) {
  const GAP = 8, ROW_GAP = 8, FREE_GAP = 16;
  const rows = [...gridRows, ...freeRows];
  const cols = Math.max(...gridRows.map((row) => row.length));
  const cells = [];
  for (let r = 0; r < rows.length; r++) {
    const offset = Math.floor((cols - rows[r].length) / 2);
    for (let i = 0; i < rows[r].length; i++) {
      const c = offset + i;
      const [file, label, value, fixedColor] = rows[r][i];
      await badge(file, label, value, fixedColor || ((r + c) % 2 === 0 ? COLOR.red : COLOR.blue), 'for-the-badge');
      const svg = await readFile(`${BADGES}/${file}.svg`, 'utf8');
      const size = (attr) => parseFloat(new RegExp(`^<svg[^>]*?\\s${attr}="([\\d.]+)"`).exec(svg)[1]);
      cells.push({ r, i, c, free: r >= gridRows.length, svg, w: size('width'), h: size('height'), alt: `${label}: ${value}` });
    }
  }
  const sum = (a, n = a.length) => a.slice(0, n).reduce((s, v) => s + v, 0);
  const grid = cells.filter((k) => !k.free);
  const colW = [...Array(cols)].map((_, c) => Math.max(0, ...grid.filter((x) => x.c === c).map((x) => x.w)));
  const gridW = sum(colW) + GAP * (cols - 1);
  const freeW = freeRows.map((_, f) => { const ks = cells.filter((k) => k.r === gridRows.length + f); return sum(ks.map((k) => k.w)) + GAP * (ks.length - 1); });
  const W = Math.max(gridW, ...freeW);
  const rowH = rows.map((_, r) => Math.max(...cells.filter((x) => x.r === r).map((x) => x.h)));
  const rowY = rows.map((_, r) => sum(rowH, r) + ROW_GAP * r + (r >= gridRows.length ? FREE_GAP - ROW_GAP : 0));
  const H = rowY[rows.length - 1] + rowH[rows.length - 1];
  let body = '';
  for (const k of cells) {
    let x;
    if (!k.free) x = (W - gridW) / 2 + sum(colW, k.c) + GAP * k.c + (colW[k.c] - k.w) / 2;
    else {
      const f = k.r - gridRows.length, before = cells.filter((o) => o.r === k.r && o.i < k.i);
      x = (W - freeW[f]) / 2 + sum(before.map((o) => o.w)) + GAP * before.length;
    }
    const y = rowY[k.r] + (rowH[k.r] - k.h) / 2;
    body += k.svg.replace(/^<svg[^>]*>/, `<svg x="${x}" y="${y}" width="${k.w}" height="${k.h}">`);
  }
  const alt = cells.map((k) => k.alt).join(', ');
  const file = `${BADGES}/${name}.svg`;
  used.add(`${name}.svg`);
  const old = await readFile(file, 'utf8').catch(() => null);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(alt)}">${body}</svg>\n`;
  if (old !== svg) await writeFile(file, svg);
  return { file, alt };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- game cards ----------
async function card(game) {
  const id = slug(game.title);
  const repo = await api(`/repos/${USER}/${game.repo}`);
  const isPublic = Boolean(repo && !repo.private);
  const url = `https://github.com/${USER}/${game.repo}`;
  const img = `<img src="assets/projects/${game.image}" alt="${game.title}">`;
  const lines = [];
  let runsOn = game.runsOn;

  if (isPublic) {
    const releases = await releasesOf(game.repo);
    // newest published release, pre-releases included (GitHub's "latest" skips those)
    const latest = [...releases].sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0] || null;
    // 1. file names of the release downloads, 2. repository topics, 3. the value above
    runsOn = platformsOf(releases) || topicPlatforms(repo.topics) || game.runsOn;
    lines.push(`<a href="${url}">${img}</a>`, `<h3><a href="${url}">${game.title}</a></h3>`);
    if (latest) lines.push(await badge(`${id}-version`, 'version', latest.tag_name, COLOR.red));
    if (hasGameFiles(releases)) lines.push(await badge(`${id}-downloads`, 'downloads', fmt(downloadsOf(releases)), COLOR.blue));
    lines.push(await badge(`${id}-updated`, 'updated', ago(repo.pushed_at), COLOR.gray));
    console.log(`${game.title}: public, ${latest ? latest.tag_name : 'no release'}, ${hasGameFiles(releases) ? downloadsOf(releases) : 'no game files'} downloads, updated ${ago(repo.pushed_at)}, runs on ${runsOn}`);
  } else {
    lines.push(img, `<h3>${game.title}</h3>`);
    lines.push(await badge(`${id}-status`, 'status', 'coming soon', COLOR.gray));
    console.log(`${game.title}: not public yet`);
  }
  lines.push(await badge(`${id}-runs-on`, 'runs on', runsOn, COLOR.gray));
  return `<td width="${Math.floor(100 / GAMES.length)}%" valign="top">\n${lines.join('\n')}\n</td>`;
}

try {
  await mkdir(BADGES, { recursive: true });
  let readme = await readFile(README, 'utf8');
  readme = replaceSection(readme, 'stats', await stats());
  const cells = [];
  for (const game of GAMES) cells.push(await card(game));
  readme = replaceSection(readme, 'games', `<table>\n<tr>\n${cells.join('\n')}\n</tr>\n</table>`);
  await writeFile(README, readme);
  // remove badges that are no longer shown (e.g. "coming soon" once a game is public)
  for (const f of await readdir(BADGES)) if (f.endsWith('.svg') && !used.has(f)) await unlink(`${BADGES}/${f}`);
  // diamond contribution calendar and the ornament below it (kept as they are if this fails)
  try {
    const kanji = (await readFile('.github/scripts/rei-kanji.png')).toString('base64');   // 零 behind the calendar
    const calendar = diamondCalendarSvg(await contributions(USER, token), { red: `#${COLOR.red}`, blue: `#${COLOR.blue}`, kanji });
    for (const [file, svg] of [['assets/calendar.svg', calendar], ['assets/ornament.svg', ornamentSvg(calendar)]]) {
      const old = await readFile(file, 'utf8').catch(() => null);
      if (old !== svg) await writeFile(file, svg);
    }
  } catch (err) {
    badgeFailures++;
    console.warn(`calendar not updated: ${err.message}`);
  }
  if (badgeFailures) {
    console.warn(`::warning::${badgeFailures} badge(s) could not be refreshed this time.`);
    process.exitCode = 1;
  }
} catch (err) {
  // A GitHub API hiccup only skips this run (the next one is 15 minutes later);
  // the README is written last, so nothing half-finished is committed.
  // The exit code only tells the workflow's health check that this run did not
  // update; the workflow itself does not fail (no e-mail).
  console.warn(`::warning::Profile not updated this time: ${err.message}`);
  process.exitCode = 1;
}
