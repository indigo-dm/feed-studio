const fs = require('fs');
const os = require('os');
const path = require('path');
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('C:/Users/vdovi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
}
const { chromium } = playwright;

const frontend = __dirname;
const dataRoot = path.resolve(__dirname, '..', 'novyy-gorizont', 'feed-generator', 'fast-site');
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ttf': 'font/truetype', '.xml': 'application/xml; charset=utf-8'
};

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  let submitted = null;
  const accessConfig = fs.readFileSync(path.join(frontend, 'access-config.js'), 'utf8');
  const hash = accessConfig.match(/[0-9a-f]{64}/i)[0].toLowerCase();
  await page.addInitScript(({ key }) => {
    sessionStorage.setItem(key, 'granted');
    sessionStorage.setItem(key + ':upload-credential', 'qa-password');
  }, { key: 'feed-studio-access:' + hash.slice(0, 16) });

  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
    const target = path.resolve(frontend, relative);
    if (!target.startsWith(path.resolve(frontend)) || !fs.existsSync(target)) return route.fulfill({ status: 404, body: 'Not found' });
    await route.fulfill({ status: 200, contentType: contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', body: fs.readFileSync(target) });
  });
  await page.route('https://indigo-feed-studio-upload.indigo-dm-tech.workers.dev/**', async (route) => {
    const url = new URL(route.request().url());
    const cors = { 'Access-Control-Allow-Origin': 'http://localhost', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname.startsWith('/data/')) {
      const relative = url.pathname.replace(/^\/data\//, '');
      const target = path.resolve(dataRoot, relative);
      if (!target.startsWith(dataRoot) || !fs.existsSync(target)) return route.fulfill({ status: 404, body: 'Not found' });
      if (target.endsWith('assets.json')) {
        const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
        payload.upload_service_url = 'https://indigo-feed-studio-upload.indigo-dm-tech.workers.dev';
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(payload) });
      }
      return route.fulfill({ status: 200, contentType: contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', headers: cors, body: fs.readFileSync(target) });
    }
    if (url.pathname === '/materials' && route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ items: [{
        id: 'mat-qa-library', name: 'Рендер из библиотеки', filename: 'uploads/mat-qa-library.webp',
        url: 'https://assets.example.test/mat-qa-library.webp', uploaded: true, active_for: []
      }] }) });
    }
    if (url.pathname === '/materials/upload' && route.request().method() === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', headers: cors, body: JSON.stringify({
        id: 'mat-qa-new', name: 'Новый материал', filename: 'uploads/mat-qa-new.png',
        url: 'https://assets.example.test/mat-qa-new.png', uploaded: true, active_for: []
      }) });
    }
    if (url.pathname === '/settings' && route.request().method() === 'POST') {
      submitted = JSON.parse(route.request().postData());
      return route.fulfill({ status: 202, contentType: 'application/json', headers: cors, body: JSON.stringify({ request: 77, status: 'queued' }) });
    }
    if (url.pathname === '/status') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ request: 77, status: 'building' }) });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.route('https://assets.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMDAxAADAAwBAQDJxQ8AAAAASUVORK5CYII=', 'base64') }));
  await page.route('https://indigo-dm.github.io/novyy-gorizont-feed/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMDAxAADAAwBAQDJxQ8AAAAASUVORK5CYII=', 'base64') }));

  await page.goto('http://localhost/#assets', { waitUntil: 'networkidle' });
  const publicFeedHref = await page.locator('#full-feed-link').getAttribute('href');
  const initialCards = await page.locator('.asset-card').count();
  const activeBefore = await page.locator('.asset-status.active').count();
  if (!(await page.locator('[data-material-file="uploads/mat-qa-library.webp"]').count())) {
    console.error(JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 2000) }, null, 2));
  }
  await page.locator('[data-use-material="key_render"][data-material-file="uploads/mat-qa-library.webp"]').click();
  const selectedLibrary = await page.locator('.asset-status.active').allTextContents();
  await page.locator('#material-file-input').setInputFiles({
    name: 'Новый логотип.jpg',
    mimeType: 'image/jpeg',
    buffer: fs.readFileSync(path.resolve(__dirname, '..', 'novyy-gorizont', 'feed-generator', 'projects', 'novyy-gorizont', 'assets', 'selected-render.jpg'))
  });
  await page.waitForTimeout(1200);
  if (!(await page.locator('#material-upload-status').innerText()).includes('Материал загружен')) {
    console.error(JSON.stringify({ errors, upload_status: await page.locator('#material-upload-status').innerText() }, null, 2));
  }
  await page.waitForFunction(() => document.querySelector('#material-upload-status')?.textContent.includes('Материал загружен'));
  const cardsAfterUpload = await page.locator('.asset-card').count();
  await page.locator('[data-use-material="logo"][data-material-file="uploads/mat-qa-new.png"]').click();
  await page.screenshot({ path: path.join(os.tmpdir(), 'feed-studio-materials-qa.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const mobileMaterialActions = await page.locator('.asset-actions .button').count();
  await page.locator('[data-view="lots"]').click();
  const excludedLotId = await page.locator('[data-toggle-feed-lot]').first().getAttribute('data-toggle-feed-lot');
  await page.locator('[data-toggle-feed-lot]').first().click();
  const excludedCardMarked = await page.locator('.lot-card.excluded').count();
  await page.locator('#publish-settings').click();
  await page.locator('#confirm-publish').click();
  await page.waitForFunction(() => window.localStorage.getItem('feed-studio-publish-v1-novyy-gorizont'));

  const result = {
    ok: errors.length === 0 && publicFeedHref === 'https://indigo-dm.github.io/feed-studio/feeds/novyy-gorizont/avito.xml' && initialCards >= 3 && activeBefore === 2 && selectedLibrary.some((text) => text.includes('Ключевой рендер')) && cardsAfterUpload === initialCards + 1 && mobileOverflow <= 1 && mobileMaterialActions > 0 && excludedCardMarked === 1 && submitted && submitted.version === 3 && submitted.excluded_lot_ids.includes(excludedLotId) && submitted.material_settings.logo === 'uploads/mat-qa-new.png' && submitted.material_settings.key_render === 'uploads/mat-qa-library.webp',
    errors,
    public_feed_href: publicFeedHref,
    initial_cards: initialCards,
    active_before: activeBefore,
    cards_after_upload: cardsAfterUpload,
    mobile_overflow_px: mobileOverflow,
    mobile_material_actions: mobileMaterialActions,
    excluded_lot_id: excludedLotId,
    excluded_card_marked: excludedCardMarked,
    submitted_materials: submitted && submitted.material_settings
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.ok) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
