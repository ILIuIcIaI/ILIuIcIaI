// Contribution data for the diamond calendar (see diamondCalendarSvg below).
// Data: GitHub GraphQL API; if that is not available, the public calendar page.

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function fromGraphQL(user, token) {
  if (!token) throw new Error('no token');
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date weekday contributionCount contributionLevel}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': `${user}-profile` },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  const json = await res.json().catch(() => null);
  const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!res.ok || !cal) throw new Error(`GraphQL ${res.status}`);
  return {
    total: cal.totalContributions,
    days: cal.weeks.flatMap((w, wi) => w.contributionDays.map((d) => ({ week: wi, weekday: d.weekday, date: d.date, count: d.contributionCount, level: LEVELS[d.contributionLevel] ?? 0 }))),
  };
}

async function fromCalendarPage(user) {
  const res = await fetch(`https://github.com/users/${user}/contributions`, { headers: { 'user-agent': `${user}-profile` } });
  if (!res.ok) throw new Error(`calendar page ${res.status}`);
  const html = await res.text();
  const tips = new Map([...html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)].map((m) => [m[1], m[2]]));
  const cells = [...html.matchAll(/<td[^>]*data-date="(\d{4}-\d\d-\d\d)"[^>]*>/g)].map((m) => {
    const tag = m[0];
    const id = /id="([^"]+)"/.exec(tag)?.[1];
    const level = +(/data-level="(\d)"/.exec(tag)?.[1] ?? 0);
    const count = +(/^(\d+)/.exec(tips.get(id) || '')?.[1] ?? 0);
    return { date: m[1], level, count };
  });
  if (!cells.length) throw new Error('calendar page has no days');
  cells.sort((a, b) => a.date.localeCompare(b.date));
  const first = new Date(`${cells[0].date}T00:00:00Z`);
  const startSunday = new Date(first.getTime() - first.getUTCDay() * 86400000);
  const days = cells.map((c) => {
    const t = new Date(`${c.date}T00:00:00Z`);
    return { ...c, weekday: t.getUTCDay(), week: Math.floor((t - startSunday) / (7 * 86400000)) };
  });
  return { total: days.reduce((s, d) => s + d.count, 0), days };
}

export async function contributions(user, token) {
  try { return await fromGraphQL(user, token); } catch (err) {
    console.warn(`skyline: GraphQL not available (${err.message}), reading the public calendar instead`);
    return fromCalendarPage(user);
  }
}

// Contribution calendar drawn with the diamonds of the banner ornament:
// one diamond per day, weeks left to right, Sunday on top.
// Pale for days without contributions, hair blue for active days, jacket red for the busiest.
// `kanji`: optional PNG (base64) drawn large and pale behind the diamonds (零, "Rei" as the number zero).
export function diamondCalendarSvg({ days }, { red, blue, kanji = null }) {
  // pitch, diamond half sizes, margins; the wide side margins leave room for the
  // end diamonds of the ornament, which sit just outside the calendar (same image width)
  const P = 15.2, A = P * 0.47, B = P * 0.47, M = 8, MX = 21;
  const weeks = Math.max(...days.map((d) => d.week)) + 1;
  const fill = (lvl) => [null, "#4f6f86", "#78a8c8", blue, red][lvl];
  const W = Math.ceil(weeks * P + 2 * MX), H = Math.ceil(7 * P + 2 * M);
  const shapes = days.map((d) => {
    const cx = MX + d.week * P + P / 2, cy = M + d.weekday * P + P / 2;
    const pts = [[cx - A, cy], [cx, cy - B], [cx + A, cy], [cx, cy + B]].map(([x, y]) => x.toFixed(1) + "," + y.toFixed(1)).join(" ");
    return d.level ? `<polygon points="${pts}" fill="${fill(d.level)}"/>`
                   : `<polygon points="${pts}" fill="#8b949e" fill-opacity="0.2"/>`;
  }).join('\n');
  // the kanji image is 360 x 330 px; it is drawn 1.25 times as tall as the calendar, centred
  const kh = H * 1.25, kw = kh * 360 / 330, r2 = (v) => +v.toFixed(2);
  const backdrop = kanji
    ? `<image href="data:image/png;base64,${kanji}" x="${r2(W / 2 - kw / 2)}" y="${r2(H / 2 - kh / 2 - 4)}" width="${r2(kw)}" height="${r2(kh)}" opacity="0.22"/>\n`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="contribution calendar">
${backdrop}${shapes}
</svg>
`;
}

// The closing ornament below the calendar: the diamonds of the banner line
// (same sizes and colour as the banner shows them on GitHub). The line spans the
// calendar exactly: the inner tips of the end diamonds touch the outer edge of the
// first and last calendar column, the end diamonds themselves sit just outside.
export function ornamentSvg(calendarSvg, color = '#872c2a') {
  const W = +/width="(\d+)"/.exec(calendarSvg)[1];
  const xs = [...calendarSvg.matchAll(/points="([^"]+)"/g)].flatMap((m) => m[1].split(' ').map((p) => +p.split(',')[0]));
  const L = Math.min(...xs), R = Math.max(...xs);
  const s = 425 / 256;                       // banner pixels -> pixels on the profile
  const A = 6 * s, B = 4 * s, a = 4.5 * s, b = 3 * s, t = 1.5 * s, gap = 7.5 * s, H = 17, cy = H / 2;
  const cl = L - A, cr = R + A, cx = (L + R) / 2, f = (v) => +v.toFixed(2);
  const d = (x, w, h) => `<polygon points="${f(x - w)},${f(cy)} ${f(x)},${f(cy - h)} ${f(x + w)},${f(cy)} ${f(x)},${f(cy + h)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="ornament">
<!-- same diamonds and colour as the line under the name in the banner, as wide as the calendar above -->
<g fill="${color}" shape-rendering="geometricPrecision">
${d(cl, A, B)}
${d(cr, A, B)}
${d(cx, a, b)}
<rect x="${f(cl)}" y="${f(cy - t / 2)}" width="${f(cx - gap - cl)}" height="${f(t)}"/>
<rect x="${f(cx + gap)}" y="${f(cy - t / 2)}" width="${f(cr - cx - gap)}" height="${f(t)}"/>
</g>
</svg>
`;
}
