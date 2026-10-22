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
const dataRoot = process.env.FEED_STUDIO_QA_DATA_ROOT
  ? path.resolve(process.env.FEED_STUDIO_QA_DATA_ROOT)
  : path.resolve(__dirname, '..', 'novyy-gorizont', 'feed-generator', 'fast-site');
const qaInventory = JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', 'novyy-gorizont', 'inventory.json'), 'utf8'));
const qaPublishedSettings = JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects', 'novyy-gorizont', 'settings.json'), 'utf8'));
const qaLot = qaInventory.items[0];
const qaSecondLot = qaInventory.items[1];
qaInventory.items.forEach((item, index) => {
  item.source_values ||= {};
  item.source_values.ApartmentNumber = String(100001 + index);
});
qaInventory.source_tag_counts ||= {};
qaInventory.source_tag_counts.ApartmentNumber = qaInventory.items.length;
qaPublishedSettings.image_settings ||= { lot_overrides: {}, bulk_rules: [] };
qaPublishedSettings.parameter_settings ||= { lot_values: {}, bulk_rules: [] };
qaPublishedSettings.parameter_settings.bulk_rules ||= [];
qaPublishedSettings.parameter_settings.bulk_rules.push({
  id: 'qa-stale-parameter-rule', name: 'Устаревшее правило', enabled: true,
  values: { CeilingHeight: '2.85' }, house_ids: [], rooms: [], floors: [],
  plan_ids: ['plan-000000000000'], area_min: null, area_max: null, include_ids: [], exclude_ids: []
});
if (qaLot && !Object.keys(qaPublishedSettings.image_settings.lot_overrides || {}).length) {
  qaPublishedSettings.image_settings.lot_overrides = {
    [String(qaLot.id)]: { order: (qaLot.feed_images || []).map((image) => image.id), hidden: [], added: [] }
  };
}
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
  let sourceFeedSaved = null;
  let deletedMaterial = null;
  let deletedLibrary = null;
  let bulkImageUploads = 0;
  const projectDataRequests = {};
  const accessConfig = fs.readFileSync(path.join(frontend, 'access-config.js'), 'utf8');
  const hash = accessConfig.match(/[0-9a-f]{64}/i)[0].toLowerCase();
  await page.addInitScript(({ key, publishedSettings }) => {
    sessionStorage.setItem(key, 'granted');
    sessionStorage.setItem(key + ':upload-credential', 'qa-password');
    localStorage.setItem('feed-studio-rules-v1-novyy-gorizont', JSON.stringify({
      version: 4,
      rules: publishedSettings.rules || [],
      image_settings: publishedSettings.image_settings || { lot_overrides: {}, bulk_rules: [] },
      parameter_settings: publishedSettings.parameter_settings || { lot_values: {}, bulk_rules: [] },
      material_settings: publishedSettings.material_settings || { logo: '', key_render: '', background_render: '', primary_color: '', background_color: '', text_color: '', subtitle_color: '', promotion_frame_color: '', promotion_text_color: '', palette: [] },
      card_settings: publishedSettings.card_settings || { show_key_render: true, show_house_badge: true, show_decoration: true, show_logo_panel: false },
      excluded_lot_ids: publishedSettings.excluded_lot_ids || [],
      pending_upload_deletions: []
    }));
    localStorage.setItem('feed-studio-profitbase-refresh-v1-novyy-gorizont', JSON.stringify({
      request: 'refresh-stale-qa', status: 'published', completedAt: '2026-09-27T21:37:00+03:00'
    }));
  }, { key: 'feed-studio-access:' + hash.slice(0, 16), publishedSettings: qaPublishedSettings });

  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
    const target = path.resolve(frontend, relative);
    if (!target.startsWith(path.resolve(frontend)) || !fs.existsSync(target)) return route.fulfill({ status: 404, body: 'Not found' });
    await route.fulfill({ status: 200, contentType: contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', body: fs.readFileSync(target) });
  });
  await page.route('https://feed-api.indigo-dm.ru/**', async (route) => {
    const url = new URL(route.request().url());
    const cors = { 'Access-Control-Allow-Origin': 'http://localhost', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname.startsWith('/media/')) {
      return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMDAxAADAAwBAQDJxQ8AAAAASUVORK5CYII=', 'base64') });
    }
    if (url.pathname.startsWith('/data/')) {
      const relative = url.pathname.replace(/^\/data\//, '');
      const projectDataMatch = relative.match(/^projects\/([^/]+)\/(inventory|settings|status|assets)\.json$/);
      if (projectDataMatch) projectDataRequests[projectDataMatch[1]] = (projectDataRequests[projectDataMatch[1]] || 0) + 1;
      const target = path.resolve(dataRoot, relative);
      if (!target.startsWith(dataRoot) || !fs.existsSync(target)) return route.fulfill({ status: 404, body: 'Not found' });
      if (relative === 'projects.json') {
        const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
        payload.projects.forEach((project) => {
          if (project.slug !== payload.default_project && project.status === 'active') project.available = false;
        });
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(payload) });
      }
      if (relative === 'projects/novyy-gorizont/inventory.json') {
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(qaInventory) });
      }
      if (target.endsWith('settings.json')) {
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(qaPublishedSettings) });
      }
      if (target.endsWith('assets.json')) {
        const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
        payload.upload_service_url = 'https://feed-api.indigo-dm.ru';
        payload.items.push({
          key: 'unused-render', name: 'Неиспользуемый встроенный рендер', filename: 'unused-render.jpg',
          exists: true, url: 'https://assets.example.test/unused-render.png', active_for: []
        });
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(payload) });
      }
      return route.fulfill({ status: 200, contentType: contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', headers: cors, body: fs.readFileSync(target) });
    }
    if (url.pathname === '/materials' && route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ items: [
        {
          id: 'logo', name: 'Логотип', filename: 'logo-gold.svg',
          url: 'https://assets.example.test/logo.png', uploaded: false, active_for: []
        },
        {
          id: 'key-render', name: 'Ключевой рендер', filename: 'selected-render.jpg',
          url: 'https://assets.example.test/render.png', uploaded: false, active_for: []
        },
        {
          id: 'unused-render', name: 'Неиспользуемый встроенный рендер', filename: 'unused-render.jpg',
          url: 'https://assets.example.test/unused-render.png', uploaded: false, active_for: []
        },
        {
          id: 'mat-qa-library', name: 'Рендер из библиотеки', filename: 'uploads/mat-qa-library.webp',
          url: 'https://assets.example.test/mat-qa-library.webp', uploaded: true, active_for: []
        },
        {
          id: 'mat-qa-unused', name: 'Неиспользуемый материал', filename: 'uploads/mat-qa-unused.webp',
          url: 'https://assets.example.test/mat-qa-unused.webp', uploaded: true, active_for: []
        }
      ] }) });
    }
    if (url.pathname === '/materials' && route.request().method() === 'DELETE') {
      deletedMaterial = JSON.parse(route.request().postData());
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({
        deleted: true, project: deletedMaterial.project, filename: deletedMaterial.filename
      }) });
    }
    if (url.pathname === '/materials/upload' && route.request().method() === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', headers: cors, body: JSON.stringify({
        id: 'mat-qa-new', name: 'Новый материал', filename: 'uploads/mat-qa-new.png',
        url: 'https://assets.example.test/mat-qa-new.png', uploaded: true, active_for: []
      }) });
    }
    if (url.pathname === '/image-library' && route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ items: [
        { id: 'lib-qa-existing', name: 'Готовый рендер', url: 'https://assets.example.test/lib-qa-existing.jpg', path: 'uploads/novyy-gorizont/library/lib-qa-existing.jpg', source: 'library' }
      ] }) });
    }
    if (url.pathname === '/image-library' && route.request().method() === 'DELETE') {
      deletedLibrary = JSON.parse(route.request().postData());
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({
        deleted: true, project: deletedLibrary.project, image_id: deletedLibrary.image_id
      }) });
    }
    if (url.pathname === '/image-library/upload' && route.request().method() === 'POST') {
      bulkImageUploads += 1;
      const id = `lib-qa-${bulkImageUploads}`;
      return route.fulfill({ status: 201, contentType: 'application/json', headers: cors, body: JSON.stringify({
        id, name: `Загружено ${bulkImageUploads}`, url: `https://assets.example.test/${id}.jpg`, path: `uploads/novyy-gorizont/library/${id}.jpg`, size: 51200, source: 'library', storage: 'r2'
      }) });
    }
    if (url.pathname === '/project/setup' && route.request().method() === 'GET') {
      const slug = url.searchParams.get('project');
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({
        project: slug,
        settings: {
          version: 2, rules: [], excluded_lot_ids: [],
          image_settings: { lot_overrides: {}, bulk_rules: [] },
          parameter_settings: { lot_values: {}, bulk_rules: [] },
          material_settings: {
            logo: 'logo.svg', key_render: 'key-render.jpg', background_render: '', primary_color: '#3F245C',
            background_color: '#3F245C', text_color: '#FFFFFF', subtitle_color: '#924694',
            promotion_frame_color: '#924694', promotion_text_color: '#FFFFFF',
            palette: [{ name: 'Основной', value: '#3F245C' }, { name: 'Белый', value: '#FFFFFF' }, { name: 'Подзаголовки', value: '#924694' }]
          }
        },
        assets: {
          project: slug, slug, upload_service_url: 'https://feed-api.indigo-dm.ru',
          current: { logo: 'logo.svg', key_render: 'key-render.jpg', background_render: '' },
          brand: { green: '#3F245C', green_dark: '#1D1D1B', gold: '#924694', gray: '#48277F', white: '#FFFFFF', font: 'Manrope', palette: [{ name: 'Основной', value: '#3F245C' }] },
          items: [
            { key: 'logo', name: 'Логотип', filename: 'logo.svg', exists: true, url: 'https://assets.example.test/logo.png', active_for: ['logo'] },
            { key: 'key-render', name: 'Ключевой рендер', filename: 'key-render.jpg', exists: true, url: 'https://assets.example.test/render.png', active_for: ['key_render'] },
            { key: 'unused-render', name: 'Неиспользуемый встроенный рендер', filename: 'unused-render.jpg', exists: true, url: 'https://assets.example.test/unused-render.png', active_for: [] }
          ]
        }
      }) });
    }
    if (url.pathname === '/source-feed' && route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ project: url.searchParams.get('project'), configured: false }) });
    }
    if (url.pathname === '/source-feed' && route.request().method() === 'POST') {
      sourceFeedSaved = JSON.parse(route.request().postData());
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({
        project: sourceFeedSaved.project, configured: true, hostname: 'profitbase.example', updatedAt: '2026-10-12T12:00:00Z'
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
  await page.route('https://pb12296.profitbase.ru/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMDAxAADAAwBAQDJxQ8AAAAASUVORK5CYII=', 'base64') }));
  await page.route('https://maximum.abc-dev.ru/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMDAxAADAAwBAQDJxQ8AAAAASUVORK5CYII=', 'base64') }));

  await page.goto('http://localhost/#assets', { waitUntil: 'networkidle' });
  const loadingIndicatorAvailable = await page.locator('#project-loading').count() === 1 &&
    !(await page.locator('#project-loading').isVisible());
  const redundantDraftCleared = await page.evaluate(() => !localStorage.getItem('feed-studio-rules-v1-novyy-gorizont'));
  const emptyPublishDisabled = await page.locator('#publish-settings').isDisabled();
  const emptyDraftStatus = (await page.locator('#saved-state').innerText()).trim();
  const publishedChangesButtonText = ((await page.locator('#review-published').textContent()) || '').trim();
  await page.locator('#review-published').click();
  const publishedChangesModalVisible = await page.locator('#published-changes-modal').isVisible();
  const publishedChangesCount = await page.locator('#published-change-list .published-change-item').count();
  const publishedChangeCategories = await page.locator('#published-change-list .published-change-group-heading h3').allTextContents();
  const publishedChangesReadOnly = await page.locator('#published-changes-modal input, #published-changes-modal .button-danger').count() === 0;
  const stalePublishedChange = page.locator('[data-published-change="published-parameter-bulk::qa-stale-parameter-rule"]');
  const stalePublishedRuleWarned = await stalePublishedChange.locator('.published-change-status.warning').count() === 1 &&
    (await stalePublishedChange.innerText()).includes('Не применяется') && (await stalePublishedChange.innerText()).includes('0 квартир');
  const publishedChangeDate = (await page.locator('#published-change-date').innerText()).trim();
  const firstPublishedChange = page.locator('#published-change-list .published-change-item').first();
  await firstPublishedChange.locator('summary').click();
  const publishedChangeDetailsWork = await firstPublishedChange.evaluate((details) => details.open) &&
    await firstPublishedChange.locator('.published-change-facts dt').count() > 0 &&
    await firstPublishedChange.locator('.published-change-facts dd').count() > 0;
  await page.screenshot({ path: path.join(os.tmpdir(), 'feed-studio-published-changes-desktop-qa.png'), fullPage: false });
  await page.locator('#close-published-changes').click();
  const refreshButtonText = ((await page.locator('#refresh-profitbase').textContent()) || '').trim();
  const sourceStateText = ((await page.locator('#feed-source-state').textContent()) || '').trim();
  const staleManualDateHidden = refreshButtonText === 'Обновить исходный фид' && !sourceStateText.includes('27 сент.');
  const availableProjects = await page.locator('#project-select option:not([disabled])').evaluateAll((options) => options.map((option) => ({
    slug: option.value, name: option.textContent.trim()
  })));
  const switchedProjects = [];
  for (const project of availableProjects) {
    await page.locator('#project-select').selectOption(project.slug);
    const expectedName = project.name.replace(/\s+·\s+настройка$/, '');
    try {
      await page.waitForFunction(({ slug, name }) => {
        const select = document.querySelector('#project-select');
        const heading = document.querySelector('#project-name');
        const normalizedHeading = heading?.textContent.replace(/\s+/g, ' ').trim().toUpperCase();
        return select?.value === slug && normalizedHeading === name.replace(/\s+/g, ' ').trim().toUpperCase();
      }, { slug: project.slug, name: expectedName }, { timeout: 10000 });
    } catch (error) {
      throw new Error('Project switch failed: ' + JSON.stringify({
        requested: project,
        selected: await page.locator('#project-select').inputValue(),
        heading: await page.locator('#project-name').innerText(),
        main: (await page.locator('main').innerText()).slice(0, 600),
        errors
      }));
    }
    switchedProjects.push(project.slug);
  }
  const projectSessionCacheWorks = Object.values(projectDataRequests).every((count) => count <= 4);
  const projectBeforeReload = switchedProjects[switchedProjects.length - 1];
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction((slug) => document.querySelector('#project-select')?.value === slug, projectBeforeReload);
  const projectRefreshPersistenceWorks = await page.locator('#project-select').inputValue() === projectBeforeReload;
  await page.locator('#project-select').selectOption('novyy-gorizont');
  await page.waitForFunction(() => document.querySelector('#project-select')?.value === 'novyy-gorizont' &&
    document.querySelector('#project-name')?.textContent.replace(/\s+/g, ' ').trim().toUpperCase() === 'ЖК НОВЫЙ ГОРИЗОНТ');
  const projectSwitchingWorks = switchedProjects.length === availableProjects.length && availableProjects.length >= 4;
  const publicFeedHref = await page.locator('#full-feed-link').getAttribute('href');
  await page.locator('#source-feed-url').fill('https://profitbase.example/private-feed?token=qa-secret');
  await page.locator('#save-source-feed').click();
  await page.waitForFunction(() => document.querySelector('#source-feed-detail')?.textContent.includes('Закрытый адрес исходного фида сохранён') &&
    document.querySelector('#source-feed-url')?.value === '');
  const sourceFeedSettingWorks = sourceFeedSaved?.project === 'novyy-gorizont' &&
    sourceFeedSaved?.url === 'https://profitbase.example/private-feed?token=qa-secret' &&
    (await page.locator('#source-feed-url').inputValue()) === '' &&
    (await page.locator('#source-feed-detail').innerText()).includes('Закрытый адрес исходного фида сохранён') &&
    !(await page.locator('#source-feed-detail').innerText()).includes('profitbase.example') &&
    !(await page.locator('#source-feed-detail').innerText()).includes('qa-secret');
  const initialCards = await page.locator('.asset-card').count();
  const activeBefore = await page.locator('.asset-status.active').count();
  const unusedDeleteButton = page.locator('[data-delete-material="uploads/mat-qa-unused.webp"]');
  const unusedDeleteAvailable = await unusedDeleteButton.count() === 1;
  page.once('dialog', (dialog) => dialog.accept());
  await unusedDeleteButton.click();
  await page.waitForFunction(() => !document.querySelector('[data-material-file="uploads/mat-qa-unused.webp"]'));
  const cardsAfterMaterialDelete = await page.locator('.asset-card').count();
  const unusedMaterialDeleted = deletedMaterial?.project === 'novyy-gorizont' && deletedMaterial?.filename === 'uploads/mat-qa-unused.webp';
  const builtInDeleteButton = page.locator('[data-delete-material="unused-render.jpg"]');
  const builtInDeleteAvailable = await builtInDeleteButton.count() === 1;
  page.once('dialog', (dialog) => dialog.accept());
  await builtInDeleteButton.click();
  await page.waitForFunction(() => !document.querySelector('[data-material-file="unused-render.jpg"]'));
  const builtInMaterialDeleted = deletedMaterial?.project === 'novyy-gorizont' && deletedMaterial?.filename === 'unused-render.jpg';
  if (!(await page.locator('[data-material-file="uploads/mat-qa-library.webp"]').count())) {
    console.error(JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 2000) }, null, 2));
  }
  await page.locator('[data-use-material="key_render"][data-material-file="uploads/mat-qa-library.webp"]').click();
  await page.locator('[data-use-material="background_render"][data-material-file="uploads/mat-qa-library.webp"]').click();
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
  const selectedMaterialDeleteButtons = await page.locator('.asset-card.active [data-delete-material]').count();
  const initialPaletteCount = await page.locator('#brand-palette .palette-item').count();
  const currentPaletteMarkers = await page.locator('#brand-palette .palette-role-tags span').count();
  await page.locator('#new-brand-color').fill('#123ABC');
  await page.locator('#add-brand-color').click();
  const paletteAfterAdd = await page.locator('#brand-palette .palette-item').count();
  await page.locator('[data-use-color-role="primary_color"][data-use-brand-color="#123ABC"]').click();
  await page.locator('[data-use-color-role="promotion_frame_color"][data-use-brand-color="#123ABC"]').click();
  await page.locator('[data-use-color-role="promotion_text_color"][data-use-brand-color="#123ABC"]').click();
  const selectedColorStatus = await page.locator('#brand-palette .palette-item', { has: page.locator('[data-use-brand-color="#123ABC"]') }).locator('.palette-role-tags').innerText();
  const promotionColorRolesWork = selectedColorStatus.includes('Рамка акции') && selectedColorStatus.includes('Текст акции');
  const publishedColorDeleteButtons = await page.locator('#brand-palette .palette-item.published [data-delete-brand-color]').count();
  const removedColor = await page.locator('#brand-palette [data-delete-brand-color]').first().getAttribute('data-delete-brand-color');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#brand-palette [data-delete-brand-color]').first().click();
  const paletteAfterDelete = await page.locator('#brand-palette .palette-item').count();
  const materialWorkspacePreviewVisible = await page.locator('#material-live-card').isVisible();
  await page.locator('#material-filter-search').fill(String(qaLot.id));
  const materialFiltersWork = Number(await page.locator('#material-filter-count').innerText()) === 1 &&
    await page.locator('#material-preview-lot').inputValue() === String(qaLot.id) &&
    await page.locator('#material-apartment-filter .toolbar-apartment-multi').count() === 1;
  const materialToolbarLayout = await page.evaluate(() => {
    const planBox = document.querySelector('#material-filter-plan').getBoundingClientRect();
    const searchBox = document.querySelector('#material-filter-search').getBoundingClientRect();
    const countBox = document.querySelector('.material-toolbar .toolbar-count').getBoundingClientRect();
    return { planWidth: Math.round(planBox.width), aligned: planBox.top < searchBox.bottom && searchBox.top < planBox.bottom && planBox.top < countBox.bottom && countBox.top < planBox.bottom };
  });
  await page.locator('#material-filter-search').fill('');
  const cardOptionsDefaultOn = await page.locator('#show-key-render').isChecked() &&
    await page.locator('#show-house-badge').isChecked() &&
    await page.locator('#show-decoration').isChecked();
  const logoPanelDefaultOff = !(await page.locator('#show-logo-panel').isChecked());
  await page.locator('#show-logo-panel').check();
  const logoPanelToggleWorks = await page.locator('#material-live-card').getAttribute('data-logo-panel') === 'true';
  await page.locator('#show-logo-panel').uncheck();
  await page.locator('#show-key-render').uncheck();
  await page.locator('#show-house-badge').uncheck();
  await page.locator('#show-decoration').uncheck();

  await page.locator('[data-view="preview"]').click();
  await page.waitForFunction(() => !document.querySelector('#preview-live-card')?.classList.contains('hidden'));
  const liveMaterialPreview = await page.locator('#preview-live-card').evaluate((canvas) => ({
    visible: !canvas.classList.contains('hidden'),
    logo: canvas.dataset.logo,
    render: canvas.dataset.render,
    color: canvas.dataset.color,
    backgroundRender: canvas.dataset.backgroundRender,
    showRender: canvas.dataset.showRender,
    houseBadge: canvas.dataset.houseBadge,
    decoration: canvas.dataset.decoration,
    logoPanel: canvas.dataset.logoPanel,
    promotionFrameColor: canvas.dataset.promotionFrameColor,
    promotionTextColor: canvas.dataset.promotionTextColor,
    publishedImageHidden: document.querySelector('#preview-image')?.classList.contains('hidden'),
    noteVisible: !document.querySelector('#preview-material-note')?.classList.contains('hidden')
  }));
  await page.locator('#preview-canvas').screenshot({ path: path.join(os.tmpdir(), 'feed-studio-live-material-preview-qa.png') });
  await page.locator('#preview-filter-search').fill(String(qaLot.id));
  const previewFiltersWork = Number(await page.locator('#preview-filter-count').innerText()) === 1 &&
    await page.locator('#preview-lot').inputValue() === String(qaLot.id) &&
    await page.locator('#preview-apartment-filter .toolbar-apartment-multi').count() === 1;
  const previewToolbarLayout = await page.evaluate(() => {
    const planBox = document.querySelector('#preview-filter-plan').getBoundingClientRect();
    const searchBox = document.querySelector('#preview-filter-search').getBoundingClientRect();
    const countBox = document.querySelector('.preview-toolbar .toolbar-count').getBoundingClientRect();
    return { planWidth: Math.round(planBox.width), aligned: planBox.top < searchBox.bottom && searchBox.top < planBox.bottom && planBox.top < countBox.bottom && countBox.top < planBox.bottom };
  });
  await page.locator('#preview-filter-search').fill('');

  await page.locator('[data-view="images"]').click();
  const apartmentFilterSectionsAvailable = await page.locator('#lot-apartment-filter .toolbar-apartment-multi').count() === 1 &&
    await page.locator('#image-apartment-filter .toolbar-apartment-multi').count() === 1 &&
    await page.locator('#parameter-apartment-filter .toolbar-apartment-multi').count() === 1 &&
    await page.locator('#preview-apartment-filter .toolbar-apartment-multi').count() === 1 &&
    await page.locator('#material-apartment-filter .toolbar-apartment-multi').count() === 1;
  const qaApartmentNumber = String(qaInventory.items[0].source_values.ApartmentNumber);
  const qaSecondApartmentNumber = String(qaInventory.items[1].source_values.ApartmentNumber);
  await page.locator('#image-apartment-filter summary').click();
  await page.locator('#image-apartment-filter [data-apartment-filter-search]').fill(qaApartmentNumber);
  await page.locator(`#image-apartment-filter [data-apartment-filter-option] input[value="${qaApartmentNumber}"]`).check();
  const apartmentFilterCount = Number(await page.locator('#image-filter-count').innerText());
  const apartmentFilterWorks = apartmentFilterCount === 1 &&
    await page.locator('#image-apartment-filter [data-apartment-filter-summary]').innerText() === 'Выбрано: 1';
  await page.locator('#image-apartment-filter [data-apartment-filter-clear]').click();

  await page.waitForFunction(() => document.querySelectorAll('#image-library-grid .image-library-card').length > 0);
  const libraryStartsCollapsed = !(await page.locator('.image-library-panel').evaluate((element) => element.hasAttribute('open')));
  await page.locator('.image-library-panel').evaluate((element) => { element.open = true; });
  const libraryCardsVisible = await page.locator('#image-library-grid .image-library-card').count() > 0;
  await page.locator('.image-library-preview').first().click();
  const libraryLightboxWorks = await page.locator('#image-lightbox').isVisible();
  await page.locator('#close-image-lightbox').click();
  const obsoleteLibraryBuildButtonRemoved = await page.locator('#migrate-image-library').count() === 0;
  await page.locator('[data-library-image="lib-qa-existing"]').check();
  const galleryBeforeLibrary = await page.locator('#image-gallery .image-item').count();
  await page.locator('#add-library-to-lot').click();
  const galleryAfterLibrary = await page.locator('#image-gallery .image-item').count();
  const libraryLotAddWorks = galleryAfterLibrary === galleryBeforeLibrary + 1;
  await page.locator('#add-library-to-lot').click();
  const galleryAfterDuplicateLibraryAdd = await page.locator('#image-gallery .image-item').count();
  const duplicateLibraryStatus = await page.locator('#image-library-status').innerText();
  const duplicateLibraryImageCount = await page.locator('#image-gallery [data-image-drag="lib-qa-existing"]').count();
  const duplicateLibraryAddPrevented = galleryAfterDuplicateLibraryAdd === galleryAfterLibrary &&
    duplicateLibraryImageCount === 1 &&
    duplicateLibraryStatus.includes('Все выбранные изображения уже есть у этой квартиры.');
  await page.locator('#image-apartment-filter details').evaluate((element) => { element.open = true; });
  await page.locator('#image-apartment-filter [data-apartment-filter-search]').fill(qaApartmentNumber);
  await page.locator(`#image-apartment-filter [data-apartment-filter-option] input[value="${qaApartmentNumber}"]`).check();
  await page.locator('#add-library-to-selection').click();
  const libraryRule = page.locator('#image-bulk-rules .bulk-rule').last();
  const librarySelectionStatus = await page.locator('#image-library-status').innerText();
  await libraryRule.locator('summary').click();
  const libraryRuleText = await libraryRule.innerText();
  const librarySelectionAddWorks = libraryRuleText.includes('Из библиотеки') || libraryRuleText.includes('1 изобр.');
  const librarySingularLabelsWork = librarySelectionStatus.includes('Создано правило для 1 квартиры.') &&
    libraryRuleText.includes('Добавить 1 изображение');
  await libraryRule.locator('[data-delete-image-rule]').click();
  const galleryAfterLibraryRuleDelete = await page.locator('#image-gallery .image-item').count();
  const individualImagePreservedAfterBulkDelete = galleryAfterLibraryRuleDelete === galleryAfterLibrary &&
    await page.locator('#image-gallery [data-image-drag="lib-qa-existing"]').count() === 1;
  await page.locator('#image-apartment-filter summary').click();
  await page.locator('#image-apartment-filter [data-apartment-filter-clear]').click();

  await page.locator('#image-lot').selectOption(String(qaSecondLot.id));
  const secondGalleryBeforeMixedRule = await page.locator('#image-gallery .image-item').count();
  const secondLibraryImageBeforeMixedRule = await page.locator('#image-gallery [data-image-drag="lib-qa-existing"]').count();
  await page.locator('#image-lot').selectOption(String(qaLot.id));
  await page.locator('#image-apartment-filter details').evaluate((element) => { element.open = true; });
  await page.locator('#image-apartment-filter [data-apartment-filter-search]').fill(qaApartmentNumber);
  await page.locator(`#image-apartment-filter [data-apartment-filter-option] input[value="${qaApartmentNumber}"]`).check();
  await page.locator('#image-apartment-filter [data-apartment-filter-search]').fill(qaSecondApartmentNumber);
  await page.locator(`#image-apartment-filter [data-apartment-filter-option] input[value="${qaSecondApartmentNumber}"]`).check();
  const mixedSelectionCount = Number(await page.locator('#image-filter-count').innerText());
  await page.locator('#add-library-to-selection').click();
  const mixedLibraryRule = page.locator('#image-bulk-rules .bulk-rule').last();
  await mixedLibraryRule.locator('summary').click();
  const mixedLibraryRuleText = await mixedLibraryRule.innerText();
  const firstGalleryWithMixedRule = await page.locator('#image-gallery .image-item').count();
  const firstLibraryImageWithMixedRule = await page.locator('#image-gallery [data-image-drag="lib-qa-existing"]').count();
  await page.locator('#image-lot').selectOption(String(qaSecondLot.id));
  const secondGalleryWithMixedRule = await page.locator('#image-gallery .image-item').count();
  const secondLibraryImageWithMixedRule = await page.locator('#image-gallery [data-image-drag="lib-qa-existing"]').count();
  await page.locator('#image-lot').selectOption(String(qaLot.id));
  await mixedLibraryRule.locator('[data-delete-image-rule]').click();
  const firstGalleryAfterMixedRuleDelete = await page.locator('#image-gallery .image-item').count();
  const firstLibraryImageAfterMixedRuleDelete = await page.locator('#image-gallery [data-image-drag="lib-qa-existing"]').count();
  await page.locator('#image-lot').selectOption(String(qaSecondLot.id));
  const secondGalleryAfterMixedRuleDelete = await page.locator('#image-gallery .image-item').count();
  const secondLibraryImageAfterMixedRuleDelete = await page.locator('#image-gallery [data-image-drag="lib-qa-existing"]').count();
  const mixedLibraryAddWorks = mixedSelectionCount === 2 &&
    mixedLibraryRuleText.includes('2 квартиры') &&
    secondLibraryImageBeforeMixedRule === 0 &&
    firstGalleryWithMixedRule === galleryAfterLibrary && firstLibraryImageWithMixedRule === 1 &&
    secondGalleryWithMixedRule === secondGalleryBeforeMixedRule + 1 && secondLibraryImageWithMixedRule === 1 &&
    firstGalleryAfterMixedRuleDelete === galleryAfterLibrary && firstLibraryImageAfterMixedRuleDelete === 1 &&
    secondGalleryAfterMixedRuleDelete === secondGalleryBeforeMixedRule && secondLibraryImageAfterMixedRuleDelete === 0;
  await page.locator('#image-lot').selectOption(String(qaLot.id));
  await page.locator('#image-apartment-filter details').evaluate((element) => { element.open = true; });
  await page.locator('#image-apartment-filter [data-apartment-filter-clear]').click();

  await page.locator('[data-open-chessboard="images"]').click();
  const chessboardVisible = await page.locator('#chessboard-modal').isVisible();
  const chessboardHasFloors = await page.locator('.chessboard-floor').count() > 0;
  const chessboardHasThumbnails = await page.locator('.chessboard-lot img').count() > 0;
  await page.locator('.chessboard-modal').screenshot({ path: path.join(os.tmpdir(), 'feed-studio-chessboard-qa.png') });
  const chessboardChosenIds = [];
  for (let index = 0; index < 2; index += 1) {
    const checkbox = page.locator('[data-chessboard-id]').nth(index);
    chessboardChosenIds.push(await checkbox.getAttribute('data-chessboard-id'));
    await checkbox.check();
  }
  await page.locator('#apply-chessboard').click();
  const chessboardExactCount = Number(await page.locator('#image-filter-count').innerText());
  const chessboardButtonText = await page.locator('[data-open-chessboard="images"]').innerText();
  await page.locator('#bulk-image-from').fill('2');
  await page.locator('#bulk-image-to').fill('1');
  await page.locator('#apply-image-bulk').click();
  const chessboardRule = page.locator('#image-bulk-rules .bulk-rule').last();
  const chessboardRuleText = await chessboardRule.innerText();
  await chessboardRule.locator('[data-delete-image-rule]').click();
  const chessboardSelectionWorks = chessboardVisible && chessboardHasFloors && chessboardHasThumbnails &&
    chessboardExactCount === 2 && chessboardButtonText.includes('2') && chessboardRuleText.includes('2 квартиры');
  await page.locator('[data-open-chessboard="images"]').click();
  await page.locator('#chessboard-clear').click();
  await page.locator('#apply-chessboard').click();

  const bulkHideInput = page.locator('#bulk-image-hide-picker [data-bulk-hide-image]').first();
  const bulkHiddenImageId = await bulkHideInput.getAttribute('data-bulk-hide-image');
  const galleryBeforeBulkHide = await page.locator('#image-gallery .image-item').count();
  await bulkHideInput.check();
  await page.locator('#apply-image-hide-bulk').click();
  const bulkHideRule = page.locator('#image-bulk-rules .bulk-rule').last();
  const bulkHideRuleText = await bulkHideRule.innerText();
  const bulkImageHideWorks = bulkHideRuleText.includes('Исключить') &&
    await page.locator(`#image-gallery [data-image-drag="${bulkHiddenImageId}"]`).count() === 0 &&
    await page.locator('#image-gallery .image-item').count() === galleryBeforeBulkHide - 1;
  await bulkHideRule.locator('[data-delete-image-rule]').click();
  const bulkImageHideRestores = await page.locator(`#image-gallery [data-image-drag="${bulkHiddenImageId}"]`).count() === 1;

  await page.locator('#image-gallery [data-lightbox-src]').first().click();
  const galleryLightboxWorks = await page.locator('#image-lightbox').isVisible();
  await page.locator('#close-image-lightbox').click();

  const dragOrderBefore = await page.locator('#image-gallery [data-image-drag]').evaluateAll((cards) => cards.map((card) => card.dataset.imageDrag));
  let imageMouseDragWorks = false;
  if (dragOrderBefore.length >= 2) {
    const source = page.locator(`#image-gallery [data-image-drag="${dragOrderBefore[0]}"]`);
    const target = page.locator(`#image-gallery [data-image-drag="${dragOrderBefore[1]}"]`);
    const targetBox = await target.boundingBox();
    await source.dragTo(target, { targetPosition: { x: Math.max(2, targetBox.width - 3), y: Math.max(2, targetBox.height / 2) } });
    const dragOrderAfter = await page.locator('#image-gallery [data-image-drag]').evaluateAll((cards) => cards.map((card) => card.dataset.imageDrag));
    imageMouseDragWorks = dragOrderAfter[0] === dragOrderBefore[1] && dragOrderAfter[1] === dragOrderBefore[0];
    const moved = page.locator(`#image-gallery [data-image-drag="${dragOrderBefore[0]}"]`);
    const restoreTarget = page.locator(`#image-gallery [data-image-drag="${dragOrderBefore[1]}"]`);
    const restoreBox = await restoreTarget.boundingBox();
    await moved.dragTo(restoreTarget, { targetPosition: { x: 2, y: Math.max(2, restoreBox.height / 2) } });
  }
  const imageIndividualBefore = await page.locator('#image-individual-rules .individual-rule').count();
  const imageIndividualId = await page.locator('#image-individual-rules [data-open-image-individual]').first().getAttribute('data-open-image-individual');
  await page.locator('#image-individual-rules [data-open-image-individual]').first().click();
  const openedImageLot = await page.locator('#image-lot').inputValue();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#image-individual-rules [data-delete-image-individual]').first().click();
  const imageIndividualAfter = await page.locator('#image-individual-rules .individual-rule').count();
  await page.locator('#image-filter-search').fill('');
  const imagePlanOptions = await page.locator('#image-filter-plan option').count();
  let selectedImagePlan = '';
  let selectedImagePlanCount = 0;
  let imagePlanRuleCreated = false;
  let imageRuleStartsCollapsed = false;
  let imageRuleExpanded = false;
  let imageRuleScopeDetailed = false;
  let imageRuleActionDetailed = false;
  let bulkAddedImageMoved = false;
  let bulkImageAddRuleWorks = false;
  let bulkImageAddPreviewWorks = false;
  if (imagePlanOptions > 1) {
    selectedImagePlan = await page.locator('#image-filter-plan option').nth(1).getAttribute('value');
    await page.locator('#image-filter-plan').selectOption(selectedImagePlan);
    selectedImagePlanCount = Number(await page.locator('#image-filter-count').innerText());
    const galleryBeforeBulkAdd = await page.locator('#image-gallery .image-item').count();
    const bulkFixture = fs.readFileSync(path.resolve(frontend, '..', 'novyy-gorizont', 'feed-generator', 'projects', 'novyy-gorizont', 'assets', 'selected-render.jpg'));
    const similarDialogHandler = (dialog) => dialog.accept();
    page.on('dialog', similarDialogHandler);
    await page.locator('#library-image-file-input').setInputFiles([
      { name: 'mass-one.jpg', mimeType: 'image/jpeg', buffer: bulkFixture },
      { name: 'mass-two.jpg', mimeType: 'image/jpeg', buffer: bulkFixture }
    ]);
    await page.locator('#upload-library-images').click();
    await page.waitForFunction(() => document.querySelector('#library-image-upload-status')?.textContent.includes('Загружено в библиотеку: 2'));
    page.off('dialog', similarDialogHandler);
    const uploadSelectionOrderWorks = await page.locator('[data-library-image="lib-qa-1"] + b').innerText() === '1' &&
      await page.locator('[data-library-image="lib-qa-2"] + b').innerText() === '2';
    await page.locator('#library-image-mode').selectOption('position');
    await page.locator('#library-image-position').fill('2');
    await page.locator('#add-library-to-selection').click();
    const bulkAddRule = page.locator('#image-bulk-rules .bulk-rule').last();
    const bulkAddRuleText = await bulkAddRule.innerText();
    const galleryAfterBulkAdd = await page.locator('#image-gallery .image-item').count();
    bulkImageAddRuleWorks = bulkImageUploads === 2 && uploadSelectionOrderWorks && bulkAddRuleText.includes('2 изобр.') && bulkAddRuleText.includes(`${selectedImagePlanCount} квартир`);
    bulkImageAddPreviewWorks = galleryAfterBulkAdd === galleryBeforeBulkAdd + 2;
    await page.locator('.url-alternative').evaluate((details) => { details.open = true; });
    await page.locator('#new-image-url').fill('https://assets.example.test/bulk-added-regression.png');
    await page.locator('#add-image-url').click();
    const addedImageMoveButton = page.locator('#image-gallery [data-image-left^="add-"]').last();
    const addedImageId = await addedImageMoveButton.getAttribute('data-image-left');
    const addedImagePositionBefore = Number(await page.locator(`#image-gallery [data-image-left="${addedImageId}"]`).evaluate((button) =>
      button.closest('.image-item').querySelector('.image-position').textContent));
    await page.locator('#bulk-image-from').fill(String(addedImagePositionBefore));
    await page.locator('#bulk-image-to').fill('3');
    await page.locator('#apply-image-bulk').click();
    const addedImagePositionAfter = Number(await page.locator(`#image-gallery [data-image-left="${addedImageId}"]`).evaluate((button) =>
      button.closest('.image-item').querySelector('.image-position').textContent));
    bulkAddedImageMoved = addedImagePositionBefore > 3 && addedImagePositionAfter === 3;
    const imageRule = page.locator('#image-bulk-rules .bulk-rule').last();
    const imageRuleDetails = imageRule.locator('[data-bulk-rule-details]');
    imagePlanRuleCreated = (await imageRule.innerText()).includes(`${selectedImagePlanCount} квартир`);
    imageRuleStartsCollapsed = !(await imageRuleDetails.evaluate((details) => details.open));
    await imageRuleDetails.locator('summary').click();
    imageRuleExpanded = await imageRuleDetails.evaluate((details) => details.open);
    const imageRuleScopeText = await imageRule.locator('[data-bulk-rule-scope]').innerText();
    const imageRuleActionText = await imageRule.locator('[data-bulk-rule-action]').innerText();
    imageRuleScopeDetailed = imageRuleScopeText.includes('Планировка') && imageRuleScopeText.includes('м²') &&
      imageRuleScopeText.includes('Подходящие лоты') && imageRuleScopeText.includes('Выбор по ID');
    imageRuleActionDetailed = imageRuleActionText.includes('Переместить изображение с позиции');
    await page.screenshot({ path: path.join(os.tmpdir(), 'feed-studio-images-plan-filter-qa.png'), fullPage: true });
    const uploadedAddRule = page.locator('[data-bulk-rule-details^="image-add-rule-"]').last().locator('xpath=..');
    await uploadedAddRule.locator('[data-delete-image-rule]').click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-delete-library-image="lib-qa-1"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-library-image="lib-qa-1"]'));
    await page.locator('#image-filter-plan').selectOption('');
  }
  const libraryDeleteWorks = deletedLibrary?.project === 'novyy-gorizont' && deletedLibrary?.image_id === 'lib-qa-1';

  await page.locator('[data-view="parameters"]').click();
  const staleEditableRule = page.locator('[data-bulk-rule-details="qa-stale-parameter-rule"]').locator('xpath=..');
  const staleEditableRuleWarned = await staleEditableRule.evaluate((rule) => rule.classList.contains('warning')) &&
    (await staleEditableRule.innerText()).includes('Не применяется · 0 квартир');
  const individualParameterOptions = await page.locator('#new-parameter-tag option').count();
  const bulkParameterOptions = await page.locator('#bulk-parameter-tag option').count();
  await page.locator('#bulk-parameter-tag').selectOption('Description');
  const bulkDescriptionShortcodeExcluded = await page.locator('#bulk-parameter-value [data-description-shortcode] option[value="Description"]').count() === 0;
  const shortcodeAliasPairs = [['Id', 'id'], ['Rooms', 'rooms'], ['Square', 'area'], ['Floor', 'floor'], ['Floors', 'floors'], ['Price', 'price'], ['Decoration', 'decoration']];
  const shortcodeOptionsAreUnique = async (locator) => {
    const values = await locator.locator('option').evaluateAll((options) => options.map((option) => option.value));
    return shortcodeAliasPairs.every(([canonical, alias]) => !(values.includes(canonical) && values.includes(alias)));
  };
  const bulkDescriptionShortcodesUnique = await shortcodeOptionsAreUnique(page.locator('#bulk-parameter-value [data-description-shortcode]'));
  const bulkDescriptionStartsEmpty = !(await page.locator('#bulk-parameter-value [data-rich-editor]').innerHTML()).includes('{{Description}}') &&
    !(await page.locator('#bulk-parameter-value [data-rich-editor]').innerText()).trim();
  const bulkDescriptionExpandVisible = await page.locator('#bulk-parameter-value [data-expand-description]').isVisible();
  await page.locator('#bulk-parameter-value [data-expand-description]').click();
  const bulkDescriptionModalVisible = await page.locator('#description-modal').isVisible();
  const modalDescriptionShortcodesUnique = await shortcodeOptionsAreUnique(page.locator('#description-modal-body [data-description-shortcode]'));
  const bulkDescriptionModalSize = await page.locator('#description-modal-body [data-rich-editor]').evaluate((editor) => {
    const box = editor.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  });
  await page.locator('#description-modal .description-modal').screenshot({ path: path.join(os.tmpdir(), 'feed-studio-bulk-description-modal-qa.png') });
  await page.locator('#description-modal-body [data-rich-editor]').click();
  await page.locator('#description-modal-body [data-description-shortcode]').selectOption('Square');
  await page.locator('#description-modal-body [data-insert-shortcode]').click();
  const bulkDescriptionModalShortcodeInserted = (await page.locator('#description-modal-body [data-rich-editor]').innerHTML()).includes('{{Square}}');
  await page.locator('#description-modal-body [data-rich-editor]').evaluate((editor) => {
    editor.innerHTML = '<p>Комнат: {{Rooms}}</p>';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await page.locator('#close-description-modal').click();
  const bulkDescriptionContentPreserved = (await page.locator('#bulk-parameter-value [data-rich-editor]').innerHTML()).includes('{{Rooms}}');
  await page.locator('#bulk-parameter-value [data-expand-description]').click();
  await page.keyboard.press('Escape');
  const bulkDescriptionEscapeCloses = !(await page.locator('#description-modal').isVisible()) &&
    await page.locator('#bulk-parameter-value [data-rich-editor]').isVisible();
  await page.locator('#apply-parameter-bulk').click();
  const parameterRule = page.locator('#parameter-bulk-rules .bulk-rule').last();
  const parameterRuleDetails = parameterRule.locator('[data-bulk-rule-details]');
  const parameterRuleCreated = await parameterRule.count() === 1;
  const parameterRuleStartsCollapsed = !(await parameterRuleDetails.evaluate((details) => details.open));
  await parameterRuleDetails.locator('summary').click();
  const parameterRuleExpanded = await parameterRuleDetails.evaluate((details) => details.open);
  const parameterRuleScopeText = await parameterRule.locator('[data-bulk-rule-scope]').innerText();
  const parameterRuleActionText = await parameterRule.locator('[data-bulk-rule-action]').innerText();
  const parameterRuleScopeDetailed = parameterRuleScopeText.includes('Дом') && parameterRuleScopeText.includes('Комнатность') &&
    parameterRuleScopeText.includes('Планировка') && parameterRuleScopeText.includes('Подходящие лоты');
  const parameterRuleActionDetailed = parameterRuleActionText.includes('Описание: задан новый текст');
  await parameterRule.locator('[data-delete-parameter-rule]').click();
  const descriptionEditorVisible = await page.locator('#description-editor-wrap [data-rich-editor]').isVisible();
  const descriptionShortcodes = await page.locator('#description-editor-wrap [data-description-shortcode] option').count();
  const individualDescriptionShortcodesUnique = await shortcodeOptionsAreUnique(page.locator('#description-editor-wrap [data-description-shortcode]'));
  const descriptionPreviewVisible = await page.locator('#description-editor-wrap [data-description-preview]').isVisible();
  const planOptions = await page.locator('#parameter-filter-plan option').count();
  const parameterToolbarLayout = await page.evaluate(() => {
    const plan = document.querySelector('#parameter-filter-plan');
    const search = document.querySelector('#parameter-filter-search');
    const count = document.querySelector('.parameter-toolbar .toolbar-count');
    const planBox = plan.getBoundingClientRect();
    const searchBox = search.getBoundingClientRect();
    const countBox = count.getBoundingClientRect();
    return {
      planWidth: Math.round(planBox.width),
      singleRow: planBox.top < searchBox.bottom && searchBox.top < planBox.bottom && planBox.top < countBox.bottom && countBox.top < planBox.bottom
    };
  });
  await page.screenshot({ path: path.join(os.tmpdir(), 'feed-studio-parameters-qa.png'), fullPage: true });
  let selectedPlan = '';
  let selectedPlanCount = 0;
  if (planOptions > 1) {
    selectedPlan = await page.locator('#parameter-filter-plan option').nth(1).getAttribute('value');
    await page.locator('#parameter-filter-plan').selectOption(selectedPlan);
    selectedPlanCount = Number(await page.locator('#parameter-filter-count').innerText());
    await page.locator('#parameter-filter-plan').selectOption('');
  }
  const parameterLotId = await page.locator('#parameter-lot').inputValue();
  const parameterItem = qaInventory.items.find((item) => String(item.id) === String(parameterLotId));
  const parameterContextText = await page.locator('#parameter-lot-context').innerText();
  const parameterContextImage = await page.locator('#parameter-lot-context img').getAttribute('src');
  const parameterLotContextWorks = parameterContextText.includes('Этаж') &&
    parameterContextText.includes(String(parameterItem.floor)) &&
    parameterContextText.includes('Номер квартиры') &&
    parameterContextText.includes(String(parameterItem.source_values.ApartmentNumber)) &&
    parameterContextText.includes(String(parameterItem.id)) &&
    parameterContextImage === String(parameterItem.source_images[0].url);
  await page.locator('#parameter-lot-context [data-lightbox-src]').click();
  const parameterLightboxWorks = await page.locator('#image-lightbox').isVisible();
  await page.locator('#close-image-lightbox').click();
  const sourceAddress = String(parameterItem?.source_values?.Address || '').replace(/\s+/g, ' ').trim();
  const descriptionShortcodeExcluded = await page.locator('#description-editor-wrap [data-description-shortcode] option[value="Description"]').count() === 0;
  const addressOption = page.locator('#description-editor-wrap [data-description-shortcode] option[value="Address"]');
  const addressOptionText = await addressOption.innerText();
  const addressOptionTitle = await addressOption.getAttribute('title');
  const addressShownFully = Boolean(sourceAddress) && addressOptionText.endsWith(sourceAddress) && String(addressOptionTitle || '').endsWith(sourceAddress);
  await page.locator('#description-editor-wrap [data-rich-editor]').evaluate((editor) => {
    editor.innerHTML = '<div>Первый абзац</div><div><strong>Второй абзац</strong></div><ul><li>Пункт списка</li></ul>';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await page.locator('[data-view="dashboard"]').click();
  await page.locator('[data-view="parameters"]').click();
  const normalizedDescriptionHtml = await page.locator('#description-editor-wrap [data-rich-editor]').innerHTML();
  const descriptionFormattingPreserved = await page.locator('#description-editor-wrap [data-description-preview]').evaluate((preview) => {
    const paragraphs = preview.querySelectorAll('p');
    const list = preview.querySelector('ul');
    return paragraphs.length === 2 && Boolean(preview.querySelector('strong')) && Boolean(list) &&
      parseFloat(getComputedStyle(paragraphs[0]).marginBottom) > 0 && getComputedStyle(list).listStyleType !== 'none';
  });
  const descriptionBlocksNormalized = normalizedDescriptionHtml.includes('<p>Первый абзац</p>') &&
    normalizedDescriptionHtml.includes('<p><strong>Второй абзац</strong></p>') && normalizedDescriptionHtml.includes('<ul><li>Пункт списка</li></ul>');
  await page.locator('#description-editor-wrap').screenshot({ path: path.join(os.tmpdir(), 'feed-studio-description-formatting-qa.png') });
  await page.locator('#description-editor-wrap [data-rich-editor]').evaluate((editor) => {
    editor.innerHTML = '<p><strong>Площадь</strong>: {{Square}} м²</p>';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  const descriptionTemplateKept = (await page.locator('#description-editor-wrap [data-rich-editor]').innerHTML()).includes('{{Square}}');
  const descriptionPreviewText = await page.locator('#description-editor-wrap [data-description-preview]').innerText();
  const descriptionResolved = descriptionPreviewText.includes('Площадь') && !descriptionPreviewText.includes('{{Square}}');
  const roomsParameterAvailable = await page.locator('#new-parameter-tag option[value="Rooms"]').count() === 1 &&
    await page.locator('#bulk-parameter-tag option[value="Rooms"]').count() === 1;
  const requiredTextParametersAvailable = await page.locator('#new-parameter-tag option[value="NewDevelopmentId"]').count() === 1 &&
    await page.locator('#new-parameter-tag option[value="Address"]').count() === 1 &&
    await page.locator('#bulk-parameter-tag option[value="NewDevelopmentId"]').count() === 1 &&
    await page.locator('#bulk-parameter-tag option[value="Address"]').count() === 1;
  await page.locator('#new-parameter-tag').selectOption('Address');
  await page.locator('#add-parameter').click();
  const addressInput = page.locator('#parameter-list input[data-param-value="Address"]');
  const addressStartsFromSource = await addressInput.getAttribute('type') === 'text' &&
    await addressInput.inputValue() === sourceAddress;
  const manualAddress = 'Ростов-на-Дону, проспект Стачки, 251/2';
  await addressInput.fill(manualAddress);
  await addressInput.dispatchEvent('change');
  await page.locator('#new-parameter-tag').selectOption('NewDevelopmentId');
  await page.locator('#add-parameter').click();
  const developmentInput = page.locator('#parameter-list input[data-param-value="NewDevelopmentId"]');
  const developmentInputIsText = await developmentInput.getAttribute('type') === 'text';
  const manualDevelopmentId = 'qa-development-42';
  await developmentInput.fill(manualDevelopmentId);
  await developmentInput.dispatchEvent('change');
  const requiredTextParametersEditable = await page.locator('#parameter-list input[data-param-value="Address"]').inputValue() === manualAddress &&
    await page.locator('#parameter-list input[data-param-value="NewDevelopmentId"]').inputValue() === manualDevelopmentId;
  await page.locator('#parameter-list').screenshot({ path: path.join(os.tmpdir(), 'feed-studio-required-text-parameters-qa.png') });
  const studioRoomFilterAvailable = await page.locator('#filter-rooms option[value="Студия"]').count() === 1 &&
    await page.locator('#image-filter-rooms option[value="Студия"]').count() === 1 &&
    await page.locator('#parameter-filter-rooms option[value="Студия"]').count() === 1;
  await page.locator('#new-parameter-tag').selectOption('Rooms');
  await page.locator('#add-parameter').click();
  const roomsInput = page.locator('#parameter-list [data-param-value="Rooms"]');
  const sourceRooms = String(parameterItem?.source_values?.Rooms || parameterItem?.rooms || '');
  const roomsStartsFromSource = await roomsInput.inputValue() === sourceRooms;
  const studioRoomAvailable = await roomsInput.locator('option[value="Студия"]').count() === 1;
  const roomValuesLimitedToFive = await roomsInput.locator('option[value="5"]').count() === 1 &&
    await roomsInput.locator('option[value="6"], option[value="20"]').count() === 0;
  const changedRooms = 'Студия';
  await roomsInput.selectOption(changedRooms);
  await page.locator('#description-editor-wrap [data-rich-editor]').evaluate((editor) => {
    editor.innerHTML = '<p>Комнат после правки: {{Rooms}}</p>';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  const roomsDescriptionPreview = await page.locator('#description-editor-wrap [data-description-preview]').innerText();
  const roomsShortcodeUsesOverride = roomsDescriptionPreview.includes('Комнат после правки: ' + changedRooms);
  const roomsShortcodeUses_override = roomsShortcodeUsesOverride;
  await page.locator('#parameter-filter-rooms').selectOption('Студия');
  const studioFilterMatchesOverride = Number(await page.locator('#parameter-filter-count').innerText()) > 0 &&
    await page.locator('#parameter-lot').inputValue() === parameterLotId;
  await page.locator('#parameter-filter-rooms').selectOption('');
  const parameterIndividualBefore = await page.locator('#parameter-individual-rules .individual-rule').count();
  const parameterIndividualLabels = await page.locator('#parameter-individual-rules .individual-rule').first().innerText();
  await page.locator('#parameter-individual-rules [data-open-parameter-individual]').first().click();
  const openedParameterLot = await page.locator('#parameter-lot').inputValue();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#parameter-individual-rules [data-delete-parameter-individual]').first().click();
  const parameterIndividualAfter = await page.locator('#parameter-individual-rules .individual-rule').count();
  const bulkParameterGap = await page.evaluate(() => {
    const values = document.querySelector('#bulk-parameter-value');
    const button = document.querySelector('#apply-parameter-bulk');
    return values && button ? Math.round(button.getBoundingClientRect().top - values.getBoundingClientRect().bottom) : -1;
  });

  await page.locator('[data-view="promotions"]').click();
  const promotionLotId = await page.locator('[data-exclude]').first().getAttribute('data-exclude');
  await page.locator('[data-exclude]').first().click();
  const promotionIndividualBefore = await page.locator('#promotion-individual-rules .individual-rule').count();
  await page.locator('#promotion-individual-rules [data-open-promotion-individual]').first().click();
  const openedPromotionLot = await page.locator('#preview-lot').inputValue();
  await page.locator('[data-view="promotions"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#promotion-individual-rules [data-delete-promotion-individual]').first().click();
  const promotionIndividualAfter = await page.locator('#promotion-individual-rules .individual-rule').count();
  const promotionTargets = [];
  for (const item of qaInventory.items) {
    if (!promotionTargets.some((target) => String(target.floor) === String(item.floor))) promotionTargets.push(item);
    if (promotionTargets.length === 2) break;
  }
  await page.locator('#add-rule').click();
  for (const target of promotionTargets) {
    const floorDetails = page.locator('[data-rule-multi="floors"]');
    if (!(await floorDetails.evaluate((details) => details.open))) await floorDetails.locator('summary').click();
    const floorCheckbox = page.locator(`[data-rule-multi-value="floors"][value="${target.floor}"]`);
    if (!(await floorCheckbox.isChecked())) await floorCheckbox.check();
  }
  for (const target of promotionTargets) {
    const apartmentNumber = String(target.source_values.ApartmentNumber);
    const apartmentDetails = page.locator('[data-rule-multi="apartment_numbers"]');
    if (!(await apartmentDetails.evaluate((details) => details.open))) await apartmentDetails.locator('summary').click();
    await page.locator('[data-rule-multi-search="apartment_numbers"]').fill(apartmentNumber);
    await page.locator('[data-rule-multi-all="apartment_numbers"]').click();
  }
  const floorMultiSummary = await page.locator('[data-rule-multi="floors"] [data-rule-multi-summary]').innerText();
  const apartmentMultiSummary = await page.locator('[data-rule-multi="apartment_numbers"] [data-rule-multi-summary]').innerText();
  const promotionFilteredMatchCount = Number(await page.locator('.match-heading strong').innerText());
  const promotionMultiFiltersWork = floorMultiSummary.includes('2') && apartmentMultiSummary.includes('2') &&
    promotionFilteredMatchCount === promotionTargets.length;
  await page.locator('[data-open-chessboard="promotions"]').click();
  await page.locator('[data-chessboard-id]').first().check();
  await page.locator('#apply-chessboard').click();
  const promotionChessboardExactCount = Number(await page.locator('.match-heading strong').innerText());
  const promotionChessboardButtonText = await page.locator('[data-open-chessboard="promotions"]').innerText();
  const promotionChessboardWorks = promotionChessboardExactCount === 1 && promotionChessboardButtonText.includes('1');
  await page.locator('[data-open-chessboard="promotions"]').click();
  await page.locator('#chessboard-clear').click();
  await page.locator('#apply-chessboard').click();
  await page.screenshot({ path: path.join(os.tmpdir(), 'feed-studio-promotion-multi-filters-qa.png'), fullPage: true });

  await page.locator('[data-view="assets"]').click();
  const visibleProfitbaseMentions = await page.locator('body').evaluate((body) => (body.innerText.match(/Profitbase/gi) || []).length);
  const materialOverlay = await page.locator('.asset-card').first().evaluate((card) => {
    const preview = card.querySelector('.asset-preview');
    const copy = card.querySelector('.asset-copy');
    const style = copy ? getComputedStyle(copy) : null;
    return Boolean(preview && copy && copy.parentElement === preview && style.position === 'absolute' && style.backgroundImage.includes('linear-gradient'));
  });
  await page.screenshot({ path: path.join(os.tmpdir(), 'feed-studio-materials-qa.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const mobileOverflowByView = {};
  for (const view of ['images', 'parameters', 'promotions', 'assets']) {
    await page.locator(`[data-view="${view}"]`).click();
    mobileOverflowByView[view] = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }
  const mobileOverflow = Math.max(...Object.values(mobileOverflowByView));
  const mobileMaterialActions = await page.locator('.asset-actions .button').count();
  await page.locator('#review-published').click();
  const mobilePublishedModal = await page.locator('.published-changes-modal').evaluate((modal) => {
    const rect = modal.getBoundingClientRect();
    return {
      visible: !modal.closest('#published-changes-modal').classList.contains('hidden'),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  await page.screenshot({ path: path.join(os.tmpdir(), 'feed-studio-published-changes-mobile-qa.png'), fullPage: false });
  await page.locator('#close-published-changes').click();
  await page.locator('[data-view="lots"]').click();
  const excludedLotId = await page.locator('[data-toggle-feed-lot]').first().getAttribute('data-toggle-feed-lot');
  await page.locator('[data-toggle-feed-lot]').first().click();
  const excludedCardMarked = await page.locator('.lot-card.excluded').count();
  await page.locator('#publish-settings').click();
  await page.locator('#confirm-publish').click();
  await page.waitForFunction(() => window.localStorage.getItem('feed-studio-publish-v1-novyy-gorizont'));

  const result = {
    ok: errors.length === 0 && previewFiltersWork && apartmentFilterSectionsAvailable && apartmentFilterWorks && libraryStartsCollapsed && libraryCardsVisible && libraryLightboxWorks && galleryLightboxWorks && parameterLightboxWorks && obsoleteLibraryBuildButtonRemoved && libraryLotAddWorks && duplicateLibraryAddPrevented && librarySelectionAddWorks && librarySingularLabelsWork && individualImagePreservedAfterBulkDelete && mixedLibraryAddWorks && libraryDeleteWorks && chessboardSelectionWorks && bulkImageHideWorks && bulkImageHideRestores && imageMouseDragWorks && bulkImageAddRuleWorks && bulkImageAddPreviewWorks && promotionChessboardWorks && loadingIndicatorAvailable && projectSessionCacheWorks && redundantDraftCleared && emptyPublishDisabled && !emptyDraftStatus.includes('не применён') && publishedChangesModalVisible && publishedChangesCount >= 2 && publishedChangesButtonText.includes(String(publishedChangesCount)) && publishedChangeCategories.includes('Акции') && publishedChangeCategories.includes('Материалы') && publishedChangesReadOnly && stalePublishedRuleWarned && publishedChangeDate.includes('Опубликованная версия') && publishedChangeDetailsWork && projectSwitchingWorks && projectRefreshPersistenceWorks && sourceFeedSettingWorks && staleManualDateHidden && sourceStateText.includes('Источник проверен') && publicFeedHref === 'https://indigo-dm.github.io/feed-studio/feeds/novyy-gorizont/avito.xml' && initialCards >= 5 && activeBefore === 2 && unusedDeleteAvailable && unusedMaterialDeleted && builtInDeleteAvailable && builtInMaterialDeleted && cardsAfterMaterialDelete === initialCards - 1 && selectedMaterialDeleteButtons === 0 && visibleProfitbaseMentions === 0 && selectedLibrary.some((text) => text.includes('Рендер в макете')) && cardsAfterUpload === initialCards - 1 && initialPaletteCount >= 4 && currentPaletteMarkers >= 4 && paletteAfterAdd === initialPaletteCount + 1 && selectedColorStatus.includes('Основной') && publishedColorDeleteButtons === 0 && paletteAfterDelete === initialPaletteCount && materialWorkspacePreviewVisible && cardOptionsDefaultOn && logoPanelDefaultOff && logoPanelToggleWorks && liveMaterialPreview.visible && liveMaterialPreview.publishedImageHidden && liveMaterialPreview.noteVisible && liveMaterialPreview.logo === 'uploads/mat-qa-new.png' && liveMaterialPreview.render === 'uploads/mat-qa-library.webp' && liveMaterialPreview.backgroundRender === 'uploads/mat-qa-library.webp' && liveMaterialPreview.showRender === 'false' && liveMaterialPreview.color === '#123ABC' && liveMaterialPreview.houseBadge === 'false' && liveMaterialPreview.decoration === 'false' && liveMaterialPreview.logoPanel === 'false' && imageIndividualBefore >= 1 && openedImageLot === imageIndividualId && imageIndividualAfter === imageIndividualBefore - 1 && imagePlanOptions > 1 && /^plan-[0-9a-f]{12}$/.test(selectedImagePlan) && selectedImagePlanCount > 0 && imagePlanRuleCreated && imageRuleStartsCollapsed && imageRuleExpanded && imageRuleScopeDetailed && imageRuleActionDetailed && bulkAddedImageMoved && individualParameterOptions === 11 && bulkParameterOptions === 12 && staleEditableRuleWarned && bulkDescriptionShortcodeExcluded && bulkDescriptionShortcodesUnique && modalDescriptionShortcodesUnique && bulkDescriptionStartsEmpty && bulkDescriptionExpandVisible && bulkDescriptionExpandVisible && bulkDescriptionModalVisible && bulkDescriptionModalSize.width > 700 && bulkDescriptionModalSize.height >= 320 && bulkDescriptionModalShortcodeInserted && bulkDescriptionContentPreserved && bulkDescriptionEscapeCloses && parameterRuleCreated && parameterRuleStartsCollapsed && parameterRuleExpanded && parameterRuleScopeDetailed && parameterRuleActionDetailed && descriptionEditorVisible && descriptionShortcodes >= 5 && individualDescriptionShortcodesUnique && descriptionShortcodeExcluded && addressShownFully && descriptionPreviewVisible && descriptionBlocksNormalized && descriptionFormattingPreserved && descriptionTemplateKept && descriptionResolved && roomsParameterAvailable && requiredTextParametersAvailable && addressStartsFromSource && developmentInputIsText && requiredTextParametersEditable && roomsStartsFromSource && studioRoomAvailable && roomValuesLimitedToFive && studioRoomFilterAvailable && roomsShortcodeUses_override && studioFilterMatchesOverride && planOptions > 1 && parameterToolbarLayout.planWidth <= 270 && parameterToolbarLayout.singleRow && /^plan-[0-9a-f]{12}$/.test(selectedPlan) && selectedPlanCount > 0 && parameterLotContextWorks && parameterIndividualBefore === 1 && parameterIndividualLabels.includes('Описание') && parameterIndividualLabels.includes('Количество комнат') && parameterIndividualLabels.includes('ID новостройки') && parameterIndividualLabels.includes('Адрес') && openedParameterLot === parameterLotId && parameterIndividualAfter === 0 && bulkParameterGap >= 20 && promotionIndividualBefore === 1 && openedPromotionLot === promotionLotId && promotionIndividualAfter === 0 && promotionMultiFiltersWork && materialOverlay && mobileOverflow <= 1 && mobileMaterialActions > 0 && mobilePublishedModal.visible && mobilePublishedModal.width === mobilePublishedModal.viewportWidth && mobilePublishedModal.height === mobilePublishedModal.viewportHeight && mobilePublishedModal.overflow <= 1 && excludedCardMarked === 1 && submitted && submitted.version === 4 && submitted.excluded_lot_ids.includes(excludedLotId) && submitted.rules.some((rule) => promotionTargets.every((target) => rule.floors.includes(String(target.floor)) && rule.apartment_numbers.includes(String(target.source_values.ApartmentNumber)))) && submitted.material_settings.logo === 'uploads/mat-qa-new.png' && submitted.material_settings.key_render === 'uploads/mat-qa-library.webp' && submitted.material_settings.background_render === 'uploads/mat-qa-library.webp' && submitted.material_settings.primary_color === '#123ABC' && submitted.material_settings.palette.some((color) => color.value === '#123ABC') && !submitted.material_settings.palette.some((color) => color.value === removedColor) && submitted.card_settings.show_key_render === false && submitted.card_settings.show_house_badge === false && submitted.card_settings.show_decoration === false && submitted.card_settings.show_logo_panel === false,
    errors,
    empty_draft: {
      cleared: redundantDraftCleared,
      publish_disabled: emptyPublishDisabled,
      status: emptyDraftStatus
    },
    published_changes: {
      button: publishedChangesButtonText,
      modal_visible: publishedChangesModalVisible,
      count: publishedChangesCount,
      categories: publishedChangeCategories,
      read_only: publishedChangesReadOnly,
      stale_rule_warned: stalePublishedRuleWarned,
      version: publishedChangeDate,
      details_work: publishedChangeDetailsWork
    },
    project_switching: {
      available: availableProjects.map((project) => project.slug),
      switched: switchedProjects,
      works: projectSwitchingWorks,
      refresh_persistence: projectRefreshPersistenceWorks
    },
    project_loading: {
      indicator_available: loadingIndicatorAvailable,
      data_requests: projectDataRequests,
      session_cache_works: projectSessionCacheWorks
    },
    feed_refresh_status: {
      button: refreshButtonText,
      source: sourceStateText,
      stale_manual_date_hidden: staleManualDateHidden
    },
    public_feed_href: publicFeedHref,
    source_feed_setting_works: sourceFeedSettingWorks,
    initial_cards: initialCards,
    active_before: activeBefore,
    cards_after_upload: cardsAfterUpload,
    material_delete: {
      available: unusedDeleteAvailable,
      deleted: unusedMaterialDeleted,
      built_in_available: builtInDeleteAvailable,
      built_in_deleted: builtInMaterialDeleted,
      cards_after: cardsAfterMaterialDelete,
      selected_delete_buttons: selectedMaterialDeleteButtons
    },
    visible_profitbase_mentions: visibleProfitbaseMentions,
    material_overlay: materialOverlay,
    card_options_default_on: cardOptionsDefaultOn,
    logo_panel: { default_off: logoPanelDefaultOff, toggle_works: logoPanelToggleWorks },
    live_material_preview: liveMaterialPreview,
    bulk_parameter_gap_px: bulkParameterGap,
    parameters: {
      individual_options: individualParameterOptions,
      bulk_options: bulkParameterOptions,
      bulk_description_shortcode_excluded: bulkDescriptionShortcodeExcluded,
      bulk_description_shortcodes_unique: bulkDescriptionShortcodesUnique,
      modal_description_shortcodes_unique: modalDescriptionShortcodesUnique,
      bulk_description_starts_empty: Boolean(bulkDescriptionStartsEmpty),
      bulk_description_expand_visible: bulkDescriptionExpandVisible,
      bulk_description_modal_visible: bulkDescriptionModalVisible,
      bulk_description_modal_size: bulkDescriptionModalSize,
      bulk_description_modal_shortcode_inserted: bulkDescriptionModalShortcodeInserted,
      bulk_description_content_preserved: bulkDescriptionContentPreserved,
      bulk_description_escape_closes: bulkDescriptionEscapeCloses,
      description_editor_visible: descriptionEditorVisible,
      description_shortcodes: descriptionShortcodes,
      individual_description_shortcodes_unique: individualDescriptionShortcodesUnique,
      stale_editable_rule_warned: staleEditableRuleWarned,
      description_shortcode_excluded: descriptionShortcodeExcluded,
      address_shown_fully: addressShownFully,
      address_option: addressOptionText,
      description_preview_visible: descriptionPreviewVisible,
      description_blocks_normalized: descriptionBlocksNormalized,
      description_formatting_preserved: descriptionFormattingPreserved,
      description_template_kept: descriptionTemplateKept,
      description_resolved: descriptionResolved,
      rooms_parameter_available: roomsParameterAvailable,
      required_text_parameters_available: requiredTextParametersAvailable,
      address_starts_from_source: addressStartsFromSource,
      new_development_id_is_text: developmentInputIsText,
      required_text_parameters_editable: requiredTextParametersEditable,
      rooms_starts_from_source: roomsStartsFromSource,
      studio_room_available: studioRoomAvailable,
      room_values_limited_to_five: roomValuesLimitedToFive,
      studio_room_filter_available: studioRoomFilterAvailable,
      rooms_shortcode_uses_override: roomsShortcodeUsesOverride,
      studio_filter_matches_override: studioFilterMatchesOverride,
      plan_options: planOptions,
      toolbar_layout: parameterToolbarLayout,
      selected_plan: selectedPlan,
      selected_plan_count: selectedPlanCount,
      lot_context: {
        works: parameterLotContextWorks,
        text: parameterContextText,
        image: parameterContextImage
      }
    },
    palette: {
      initial: initialPaletteCount,
      current_markers: currentPaletteMarkers,
      after_add: paletteAfterAdd,
      after_delete: paletteAfterDelete,
      selected: submitted && submitted.material_settings.primary_color,
      selected_status: selectedColorStatus,
      published_delete_buttons: publishedColorDeleteButtons,
      removed: removedColor
    },
    individual_rules: {
      images: { before: imageIndividualBefore, opened: openedImageLot, after: imageIndividualAfter },
      parameters: { before: parameterIndividualBefore, opened: openedParameterLot, after: parameterIndividualAfter },
      promotions: { before: promotionIndividualBefore, opened: openedPromotionLot, after: promotionIndividualAfter }
    },
    promotion_filters: {
      targets: promotionTargets.map((item) => ({ floor: String(item.floor), apartment: String(item.source_values.ApartmentNumber) })),
      floor_summary: floorMultiSummary,
      apartment_summary: apartmentMultiSummary,
      match_count: promotionFilteredMatchCount,
      works: promotionMultiFiltersWork
    },
    lot_selection: {
      preview_filters_work: previewFiltersWork,
      apartment_filter_sections_available: apartmentFilterSectionsAvailable,
      apartment_filter_count: apartmentFilterCount,
      apartment_filter_works: apartmentFilterWorks,
      chessboard_selected_ids: chessboardChosenIds,
      chessboard_works: chessboardSelectionWorks,
      image_mouse_drag_works: imageMouseDragWorks,
      bulk_image_hide_works: bulkImageHideWorks,
      bulk_image_hide_restores: bulkImageHideRestores,
      promotion_chessboard_works: promotionChessboardWorks
    },
    image_plan_filter: {
      library_starts_collapsed: libraryStartsCollapsed,
      library_cards_visible: libraryCardsVisible,
      library_lightbox_works: libraryLightboxWorks,
      gallery_lightbox_works: galleryLightboxWorks,
      parameter_lightbox_works: parameterLightboxWorks,
      library_delete_works: libraryDeleteWorks,
      obsolete_build_button_removed: obsoleteLibraryBuildButtonRemoved,
      library_lot_add_works: libraryLotAddWorks,
      duplicate_library_add_prevented: duplicateLibraryAddPrevented,
      duplicate_library_status: duplicateLibraryStatus,
      duplicate_library_image_count: duplicateLibraryImageCount,
      gallery_after_duplicate_library_add: galleryAfterDuplicateLibraryAdd,
      library_selection_add_works: librarySelectionAddWorks,
      library_singular_labels_work: librarySingularLabelsWork,
      individual_image_preserved_after_bulk_delete: individualImagePreservedAfterBulkDelete,
      gallery_after_library_rule_delete: galleryAfterLibraryRuleDelete,
      library_selection_status: librarySelectionStatus,
      mixed_library_add_works: mixedLibraryAddWorks,
      mixed_library_rule: mixedLibraryRuleText,
      mixed_first_gallery_with_rule: firstGalleryWithMixedRule,
      mixed_second_gallery_before_rule: secondGalleryBeforeMixedRule,
      mixed_second_gallery_with_rule: secondGalleryWithMixedRule,
      mixed_second_gallery_after_delete: secondGalleryAfterMixedRuleDelete,
      options: imagePlanOptions,
      selected: selectedImagePlan,
      selected_count: selectedImagePlanCount,
      bulk_rule_created: imagePlanRuleCreated,
      starts_collapsed: imageRuleStartsCollapsed,
      expands: imageRuleExpanded,
      scope_detailed: imageRuleScopeDetailed,
      action_detailed: imageRuleActionDetailed,
      added_image_moved: bulkAddedImageMoved,
      bulk_add_uploads: bulkImageUploads,
      bulk_add_rule_works: bulkImageAddRuleWorks,
      bulk_add_preview_works: bulkImageAddPreviewWorks
    },
    parameter_rule_details: {
      created: parameterRuleCreated,
      starts_collapsed: parameterRuleStartsCollapsed,
      expands: parameterRuleExpanded,
      scope_detailed: parameterRuleScopeDetailed,
      action_detailed: parameterRuleActionDetailed
    },
    mobile_overflow_px: mobileOverflow,
    mobile_overflow_by_view: mobileOverflowByView,
    mobile_published_changes: mobilePublishedModal,
    mobile_material_actions: mobileMaterialActions,
    excluded_lot_id: excludedLotId,
    excluded_card_marked: excludedCardMarked,
    submitted_materials: submitted && submitted.material_settings
  };
  result.ok = result.ok && previewToolbarLayout.planWidth <= 270 && previewToolbarLayout.aligned &&
    materialFiltersWork && materialToolbarLayout.planWidth <= 270 && materialToolbarLayout.aligned && promotionColorRolesWork &&
    liveMaterialPreview.promotionFrameColor === '#123ABC' && liveMaterialPreview.promotionTextColor === '#123ABC' &&
    submitted.material_settings.promotion_frame_color === '#123ABC' && submitted.material_settings.promotion_text_color === '#123ABC';
  result.preview_filters = { works: previewFiltersWork, layout: previewToolbarLayout };
  result.material_filters = { works: materialFiltersWork, layout: materialToolbarLayout };
  result.promotion_colors = {
    roles: promotionColorRolesWork,
    frame: liveMaterialPreview.promotionFrameColor,
    text: liveMaterialPreview.promotionTextColor
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.ok) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
