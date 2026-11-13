// End-to-end check of the real UI in a real browser (your installed Chrome, via playwright-core).
// Usage: node scripts/e2e.js <base url> [screenshot folder]. The database needs seed data (npm run seed).
//   node scripts/e2e.js http://localhost:4000
// It signs up real users, creates a team, fills it to one free seat, then has two browsers click
// "Join instantly" at the same moment. It asserts what each person sees and saves screenshots.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const base = process.argv[2];
if (!base) throw new Error('usage: node scripts/e2e.js <base url of a running app>');
const shots = process.argv[3] ?? 'docs/screenshots';
mkdirSync(shots, { recursive: true });

const run = randomBytes(4).toString('hex');
const password = randomBytes(12).toString('base64url');
const account = (name) => ({ email: `e2e-${name}-${run}@example.com`, password, displayName: `E2E ${name}`, skills: ['backend', 'ml'], timezone: 'UTC' });
const results = {};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const desktop = { viewport: { width: 1440, height: 900 } };
const phone = devices['Pixel 7'];

/** A browser context whose user was created through the API (the cookie lands in the context). */
async function signedIn(name, options) {
  const context = await browser.newContext(options);
  const res = await context.request.post(`${base}/api/auth/signup`, { data: account(name) });
  assert.equal(res.status(), 201, `signup ${name}`);
  return context;
}

try {
  // ---------- landing: first paint, the 3D sky, scroll choreography ----------
  const visitor = await browser.newContext(desktop);
  const landing = await visitor.newPage();
  const errors = [];
  landing.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await landing.goto(base);
  await landing.getByRole('heading', { level: 1 }).waitFor();
  // The form of the page that matters is usable before the 3D chunk arrives.
  results.ctaVisibleBeforeSky = await landing.getByRole('link', { name: 'Join the hackathon' }).isVisible();
  // The 3D layer has not been requested yet: it starts on the first interaction.
  assert.equal(await landing.locator('.sky canvas.visible').count(), 0);
  await landing.mouse.move(300, 300);
  await landing.locator('.sky canvas.visible').waitFor({ timeout: 15_000 });
  await landing.waitForTimeout(1200);
  await landing.screenshot({ path: `${shots}/landing-desktop.png` });

  results.landingFps = await landing.evaluate(
    () => new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => (++frames, performance.now() - start < 3000 ? requestAnimationFrame(tick) : resolve(Math.round(frames / 3)));
      requestAnimationFrame(tick);
    }),
  );

  // Keyboard: the first Tab stop is the skip link, and it moves focus to the main content.
  await landing.keyboard.press('Tab');
  assert.equal(await landing.evaluate(() => document.activeElement.textContent), 'Skip to content');
  await landing.keyboard.press('Enter');
  assert.equal(await landing.evaluate(() => document.activeElement.id), 'main');

  // Scroll choreography: story sections are tied to scroll position.
  const lastBeat = landing.locator('.beat-body').last();
  const opacity = () => lastBeat.evaluate((el) => Number(getComputedStyle(el).opacity));
  assert.ok((await opacity()) < 0.1, 'story sections start hidden');

  // The pinned scene: scrolling through it fills the seats one at a time and ends on the last seat.
  const scrollScene = (fraction) =>
    landing.locator('.scene').evaluate((el, f) => {
      const top = el.getBoundingClientRect().top + scrollY;
      scrollTo(0, top + f * (el.offsetHeight - innerHeight));
    }, fraction);
  const seatsOn = () => landing.locator('.big-seat.on').count();
  await scrollScene(0.02);
  await landing.waitForTimeout(700);
  assert.equal(await seatsOn(), 1, 'scene starts with one seat taken');
  await scrollScene(0.6);
  await landing.waitForTimeout(900);
  assert.equal(await seatsOn(), 3, 'scrolling fills seats');
  await landing.getByRole('heading', { name: 'One seat left. Fifty people are looking at it.' }).waitFor();
  await landing.screenshot({ path: `${shots}/landing-scene-desktop.png` });
  await scrollScene(1);
  await landing.waitForTimeout(700);
  assert.equal(await seatsOn(), 4, 'scene ends with every seat taken');
  await landing.getByRole('heading', { name: 'Taken. Exactly once.' }).waitFor();

  await lastBeat.scrollIntoViewIfNeeded();
  await landing.waitForTimeout(1500);
  assert.ok((await opacity()) > 0.95, 'story sections are fully shown once scrolled to');
  await landing.screenshot({ path: `${shots}/landing-gathered-desktop.png` });

  // ---------- every colour palette, on the landing page and the board ----------
  for (const theme of ['aurora', 'midnight', 'nebula', 'ember']) {
    await landing.evaluate((t) => localStorage.setItem('theme', t), theme);
    await landing.goto(base);
    await landing.getByRole('heading', { level: 1 }).waitFor();
    await landing.mouse.move(320, 320);
    await landing.mouse.move(340, 300);
    await landing.locator('.sky canvas.visible').waitFor({ timeout: 15_000 });
    await landing.waitForTimeout(1200);
    assert.equal(await landing.evaluate(() => document.documentElement.dataset.theme), theme);
    await landing.screenshot({ path: `${shots}/theme-${theme}-landing.png` });
    await landing.goto(`${base}/board`);
    await landing.locator('.team-list li').first().waitFor();
    await landing.waitForTimeout(900);
    await landing.screenshot({ path: `${shots}/theme-${theme}-board.png` });
  }
  await landing.evaluate(() => localStorage.removeItem('theme'));

  // ---------- reduced motion: no WebGL layer, content simply there ----------
  const calm = await browser.newContext({ ...desktop, reducedMotion: 'reduce' });
  const calmPage = await calm.newPage();
  await calmPage.goto(base);
  await calmPage.waitForTimeout(1500);
  assert.equal(await calmPage.evaluate(() => document.documentElement.dataset.motion), 'reduced');
  assert.equal(await calmPage.locator('.sky canvas.visible').count(), 0, 'no 3D layer with reduced motion');
  assert.equal(await calmPage.locator('.beat-body').last().evaluate((el) => getComputedStyle(el).opacity), '1', 'nothing is hidden under reduced motion');
  assert.equal(await calmPage.locator('.scroll-progress').count(), 0);
  assert.equal(await calmPage.locator('.big-seat.on').count(), 4, 'the scene shows its final state without scrolling');
  await calmPage.screenshot({ path: `${shots}/landing-reduced-motion.png` });
  await calm.close();

  // ---------- sign up and create a team through the UI ----------
  const leaderContext = await browser.newContext(desktop);
  const leader = await leaderContext.newPage();
  await leader.goto(`${base}/signup`);
  await leader.getByLabel('Display name').fill('E2E Leader');
  await leader.getByLabel('Email').fill(account('leader').email);
  await leader.getByLabel('Password').fill(password);
  await leader.getByText('backend', { exact: true }).click();
  await leader.getByText('design', { exact: true }).click();
  await leader.getByRole('button', { name: 'Create account' }).click();
  await leader.waitForURL('**/board');
  await leader.locator('.team-list li').first().waitFor();
  await leader.screenshot({ path: `${shots}/board-desktop.png` });

  await leader.getByRole('button', { name: 'Create a team' }).click();
  const teamName = `E2E Constellation ${run}`;
  await leader.getByLabel('Team name').fill(teamName);
  await leader.locator('dialog').getByText('ml', { exact: true }).click();
  await leader.getByRole('button', { name: 'Create team', exact: true }).click();
  await leader.waitForURL('**/teams/*');
  const code = await leader.locator('.code').textContent();
  assert.match(code, /^[0-9A-F]{4}(-[0-9A-F]{4})+$/);

  // ---------- two members join elsewhere; the leader's page updates by itself ----------
  for (const name of ['second', 'third']) {
    const context = await signedIn(name, desktop);
    const res = await context.request.post(`${base}/api/invites/redeem`, { data: { code } });
    assert.equal(res.status(), 200, `${name} joins`);
    await context.close();
  }
  await leader.locator('.page-head .seats', { hasText: '3/4' }).waitFor({ timeout: 10_000 });
  await leader.getByText('Last seat').first().waitFor();
  results.liveUpdateWithoutReload = true;

  // ---------- the race, in the UI: two people, one seat, clicked together ----------
  const racers = await Promise.all([signedIn('racer-a', desktop), signedIn('racer-b', phone)]);
  const pages = await Promise.all(racers.map((c) => c.newPage()));
  for (const page of pages) {
    await page.goto(`${base}/board`);
    await page.getByLabel('Have an invite code?').fill(code);
  }
  await Promise.all(pages.map((page) => page.getByRole('button', { name: 'Join instantly' }).click()));
  const outcomes = await Promise.all(
    pages.map((page) =>
      Promise.race([
        page.waitForURL('**/teams/*').then(() => 'joined'),
        page.locator('#lost-title').waitFor().then(() => 'lost'),
      ]),
    ),
  );
  assert.deepEqual([...outcomes].sort(), ['joined', 'lost'], `race outcomes were ${outcomes}`);
  results.raceOutcomes = outcomes;

  const loser = pages[outcomes.indexOf('lost')];
  const winner = pages[outcomes.indexOf('joined')];
  // The loser is told plainly, focus is on the message, and nothing claims they joined.
  assert.equal(await loser.evaluate(() => document.activeElement.id), 'lost-title');
  assert.equal(await loser.getByRole('link', { name: 'My team' }).count(), 0);
  await loser.waitForTimeout(800);
  await loser.screenshot({ path: `${shots}/lost-the-race.png` });

  await winner.getByRole('heading', { name: teamName }).waitFor();
  await leader.locator('.page-head .seats', { hasText: '4/4' }).waitFor({ timeout: 10_000 });
  assert.equal(await leader.locator('.members li strong').count(), 4, 'leader sees four members');
  await leader.waitForTimeout(900);
  await leader.screenshot({ path: `${shots}/team-desktop.png`, fullPage: true });

  // ---------- phone widths ----------
  const pocket = await signedIn('phone', phone);
  const mobile = await pocket.newPage();
  await mobile.goto(`${base}/board`);
  await mobile.locator('.team-list li').first().waitFor();
  await mobile.waitForTimeout(900);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll on a phone');
  await mobile.screenshot({ path: `${shots}/board-mobile.png` });
  await mobile.goto(base);
  await mobile.mouse.move(100, 200);
  await mobile.waitForTimeout(2500);
  await mobile.screenshot({ path: `${shots}/landing-mobile.png` });

  results.consoleErrorsOnLanding = errors;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
} finally {
  await browser.close();
}
