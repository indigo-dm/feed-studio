(function () {
  'use strict';

  var RUNTIME = window.FEED_STUDIO_RUNTIME || {};
  var REPOSITORY = String(RUNTIME.repository || 'indigo-dm/novyy-gorizont-feed');
  var DATA_ROOT = String(RUNTIME.dataRoot || '').replace(/\/$/, '');
  var SERVICE_ROOT = String(RUNTIME.serviceRoot || (DATA_ROOT ? DATA_ROOT.replace(/\/data$/, '') : '')).replace(/\/$/, '');
  var FEED_ROOT = String(RUNTIME.feedRoot || 'https://indigo-dm.github.io/feed-studio/feeds').replace(/\/$/, '');
  var state = {
    registry: null,
    project: null,
    inventory: null,
    status: null,
    assets: null,
    rules: [],
    publishedRules: [],
    imageSettings: { lot_overrides: {}, bulk_rules: [] },
    publishedImageSettings: { lot_overrides: {}, bulk_rules: [] },
    parameterSettings: { lot_values: {}, bulk_rules: [] },
    publishedParameterSettings: { lot_values: {}, bulk_rules: [] },
    materialSettings: { logo: '', key_render: '', primary_color: '', palette: [] },
    publishedMaterialSettings: { logo: '', key_render: '', primary_color: '', palette: [] },
    excludedLotIds: [],
    publishedExcludedLotIds: [],
    changeReviewItems: [],
    activeRuleId: null,
    activeView: 'dashboard',
    filters: { house: '', rooms: '', floor: '', search: '' },
    imageFilters: { house: '', rooms: '', floor: '', plan: '', search: '' },
    parameterFilters: { house: '', rooms: '', floor: '', plan: '', search: '' },
    page: 1,
    pageSize: 12,
    previewId: null,
    imageLotId: null,
    parameterLotId: null,
    imageUploadBusy: false,
    imageUploadMessage: '',
    imageUploadTone: '',
    materialUploadBusy: false,
    materialUploadMessage: '',
    materialUploadTone: '',
    pendingUploadDeletions: [],
    publishOperation: null,
    publishPollTimer: null,
    publishBusy: false,
    feedRefreshOperation: null,
    feedRefreshPollTimer: null,
    feedRefreshBusy: false,
    draftSaved: false,
    dirty: false
  };

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.from((root || document).querySelectorAll(selector)); };
  var esc = function (value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  };
  var safeColor = function (value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#000000';
  };
  var normalizeHexColor = function (value) {
    var candidate = String(value || '').trim().toUpperCase();
    if (/^[0-9A-F]{6}$/.test(candidate)) candidate = '#' + candidate;
    return /^#[0-9A-F]{6}$/.test(candidate) ? candidate : '';
  };
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  var cacheVersion = function () {
    return state.registry && state.registry.build_id ? String(state.registry.build_id) : 'development';
  };
  var dataUrl = function (url) {
    var value = String(url || '');
    if (!value || /^(?:https?:|data:|blob:)/i.test(value)) return value;
    return (DATA_ROOT ? DATA_ROOT + '/' : '') + value.replace(/^\/+/, '');
  };
  var versionedUrl = function (url) {
    var resolved = dataUrl(url);
    return resolved + (resolved.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(cacheVersion());
  };
  var RAW_DATA_ROOT = 'https://raw.githubusercontent.com/indigo-dm/novyy-gorizont-feed/feed-data/published';
  var absoluteUrl = function (url) {
    var value = dataUrl(url);
    if (!value) return '';
    try {
      return new URL(value, document.baseURI || window.location.href).href;
    } catch (error) {
      return value;
    }
  };
  var appendQuery = function (url, name, value) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') +
      encodeURIComponent(name) + '=' + encodeURIComponent(value);
  };

  async function requestJsonTarget(url) {
    var target = absoluteUrl(url);
    var lastError = null;
    for (var attempt = 0; attempt < 2; attempt += 1) {
      var requestUrl = attempt ? appendQuery(target, '_retry', Date.now()) : target;
      try {
        var response = await fetch(requestUrl, {
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'follow'
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var source = await response.text();
        if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1);
        if (!source.trim()) throw new Error('пустой ответ');
        try {
          return JSON.parse(source);
        } catch (parseError) {
          throw new Error('ответ не является JSON');
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('неизвестная ошибка');
  }

  async function requestJson(url, label, backupUrl) {
    try {
      return await requestJsonTarget(url);
    } catch (primaryError) {
      if (backupUrl) {
        try {
          return await requestJsonTarget(backupUrl);
        } catch (backupError) {
          throw new Error('Не удалось загрузить ' + label + ': ' + primaryError.message +
            '. Резервный источник: ' + backupError.message);
        }
      }
      throw new Error('Не удалось загрузить ' + label + ': ' + primaryError.message);
    }
  }

  async function loadRegistry() {
    return requestJson(
      appendQuery(dataUrl('projects.json'), 'v', Date.now()),
      'список объектов',
      appendQuery(RAW_DATA_ROOT + '/projects.json', 'v', Date.now())
    );
  }
  var draftKey = function () { return 'feed-studio-rules-v1-' + (state.project ? state.project.slug : 'default'); };
  var operationKey = function () { return 'feed-studio-publish-v1-' + (state.project ? state.project.slug : 'default'); };
  var feedRefreshKey = function () { return 'feed-studio-profitbase-refresh-v1-' + (state.project ? state.project.slug : 'default'); };
  var formatPrice = function (value) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value)) + ' ₽';
  };
  var formatArea = function (value) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value)) + ' м²';
  };
  var formatDateTime = function (value) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    }).format(date);
  };
  var DESCRIPTION_TAG = 'Description';
  var DESCRIPTION_TAGS = ['P', 'BR', 'STRONG', 'EM', 'UL', 'OL', 'LI'];
  var shortcodeLabels = {
    Id: 'ID лота', NewDevelopmentId: 'ID новостройки', Rooms: 'Комнат', Square: 'Площадь',
    Floor: 'Этаж', Floors: 'Этажей в доме', Price: 'Цена', Decoration: 'Отделка',
    Address: 'Адрес', Category: 'Категория', OperationType: 'Тип сделки', Description: 'Исходное описание',
    id: 'ID лота', house: 'Дом', rooms: 'Комнат', area: 'Площадь', floor: 'Этаж', floors: 'Этажей в доме',
    price: 'Цена', decoration: 'Отделка'
  };
  var expandedDescriptionEditor = null;
  var emptyImageSettings = function () { return { lot_overrides: {}, bulk_rules: [] }; };
  var emptyParameterSettings = function () { return { lot_values: {}, bulk_rules: [] }; };
  var emptyMaterialSettings = function () { return { logo: '', key_render: '', primary_color: '', palette: [] }; };

  function projectIsReady(project) {
    return Boolean(project && (project.available || project.status === 'active'));
  }

  function itemMatchesFilters(item, filters) {
    var search = String(filters.search || '').trim().toLowerCase();
    return (!filters.house || item.house_id === filters.house) &&
      (!filters.rooms || item.rooms === filters.rooms) &&
      (!filters.floor || String(item.floor) === filters.floor) &&
      (!filters.plan || String(item.plan_id) === filters.plan) &&
      (!search || item.id.toLowerCase().indexOf(search) >= 0);
  }

  function ruleMatchesSimple(item, rule) {
    if ((rule.exclude_ids || []).indexOf(String(item.id)) >= 0) return false;
    if ((rule.include_ids || []).length && (rule.include_ids || []).indexOf(String(item.id)) < 0) return false;
    if ((rule.house_ids || []).length && (rule.house_ids || []).indexOf(String(item.house_id)) < 0) return false;
    if ((rule.rooms || []).length && (rule.rooms || []).indexOf(String(item.rooms)) < 0) return false;
    if ((rule.floors || []).length && (rule.floors || []).indexOf(String(item.floor)) < 0) return false;
    if ((rule.plan_ids || []).length && (rule.plan_ids || []).indexOf(String(item.plan_id)) < 0) return false;
    var area = Number(item.area);
    if (rule.area_min != null && area < Number(rule.area_min)) return false;
    if (rule.area_max != null && area > Number(rule.area_max)) return false;
    return true;
  }

  function filterRuleFrom(filters, items) {
    return {
      house_ids: filters.house ? [filters.house] : [],
      rooms: filters.rooms ? [filters.rooms] : [],
      floors: filters.floor ? [filters.floor] : [],
      plan_ids: filters.plan ? [filters.plan] : [],
      area_min: null,
      area_max: null,
      include_ids: filters.search ? items.map(function (item) { return item.id; }) : [],
      exclude_ids: []
    };
  }

  function normalizeImageSettings(value) {
    var source = value && typeof value === 'object' ? value : {};
    return {
      lot_overrides: source.lot_overrides && typeof source.lot_overrides === 'object' ? clone(source.lot_overrides) : {},
      bulk_rules: Array.isArray(source.bulk_rules) ? clone(source.bulk_rules) : []
    };
  }

  function normalizeParameterSettings(value) {
    var source = value && typeof value === 'object' ? value : {};
    return {
      lot_values: source.lot_values && typeof source.lot_values === 'object' ? clone(source.lot_values) : {},
      bulk_rules: Array.isArray(source.bulk_rules) ? clone(source.bulk_rules) : []
    };
  }

  function normalizeMaterialSettings(value, assets) {
    var source = value && typeof value === 'object' ? value : {};
    var current = assets && assets.current && typeof assets.current === 'object' ? assets.current : {};
    var brand = assets && assets.brand && typeof assets.brand === 'object' ? assets.brand : {};
    var items = assets && Array.isArray(assets.items) ? assets.items : [];
    var legacyLogo = items.find(function (item) { return item.key === 'logo'; });
    var legacyRender = items.find(function (item) { return item.key === 'key_render'; });
    var fallbackPalette = Array.isArray(brand.palette) && brand.palette.length ? brand.palette : [
      { name: 'Основной', value: brand.green },
      { name: 'Акцент', value: brand.gold },
      { name: 'Серый', value: brand.gray },
      { name: 'Белый', value: brand.white }
    ];
    var sourcePalette = Array.isArray(source.palette) && source.palette.length ? source.palette : fallbackPalette;
    var seen = new Set();
    var palette = sourcePalette.map(function (color, index) {
      var item = color && typeof color === 'object' ? color : { value: color };
      var normalized = normalizeHexColor(item.value);
      if (!normalized || seen.has(normalized)) return null;
      seen.add(normalized);
      return { name: String(item.name || ('Цвет ' + (index + 1))).slice(0, 48), value: normalized };
    }).filter(Boolean);
    var primary = normalizeHexColor(source.primary_color) || normalizeHexColor(brand.green) || (palette[0] && palette[0].value) || '#000000';
    if (!seen.has(primary)) palette.unshift({ name: 'Основной', value: primary });
    return {
      logo: String(source.logo || current.logo || (legacyLogo && legacyLogo.filename) || ''),
      key_render: String(source.key_render || current.key_render || (legacyRender && legacyRender.filename) || ''),
      primary_color: primary,
      palette: palette
    };
  }

  function emptyRule() {
    return {
      id: 'promotion-' + Date.now(),
      name: 'Новая акция',
      enabled: false,
      label: 'Скидка',
      text: '−10 000 ₽/м²',
      house_ids: [],
      rooms: [],
      area_min: null,
      area_max: null,
      starts_at: '',
      ends_at: '',
      include_ids: [],
      exclude_ids: []
    };
  }

  function normalizeRule(rule) {
    return {
      id: String(rule.id || ('promotion-' + Date.now())).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64),
      name: String(rule.name || 'Акция').slice(0, 80),
      enabled: Boolean(rule.enabled),
      label: String(rule.label || 'Акция').slice(0, 24),
      text: String(rule.text || '').slice(0, 60),
      house_ids: Array.isArray(rule.house_ids) ? rule.house_ids.map(String) : [],
      rooms: Array.isArray(rule.rooms) ? rule.rooms.map(String) : [],
      area_min: rule.area_min === '' || rule.area_min == null ? null : Number(rule.area_min),
      area_max: rule.area_max === '' || rule.area_max == null ? null : Number(rule.area_max),
      starts_at: String(rule.starts_at || ''),
      ends_at: String(rule.ends_at || ''),
      include_ids: Array.isArray(rule.include_ids) ? rule.include_ids.map(String) : [],
      exclude_ids: Array.isArray(rule.exclude_ids) ? rule.exclude_ids.map(String) : []
    };
  }

  function showToast(message) {
    var toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(function () { toast.classList.remove('show'); }, 3200);
  }

  function fallbackCopyText(value) {
    return new Promise(function (resolve, reject) {
      var field = document.createElement('textarea');
      field.value = String(value || '');
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.left = '-9999px';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.focus();
      field.select();
      field.setSelectionRange(0, field.value.length);
      var copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (error) {
        copied = false;
      }
      document.body.removeChild(field);
      if (copied) resolve();
      else reject(new Error('Clipboard is unavailable'));
    });
  }

  function copyText(value) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(String(value || '')).catch(function () {
        return fallbackCopyText(value);
      });
    }
    return fallbackCopyText(value);
  }

  function renderSavedState() {
    var label = $('#saved-state');
    if (!label) return;
    var pendingChanges = collectUnsavedChanges().length;
    if (!pendingChanges && (state.dirty || state.draftSaved)) {
      state.dirty = false;
      state.draftSaved = false;
      if (state.project) localStorage.removeItem(draftKey());
    }
    var publishButton = $('#publish-settings');
    var publishInProgress = Boolean(state.publishOperation && ['queued', 'building'].indexOf(state.publishOperation.status) >= 0);
    if (publishButton) {
      publishButton.disabled = !pendingChanges || publishInProgress;
      publishButton.title = pendingChanges ? '' : 'Нет изменений для применения';
    }
    label.className = 'saved-state';
    if (publishInProgress) {
      label.textContent = state.publishOperation.status === 'queued' ? 'Настройки приняты · ожидают сборки' : 'Фид пересобирается…';
      label.classList.add('processing');
      return;
    }
    if (state.publishOperation && state.publishOperation.status === 'failed') {
      label.textContent = 'Изменения не применены · повторите';
      label.classList.add('error');
      return;
    }
    if (state.publishOperation && state.publishOperation.status === 'published') {
      label.textContent = 'Изменения применены · ' + formatDateTime(state.publishOperation.completedAt);
      label.classList.add('success');
      return;
    }
    if (state.dirty) {
      label.textContent = 'Есть несохранённые изменения';
      label.classList.add('unsaved');
      return;
    }
    if (state.draftSaved) {
      label.textContent = 'Черновик сохранён · не применён';
      return;
    }
    label.textContent = state.status && state.status.checked_at ? 'Фид опубликован · ' + formatDateTime(state.status.checked_at) : 'Настройки загружены';
    label.classList.add('success');
  }

  function setDirty(value) {
    state.dirty = value;
    if (value) {
      state.draftSaved = false;
      if (state.publishOperation && ['published', 'failed'].indexOf(state.publishOperation.status) >= 0) {
        state.publishOperation = null;
        if (state.project) localStorage.removeItem(operationKey());
      }
    }
    renderSavedState();
    renderUnsavedChangeButton();
  }

  function saveDraft(showMessage) {
    if (!collectUnsavedChanges().length) {
      if (state.project) localStorage.removeItem(draftKey());
      state.dirty = false;
      state.draftSaved = false;
      renderSavedState();
      renderUnsavedChangeButton();
      if (showMessage) showToast('Нет изменений для сохранения');
      return false;
    }
    localStorage.setItem(draftKey(), JSON.stringify({
      version: 3,
      rules: state.rules,
      image_settings: state.imageSettings,
      parameter_settings: state.parameterSettings,
      material_settings: state.materialSettings,
      excluded_lot_ids: state.excludedLotIds,
      pending_upload_deletions: state.pendingUploadDeletions
    }));
    state.dirty = false;
    state.draftSaved = true;
    renderSavedState();
    renderUnsavedChangeButton();
    if (showMessage) showToast('Черновик сохранён в этом браузере');
    return true;
  }

  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function lotChangeLabel(lotId) {
    var item = state.inventory && state.inventory.items.find(function (lot) { return String(lot.id) === String(lotId); });
    return item ? item.house + ' · ' + item.rooms + 'к · ID ' + item.id : 'ID ' + lotId;
  }

  function commonOrderChanged(current, published) {
    var currentIds = current.map(function (item) { return String(item.id); });
    var publishedIds = published.map(function (item) { return String(item.id); });
    var currentSet = new Set(currentIds);
    var publishedSet = new Set(publishedIds);
    return !sameValue(
      currentIds.filter(function (id) { return publishedSet.has(id); }),
      publishedIds.filter(function (id) { return currentSet.has(id); })
    );
  }

  function collectUnsavedChanges() {
    if (!state.project) return [];
    var changes = [];
    var add = function (kind, key, category, title, detail) {
      changes.push({ id: kind + '::' + key, kind: kind, key: String(key), category: category, title: title, detail: detail });
    };
    var collectArrayEntries = function (current, published, kind, category, titleFor, detailFor) {
      var currentById = new Map(current.map(function (item) { return [String(item.id), item]; }));
      var publishedById = new Map(published.map(function (item) { return [String(item.id), item]; }));
      var ids = new Set(Array.from(currentById.keys()).concat(Array.from(publishedById.keys())));
      ids.forEach(function (id) {
        var currentItem = currentById.get(id);
        var publishedItem = publishedById.get(id);
        if (!sameValue(currentItem, publishedItem)) {
          add(kind, id, category, titleFor(currentItem || publishedItem), detailFor(currentItem, publishedItem));
        }
      });
    };

    collectArrayEntries(state.rules, state.publishedRules, 'promotion', 'Акции', function (rule) {
      return rule.name || 'Правило акции';
    }, function (current, published) {
      return !published ? 'Добавлено новое правило.' : !current ? 'Опубликованное правило удалено.' : 'Изменены текст, состояние или условия применения.';
    });
    if (commonOrderChanged(state.rules, state.publishedRules)) add('promotion-order', 'order', 'Акции', 'Порядок правил акций', 'Изменён приоритет применения правил.');

    var currentImageLots = state.imageSettings.lot_overrides || {};
    var publishedImageLots = state.publishedImageSettings.lot_overrides || {};
    new Set(Object.keys(currentImageLots).concat(Object.keys(publishedImageLots))).forEach(function (lotId) {
      if (!sameValue(currentImageLots[lotId], publishedImageLots[lotId])) {
        add('image-lot', lotId, 'Изображения', lotChangeLabel(lotId), 'Изменены порядок, исключения или добавленные изображения лота.');
      }
    });
    collectArrayEntries(state.imageSettings.bulk_rules || [], state.publishedImageSettings.bulk_rules || [], 'image-bulk', 'Изображения', function (rule) {
      return rule.name || 'Массовое правило изображений';
    }, function (current, published) {
      return !published ? 'Добавлено массовое правило.' : !current ? 'Опубликованное массовое правило удалено.' : 'Изменены условия или порядок изображений.';
    });
    if (commonOrderChanged(state.imageSettings.bulk_rules || [], state.publishedImageSettings.bulk_rules || [])) {
      add('image-bulk-order', 'order', 'Изображения', 'Порядок массовых правил изображений', 'Изменён приоритет массовых правил.');
    }

    var currentParameterLots = state.parameterSettings.lot_values || {};
    var publishedParameterLots = state.publishedParameterSettings.lot_values || {};
    new Set(Object.keys(currentParameterLots).concat(Object.keys(publishedParameterLots))).forEach(function (lotId) {
      if (!sameValue(currentParameterLots[lotId], publishedParameterLots[lotId])) {
        var tags = Object.keys(currentParameterLots[lotId] || publishedParameterLots[lotId] || {}).join(', ');
        add('parameter-lot', lotId, 'Параметры', lotChangeLabel(lotId), 'Изменены параметры Avito' + (tags ? ': ' + tags + '.' : '.'));
      }
    });
    collectArrayEntries(state.parameterSettings.bulk_rules || [], state.publishedParameterSettings.bulk_rules || [], 'parameter-bulk', 'Параметры', function (rule) {
      return rule.name || 'Массовое правило параметров';
    }, function (current, published) {
      return !published ? 'Добавлено массовое правило.' : !current ? 'Опубликованное массовое правило удалено.' : 'Изменены значения или условия выборки.';
    });
    if (commonOrderChanged(state.parameterSettings.bulk_rules || [], state.publishedParameterSettings.bulk_rules || [])) {
      add('parameter-bulk-order', 'order', 'Параметры', 'Порядок массовых правил параметров', 'Изменён приоритет массовых правил.');
    }

    if (!sameValue(state.materialSettings, state.publishedMaterialSettings)) {
      var materialParts = [];
      if (state.materialSettings.logo !== state.publishedMaterialSettings.logo) materialParts.push('логотип');
      if (state.materialSettings.key_render !== state.publishedMaterialSettings.key_render) materialParts.push('ключевой рендер');
      if (state.materialSettings.primary_color !== state.publishedMaterialSettings.primary_color) materialParts.push('основной цвет');
      if (!sameValue(state.materialSettings.palette, state.publishedMaterialSettings.palette)) materialParts.push('палитра');
      add('materials', 'project', 'Материалы', 'Фирменные материалы проекта', 'Изменено: ' + materialParts.join(', ') + '.');
    }

    var currentExcluded = new Set(state.excludedLotIds.map(String));
    var publishedExcluded = new Set(state.publishedExcludedLotIds.map(String));
    new Set(Array.from(currentExcluded).concat(Array.from(publishedExcluded))).forEach(function (lotId) {
      if (currentExcluded.has(lotId) !== publishedExcluded.has(lotId)) {
        add('excluded-lot', lotId, 'Состав фида', lotChangeLabel(lotId), currentExcluded.has(lotId) ? 'Лот исключён из результирующего фида.' : 'Лот возвращён в результирующий фид.');
      }
    });
    state.pendingUploadDeletions.forEach(function (item) {
      var key = String(item.path || (item.lot + '/' + item.id));
      add('pending-deletion', key, 'Файлы', lotChangeLabel(item.lot), 'Загруженное изображение отмечено для физического удаления.');
    });
    return changes;
  }

  function renderUnsavedChangeButton() {
    var button = $('#review-unsaved');
    if (!button) return;
    var count = collectUnsavedChanges().length;
    button.textContent = count ? 'Несохранённые изменения · ' + count : 'Посмотреть несохранённые изменения';
    button.classList.toggle('has-changes', count > 0);
  }

  function renderChangeReviewModal() {
    state.changeReviewItems = collectUnsavedChanges();
    var list = $('#change-review-list');
    var count = state.changeReviewItems.length;
    $('#change-review-count').textContent = count + ' ' + (count === 1 ? 'изменение' : count < 5 ? 'изменения' : 'изменений');
    $('#select-all-changes').checked = false;
    $('#select-all-changes').indeterminate = false;
    $('#select-all-changes').disabled = !count;
    $('#remove-selected-changes').disabled = true;
    $('#clear-unsaved').disabled = !count;
    if (!count) {
      list.innerHTML = '<div class="change-review-empty">Проект совпадает с опубликованными настройками.</div>';
      return;
    }
    list.innerHTML = state.changeReviewItems.map(function (change) {
      return '<label class="change-review-item"><input type="checkbox" value="' + esc(change.id) + '"><span class="change-review-copy"><strong>' +
        esc(change.title) + '</strong><span>' + esc(change.category) + '</span><small>' + esc(change.detail) + '</small></span></label>';
    }).join('');
    $$('input[type="checkbox"]', list).forEach(function (checkbox) {
      checkbox.addEventListener('change', syncChangeReviewSelection);
    });
  }

  function syncChangeReviewSelection() {
    var boxes = $$('input[type="checkbox"]', $('#change-review-list'));
    var selected = boxes.filter(function (box) { return box.checked; }).length;
    $('#remove-selected-changes').disabled = !selected;
    $('#select-all-changes').checked = Boolean(boxes.length && selected === boxes.length);
    $('#select-all-changes').indeterminate = Boolean(selected && selected < boxes.length);
  }

  function restoreArrayEntry(current, published, id) {
    var currentIndex = current.findIndex(function (item) { return String(item.id) === String(id); });
    var publishedIndex = published.findIndex(function (item) { return String(item.id) === String(id); });
    if (publishedIndex < 0) {
      if (currentIndex >= 0) current.splice(currentIndex, 1);
      return;
    }
    if (currentIndex >= 0) current[currentIndex] = clone(published[publishedIndex]);
    else current.splice(Math.min(publishedIndex, current.length), 0, clone(published[publishedIndex]));
  }

  function restoreCommonOrder(current, published) {
    var currentById = new Map(current.map(function (item) { return [String(item.id), item]; }));
    var publishedIds = new Set(published.map(function (item) { return String(item.id); }));
    var restored = published.map(function (item) { return currentById.get(String(item.id)); }).filter(Boolean);
    return restored.concat(current.filter(function (item) { return !publishedIds.has(String(item.id)); }));
  }

  function revertChange(change) {
    var published;
    if (change.kind === 'promotion') restoreArrayEntry(state.rules, state.publishedRules, change.key);
    else if (change.kind === 'promotion-order') state.rules = restoreCommonOrder(state.rules, state.publishedRules);
    else if (change.kind === 'image-lot') {
      published = state.publishedImageSettings.lot_overrides[change.key];
      if (published == null) delete state.imageSettings.lot_overrides[change.key];
      else state.imageSettings.lot_overrides[change.key] = clone(published);
    } else if (change.kind === 'image-bulk') restoreArrayEntry(state.imageSettings.bulk_rules, state.publishedImageSettings.bulk_rules, change.key);
    else if (change.kind === 'image-bulk-order') state.imageSettings.bulk_rules = restoreCommonOrder(state.imageSettings.bulk_rules, state.publishedImageSettings.bulk_rules);
    else if (change.kind === 'parameter-lot') {
      published = state.publishedParameterSettings.lot_values[change.key];
      if (published == null) delete state.parameterSettings.lot_values[change.key];
      else state.parameterSettings.lot_values[change.key] = clone(published);
    } else if (change.kind === 'parameter-bulk') restoreArrayEntry(state.parameterSettings.bulk_rules, state.publishedParameterSettings.bulk_rules, change.key);
    else if (change.kind === 'parameter-bulk-order') state.parameterSettings.bulk_rules = restoreCommonOrder(state.parameterSettings.bulk_rules, state.publishedParameterSettings.bulk_rules);
    else if (change.kind === 'materials') state.materialSettings = clone(state.publishedMaterialSettings);
    else if (change.kind === 'excluded-lot') {
      var shouldBeExcluded = state.publishedExcludedLotIds.indexOf(change.key) >= 0;
      state.excludedLotIds = state.excludedLotIds.filter(function (id) { return String(id) !== change.key; });
      if (shouldBeExcluded) state.excludedLotIds.push(change.key);
    } else if (change.kind === 'pending-deletion') {
      state.pendingUploadDeletions = state.pendingUploadDeletions.filter(function (item) {
        return String(item.path || (item.lot + '/' + item.id)) !== change.key;
      });
    }
  }

  function finalizeRevertedChanges() {
    state.activeRuleId = state.rules.some(function (rule) { return rule.id === state.activeRuleId; }) ? state.activeRuleId : (state.rules[0] && state.rules[0].id || null);
    var remaining = collectUnsavedChanges();
    if (!remaining.length) {
      localStorage.removeItem(draftKey());
      state.dirty = false;
      state.draftSaved = false;
    } else {
      saveDraft(false);
    }
    renderAll();
    renderSavedState();
    renderChangeReviewModal();
  }

  function removeSelectedChanges() {
    var selected = new Set($$('input[type="checkbox"]:checked', $('#change-review-list')).map(function (box) { return box.value; }));
    if (!selected.size) return;
    state.changeReviewItems.filter(function (change) { return selected.has(change.id); }).forEach(revertChange);
    finalizeRevertedChanges();
    showToast('Выбранные изменения удалены из черновика');
  }

  function clearAllUnsavedChanges() {
    if (!state.changeReviewItems.length) return;
    if (!window.confirm('Очистить все несохранённые изменения и вернуть опубликованные настройки проекта?')) return;
    state.rules = clone(state.publishedRules);
    state.imageSettings = clone(state.publishedImageSettings);
    state.parameterSettings = clone(state.publishedParameterSettings);
    state.materialSettings = clone(state.publishedMaterialSettings);
    state.excludedLotIds = clone(state.publishedExcludedLotIds);
    state.pendingUploadDeletions = [];
    localStorage.removeItem(draftKey());
    state.dirty = false;
    state.draftSaved = false;
    state.activeRuleId = state.rules[0] ? state.rules[0].id : null;
    renderAll();
    renderSavedState();
    renderChangeReviewModal();
    showToast('Все несохранённые изменения очищены');
  }

  function openChangesModal() {
    renderChangeReviewModal();
    $('#changes-modal').classList.remove('hidden');
  }

  function ruleMatches(item, rule, ignoreExcluded) {
    var today = new Date().toISOString().slice(0, 10);
    if (rule.starts_at && today < rule.starts_at) return false;
    if (rule.ends_at && today > rule.ends_at) return false;
    if (!ignoreExcluded && rule.exclude_ids.indexOf(String(item.id)) >= 0) return false;
    if (rule.include_ids.length && rule.include_ids.indexOf(String(item.id)) < 0) return false;
    if (rule.house_ids.length && rule.house_ids.indexOf(String(item.house_id)) < 0) return false;
    if (rule.rooms.length && rule.rooms.indexOf(String(item.rooms)) < 0) return false;
    var area = Number(item.area);
    if (rule.area_min != null && area < Number(rule.area_min)) return false;
    if (rule.area_max != null && area > Number(rule.area_max)) return false;
    return true;
  }

  function appliedRule(item) {
    if (state.excludedLotIds.indexOf(String(item.id)) >= 0) return null;
    return state.rules.find(function (rule) { return rule.enabled && ruleMatches(item, rule, false); }) || null;
  }

  function lotById(id) {
    return state.inventory && state.inventory.items.find(function (item) { return String(item.id) === String(id); });
  }

  function lotCaption(id) {
    var item = lotById(id);
    return item ? item.house + ' · ' + item.rooms + 'к · ' + formatArea(item.area) : 'Нет в текущем фиде Profitbase';
  }

  function openIndividualLot(section, id) {
    var item = lotById(id);
    if (!item) {
      showToast('Лота ID ' + id + ' уже нет в текущем фиде Profitbase. Настройку можно удалить из списка.');
      return;
    }
    if (section === 'images') {
      state.imageFilters = { house: '', rooms: '', floor: '', plan: '', search: String(id) };
      state.imageLotId = String(id);
      $('#image-filter-house').value = '';
      $('#image-filter-rooms').value = '';
      $('#image-filter-floor').value = '';
      $('#image-filter-plan').value = '';
      $('#image-filter-search').value = String(id);
      navigate('images');
      renderImages();
      $('#image-lot').focus();
      return;
    }
    if (section === 'parameters') {
      state.parameterFilters = { house: '', rooms: '', floor: '', plan: '', search: String(id) };
      state.parameterLotId = String(id);
      $('#parameter-filter-house').value = '';
      $('#parameter-filter-rooms').value = '';
      $('#parameter-filter-floor').value = '';
      $('#parameter-filter-plan').value = '';
      $('#parameter-filter-search').value = String(id);
      navigate('parameters');
      renderParameters();
      $('#parameter-lot').focus();
      return;
    }
    state.previewId = String(id);
    navigate('preview');
    renderPreview();
    $('#preview-lot').focus();
  }

  function navigate(view) {
    state.activeView = view;
    $$('.nav-item').forEach(function (button) {
      button.classList.toggle('active', button.dataset.view === view);
    });
    $$('.view').forEach(function (section) {
      section.classList.toggle('active', section.id === 'view-' + view);
    });
    var titles = { dashboard: 'Обзор', lots: 'Квартиры', images: 'Изображения', parameters: 'Параметры', promotions: 'Акции', assets: 'Материалы', preview: 'Предпросмотр' };
    $('#page-title').textContent = titles[view] || 'Управление фидом';
    window.location.hash = view;
    if (view === 'preview') renderPreview();
    if (view === 'assets') renderAssets();
    if (view === 'images') renderImages();
    if (view === 'parameters') renderParameters();
  }

  function renderProjectChrome() {
    if (!state.project || !state.inventory) return;
    $('#project-name').textContent = state.project.name;
    document.title = state.project.name + ' — Feed Studio';
    $('#project-select').value = state.project.slug;
    var projectBase = dataUrl(state.project.base);
    $('#source-feed-link').href = projectBase + '/source-profitbase.xml';
    $('#full-feed-link').href = FEED_ROOT + '/' + encodeURIComponent(state.project.slug) + '/avito.xml';
    $('#pilot-feed-link').href = projectBase + '/pilot-avito.xml';
    var mobileFeedLinks = window.matchMedia && window.matchMedia('(max-width: 860px)').matches;
    var feedLinkAction = mobileFeedLinks ? ' · копировать' : ' ↗';
    $('#source-feed-link').textContent = 'Полученный фид из Profitbase' + feedLinkAction;
    $('#full-feed-link').textContent = 'Полный фид · ' + state.inventory.full_ads + ' квартир' + feedLinkAction;
    $('#pilot-feed-link').textContent = 'Тестовый фид · ' + state.status.unique_plans + ' планировок' + feedLinkAction;
    if (state.assets && state.assets.brand) {
      document.documentElement.style.setProperty('--project-gold', state.assets.brand.gold);
      document.documentElement.style.setProperty('--project-ink', state.assets.brand.green_dark);
    }
  }

  function renderAssets() {
    if (!state.assets) return;
    $('#asset-grid').innerHTML = state.assets.items.map(function (asset) {
      var preview = asset.exists ? '<img src="' + esc(versionedUrl(asset.url)) + '" alt="' + esc(asset.name) + '" loading="lazy" decoding="async">' :
        '<div class="asset-missing">Файл не загружен</div>';
      var roles = [];
      if (state.materialSettings.logo === asset.filename) roles.push('Логотип');
      if (state.materialSettings.key_render === asset.filename) roles.push('Ключевой рендер');
      var status = roles.length ? 'Используется: ' + roles.join(' · ') : (asset.exists ? 'В библиотеке' : 'Файл отсутствует');
      var actionButtons = asset.exists ?
        (state.materialSettings.logo === asset.filename ? '' : '<button class="button button-secondary button-small" data-use-material="logo" data-material-file="' + esc(asset.filename) + '">Сделать логотипом</button>') +
        (state.materialSettings.key_render === asset.filename ? '' : '<button class="button button-secondary button-small" data-use-material="key_render" data-material-file="' + esc(asset.filename) + '">Сделать рендером</button>') : '';
      var actions = actionButtons ? '<div class="asset-footer"><div class="asset-actions">' + actionButtons + '</div></div>' : '';
      return '<article class="asset-card ' + (roles.length ? 'active' : '') + '"><div class="asset-preview">' + preview + '<div class="asset-copy"><div><strong>' +
        esc(asset.name) + '</strong><span class="asset-status ' + (roles.length ? 'active' : (asset.exists ? 'ready' : '')) + '">' +
        esc(status) + '</span></div><p>' + esc(asset.description || 'Загруженный фирменный материал объекта.') + '</p><code>' +
        esc(asset.filename) + '</code></div></div>' + actions + '</article>';
    }).join('');
    $$('[data-use-material]', $('#asset-grid')).forEach(function (button) {
      button.addEventListener('click', function () {
        state.materialSettings[button.dataset.useMaterial] = button.dataset.materialFile;
        setDirty(true);
        renderAssets();
        showToast(button.dataset.useMaterial === 'logo' ? 'Логотип выбран и уже доступен в предпросмотре' : 'Рендер выбран и уже доступен в предпросмотре');
      });
    });
    var palette = state.materialSettings.palette || [];
    var publishedPrimary = normalizeHexColor(state.assets.brand.green);
    var selectedPrimary = normalizeHexColor(state.materialSettings.primary_color);
    $('#brand-palette').innerHTML = palette.map(function (color) {
      var value = safeColor(color.value);
      var isPublished = value.toUpperCase() === publishedPrimary;
      var isSelected = value.toUpperCase() === selectedPrimary;
      var status = isPublished && isSelected ? 'Используется' : isPublished ? 'Используется сейчас' : isSelected ? 'Выбран после публикации' : '';
      var actions = '<div class="palette-actions">' +
        (isSelected ? '' : '<button data-use-brand-color="' + esc(value.toUpperCase()) + '">Сделать основным</button>') +
        (!isPublished && !isSelected ? '<button class="danger" data-delete-brand-color="' + esc(value.toUpperCase()) + '">Удалить</button>' : '') +
        '</div>';
      return '<div class="palette-item ' + (isSelected ? 'selected' : '') + ' ' + (isPublished ? 'published' : '') + '"><span class="palette-swatch" style="background:' +
        value + '"></span><div class="palette-copy"><strong>' + esc(color.name) + '</strong><code>' + esc(value.toUpperCase()) + '</code>' +
        (status ? '<span class="palette-status">' + esc(status) + '</span>' : '') + '</div>' + actions + '</div>';
    }).join('');
    $$('[data-use-brand-color]', $('#brand-palette')).forEach(function (button) {
      button.addEventListener('click', function () {
        state.materialSettings.primary_color = button.dataset.useBrandColor;
        setDirty(true);
        renderAssets();
        showToast('Цвет виден в предпросмотре сразу, а в фиде применится после публикации.');
      });
    });
    $$('[data-delete-brand-color]', $('#brand-palette')).forEach(function (button) {
      button.addEventListener('click', function () {
        var value = button.dataset.deleteBrandColor;
        if (!window.confirm('Удалить цвет ' + value + ' из палитры проекта?')) return;
        state.materialSettings.palette = state.materialSettings.palette.filter(function (color) {
          return normalizeHexColor(color.value) !== value;
        });
        setDirty(true);
        renderAssets();
      });
    });
    renderMaterialUploadState();
  }

  function addBrandColor() {
    var input = $('#new-brand-color');
    var value = normalizeHexColor(input.value);
    if (!value) {
      showToast('Укажите цвет в формате #RRGGBB, например #7E3FF2.');
      input.focus();
      return;
    }
    if (state.materialSettings.palette.some(function (color) { return normalizeHexColor(color.value) === value; })) {
      showToast('Такой цвет уже есть в палитре проекта.');
      input.focus();
      return;
    }
    if (state.materialSettings.palette.length >= 24) {
      showToast('В палитре может быть не более 24 цветов.');
      return;
    }
    state.materialSettings.palette.push({ name: 'Пользовательский цвет', value: value });
    input.value = '';
    setDirty(true);
    renderAssets();
    showToast('Цвет добавлен. Теперь его можно сделать основным.');
  }

  function renderStats() {
    $('#stat-source').textContent = state.inventory.source_ads;
    $('#stat-plans').textContent = state.inventory.items.filter(function (item) {
      return state.excludedLotIds.indexOf(String(item.id)) < 0;
    }).length;
    $('#stat-promotions').textContent = state.rules.filter(function (rule) { return rule.enabled; }).length;
    $('#stat-updated').textContent = formatDateTime(state.inventory.checked_at);
    if (state.inventory.items[0]) {
      $('#dashboard-preview').src = versionedUrl(state.inventory.items[0].image);
    }
  }

  function populateFilters() {
    var houses = new Map();
    var rooms = new Set();
    var floors = new Set();
    var plans = new Map();
    state.inventory.items.forEach(function (item) {
      houses.set(String(item.house_id), item.house);
      rooms.add(String(item.rooms));
      floors.add(String(item.floor));
      var planKey = String(item.plan_id || '');
      if (planKey) {
        var plan = plans.get(planKey) || { rooms: item.rooms, area: item.area, count: 0 };
        plan.count += 1;
        plans.set(planKey, plan);
      }
    });
    var houseOptions = '<option value="">Все дома</option>' +
      Array.from(houses.entries()).map(function (entry) {
        return '<option value="' + esc(entry[0]) + '">' + esc(entry[1]) + '</option>';
      }).join('');
    var roomOptions = '<option value="">Любая</option>' +
      Array.from(rooms).sort().map(function (room) {
        return '<option value="' + esc(room) + '">' + esc(room) + '-комнатная</option>';
      }).join('');
    var floorOptions = '<option value="">Любой</option>' +
      Array.from(floors).sort(function (left, right) { return Number(left) - Number(right); }).map(function (floor) {
        return '<option value="' + esc(floor) + '">' + esc(floor) + '</option>';
      }).join('');
    var planOptions = '<option value="">Любая</option>' +
      Array.from(plans.entries()).sort(function (left, right) {
        return Number(left[1].rooms) - Number(right[1].rooms) || Number(left[1].area) - Number(right[1].area);
      }).map(function (entry) {
        var plan = entry[1];
        return '<option value="' + esc(entry[0]) + '">' + esc(plan.rooms + 'к · ' + formatArea(plan.area) + ' · ' + plan.count + ' кв.') + '</option>';
      }).join('');
    $('#filter-house').innerHTML = houseOptions;
    $('#image-filter-house').innerHTML = houseOptions;
    $('#parameter-filter-house').innerHTML = houseOptions;
    $('#filter-rooms').innerHTML = roomOptions;
    $('#image-filter-rooms').innerHTML = roomOptions;
    $('#parameter-filter-rooms').innerHTML = roomOptions;
    $('#filter-floor').innerHTML = floorOptions;
    $('#image-filter-floor').innerHTML = floorOptions;
    $('#parameter-filter-floor').innerHTML = floorOptions;
    $('#image-filter-plan').innerHTML = planOptions;
    $('#parameter-filter-plan').innerHTML = planOptions;
    var lotOptions = state.inventory.items.map(function (item) {
      return '<option value="' + esc(item.id) + '">' + esc(item.house + ' · ' + item.rooms + 'к · ' + formatArea(item.area)) + '</option>';
    }).join('');
    $('#preview-lot').innerHTML = lotOptions;
    $('#image-lot').innerHTML = lotOptions;
    $('#parameter-lot').innerHTML = lotOptions;
    if (!state.previewId && state.inventory.items[0]) state.previewId = state.inventory.items[0].id;
    if (!state.imageLotId && state.inventory.items[0]) state.imageLotId = state.inventory.items[0].id;
    if (!state.parameterLotId && state.inventory.items[0]) state.parameterLotId = state.inventory.items[0].id;
    $('#preview-lot').value = state.previewId || '';
    $('#image-lot').value = state.imageLotId || '';
    $('#parameter-lot').value = state.parameterLotId || '';
  }

  function lotCard(item) {
    var rule = appliedRule(item);
    var excluded = state.excludedLotIds.indexOf(String(item.id)) >= 0;
    return '<article class="lot-card ' + (excluded ? 'excluded' : '') + '">' +
      '<div class="lot-image"><img src="' + esc(versionedUrl(item.thumbnail || item.image)) + '" alt="' + esc(item.house + ', ' + item.rooms + '-комнатная') + '" loading="lazy" decoding="async" width="480" height="360">' +
      '<span class="lot-badge">' + (excluded ? 'Исключён из фида' : esc(item.house) + (rule ? ' · акция' : '')) + '</span></div>' +
      '<div class="lot-body"><div class="lot-title"><strong>' + esc(item.rooms) + '-комнатная · ' + esc(formatArea(item.area)) + '</strong><span>ID ' + esc(item.id) + '</span></div>' +
      '<div class="lot-meta">' + esc(formatPrice(item.price)) + ' · этаж ' + esc(item.floor) + '/' + esc(item.floors) + '</div>' +
      '<div class="lot-actions"><button data-preview="' + esc(item.id) + '">Предпросмотр</button>' +
      '<button class="lot-feed-toggle ' + (excluded ? 'restore' : '') + '" data-toggle-feed-lot="' + esc(item.id) + '">' +
      (excluded ? 'Вернуть в фид' : 'Исключить из фида') + '</button></div></div></article>';
  }

  function renderLots() {
    var items = state.inventory.items.filter(function (item) { return itemMatchesFilters(item, state.filters); });
    $('#lots-count').textContent = items.length;
    var pageCount = Math.max(1, Math.ceil(items.length / state.pageSize));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    var start = (state.page - 1) * state.pageSize;
    var visibleItems = items.slice(start, start + state.pageSize);
    $('#lots-grid').innerHTML = visibleItems.length ? visibleItems.map(lotCard).join('') :
      '<div class="panel empty-state">По заданным фильтрам ничего не найдено.</div>';
    var pagination = $('#lots-pagination');
    if (items.length <= state.pageSize) {
      pagination.innerHTML = '';
    } else {
      var buttons = '<button data-page="' + (state.page - 1) + '" ' + (state.page === 1 ? 'disabled' : '') + '>←</button>';
      for (var page = 1; page <= pageCount; page += 1) {
        buttons += '<button class="' + (page === state.page ? 'active' : '') + '" data-page="' + page + '">' + page + '</button>';
      }
      buttons += '<button data-page="' + (state.page + 1) + '" ' + (state.page === pageCount ? 'disabled' : '') + '>→</button>';
      pagination.innerHTML = buttons;
      $$('[data-page]', pagination).forEach(function (button) {
        button.addEventListener('click', function () {
          if (button.disabled) return;
          state.page = Number(button.dataset.page);
          renderLots();
          document.getElementById('view-lots').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }
    $$('[data-preview]', $('#lots-grid')).forEach(function (button) {
      button.addEventListener('click', function () {
        state.previewId = button.dataset.preview;
        $('#preview-lot').value = state.previewId;
        navigate('preview');
      });
    });
    $$('[data-toggle-feed-lot]', $('#lots-grid')).forEach(function (button) {
      button.addEventListener('click', function () {
        var id = String(button.dataset.toggleFeedLot);
        if (state.excludedLotIds.indexOf(id) >= 0) {
          state.excludedLotIds = state.excludedLotIds.filter(function (value) { return value !== id; });
          showToast('Квартира будет возвращена в фид после публикации');
        } else {
          state.excludedLotIds.push(id);
          showToast('Квартира не войдёт в готовый XML после публикации');
        }
        setDirty(true);
        renderAll();
      });
    });
  }

  function moveArrayItem(items, fromPosition, toPosition) {
    var from = Number(fromPosition) - 1;
    var to = Number(toPosition) - 1;
    if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
    var copy = items.slice();
    var moved = copy.splice(from, 1)[0];
    copy.splice(to, 0, moved);
    return copy;
  }

  function imageOverride(item) {
    if (!state.imageSettings.lot_overrides[item.id]) {
      state.imageSettings.lot_overrides[item.id] = { order: [], hidden: [], added: [] };
    }
    var override = state.imageSettings.lot_overrides[item.id];
    if (!Array.isArray(override.order)) override.order = [];
    if (!Array.isArray(override.hidden)) override.hidden = [];
    if (!Array.isArray(override.added)) override.added = [];
    return override;
  }

  function addImageToItem(item, image) {
    var override = imageOverride(item);
    if ((override.added || []).length >= 20) throw new Error('Для одного лота можно добавить не более 20 изображений.');
    override.added.push(image);
    override.order = effectiveImages(item).map(function (current) { return current.id; });
    setDirty(true);
  }

  function uploadServiceUrl() {
    if (/^https:\/\//i.test(SERVICE_ROOT)) return SERVICE_ROOT;
    return state.assets && /^https:\/\//i.test(String(state.assets.upload_service_url || '')) ? String(state.assets.upload_service_url) : '';
  }

  function serviceEndpoint(path) {
    return uploadServiceUrl().replace(/\/+$/, '') + path;
  }

  function stopFeedRefreshPolling() {
    if (state.feedRefreshPollTimer) window.clearTimeout(state.feedRefreshPollTimer);
    state.feedRefreshPollTimer = null;
  }

  function storeFeedRefreshOperation(operation) {
    state.feedRefreshOperation = operation;
    if (operation && state.project) localStorage.setItem(feedRefreshKey(), JSON.stringify(operation));
    else if (state.project) localStorage.removeItem(feedRefreshKey());
    renderFeedRefreshState();
  }

  function renderFeedRefreshState() {
    var button = $('#refresh-profitbase');
    var sourceState = $('#feed-source-state');
    if (!button) return;
    var operation = state.feedRefreshOperation;
    var status = operation && operation.status || '';
    if (sourceState) {
      sourceState.textContent = state.status && state.status.checked_at
        ? 'Источник проверен · ' + formatDateTime(state.status.checked_at)
        : 'Дата проверки источника недоступна';
      sourceState.title = 'Дата последнего получения фида Profitbase — автоматического или ручного.';
    }
    button.className = 'button button-secondary feed-refresh-button';
    button.disabled = state.feedRefreshBusy || ['queued', 'building', 'deploying'].indexOf(status) >= 0 || !state.project || !uploadServiceUrl();
    if (status === 'queued') {
      button.textContent = 'Обновление в очереди…';
      button.classList.add('processing');
      return;
    }
    if (status === 'building') {
      button.textContent = 'Получаем Profitbase…';
      button.classList.add('processing');
      return;
    }
    if (status === 'deploying') {
      button.textContent = 'Публикуем XML…';
      button.classList.add('processing');
      return;
    }
    if (status === 'published') {
      button.textContent = 'Обновить Profitbase';
      button.title = 'Последнее ручное обновление завершено ' + formatDateTime(operation.completedAt) + '. Нажмите, чтобы получить данные снова.';
      return;
    }
    if (status === 'failed') {
      button.textContent = 'Повторить обновление';
      button.classList.add('error');
      button.title = operation.message || 'Обновление завершилось ошибкой.';
      return;
    }
    button.textContent = 'Обновить Profitbase';
    button.title = 'Получить актуальный фид выбранного объекта из Profitbase';
  }

  async function pollFeedRefreshStatus() {
    stopFeedRefreshPolling();
    var operation = state.feedRefreshOperation;
    if (!operation || !operation.request || ['published', 'failed'].indexOf(operation.status) >= 0 || !uploadServiceUrl()) return;
    var credential = window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.get ? window.FEED_STUDIO_CREDENTIAL.get() : '';
    if (!credential) return;
    try {
      var response = await fetch(serviceEndpoint('/refresh/status?request=' + encodeURIComponent(operation.request)), {
        headers: { Authorization: 'Bearer ' + credential },
        cache: 'no-store'
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || 'Не удалось получить статус обновления Profitbase.');
      operation.status = String(payload.status || operation.status);
      operation.completedAt = payload.completedAt || operation.completedAt || '';
      operation.message = payload.message || '';
      operation.runUrl = payload.runUrl || operation.runUrl || '';
      storeFeedRefreshOperation(operation);
      if (operation.status === 'published') {
        showToast('Profitbase обновлён, готовый XML опубликован');
        await refreshPublishedProject();
        return;
      }
      if (operation.status === 'failed') {
        showToast(operation.message || 'Обновление Profitbase завершилось ошибкой.');
        return;
      }
    } catch (error) {
      operation.message = error.message || 'Не удалось проверить статус обновления.';
      renderFeedRefreshState();
    }
    state.feedRefreshPollTimer = window.setTimeout(pollFeedRefreshStatus, 10000);
  }

  async function requestFeedRefresh() {
    if (!state.project || state.feedRefreshBusy) return;
    if (state.publishOperation && ['queued', 'building'].indexOf(state.publishOperation.status) >= 0) {
      showToast('Сначала дождитесь применения текущих настроек фида.');
      return;
    }
    var credential = window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.get ? window.FEED_STUDIO_CREDENTIAL.get() : '';
    if (!credential) {
      showToast('Выйдите и войдите в Feed Studio повторно.');
      return;
    }
    state.feedRefreshBusy = true;
    renderFeedRefreshState();
    try {
      var response = await fetch(serviceEndpoint('/refresh'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: state.project.slug })
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || 'Не удалось запустить обновление Profitbase.');
      storeFeedRefreshOperation({
        request: payload.request,
        project: state.project.slug,
        status: payload.status || 'queued',
        requestedAt: payload.requestedAt || new Date().toISOString()
      });
      showToast(state.dirty || state.draftSaved ? 'Обновление начато. Черновик настроек не применяется до публикации.' : 'Получаем актуальные данные Profitbase для выбранного объекта.');
      pollFeedRefreshStatus();
    } catch (error) {
      storeFeedRefreshOperation({ project: state.project.slug, status: 'failed', message: error.message || 'Не удалось запустить обновление.' });
      showToast(error.message || 'Не удалось запустить обновление Profitbase.');
    } finally {
      state.feedRefreshBusy = false;
      renderFeedRefreshState();
    }
  }

  function mergeMaterialItems(items) {
    if (!state.assets || !Array.isArray(items)) return;
    var known = new Set((state.assets.items || []).map(function (item) { return String(item.filename); }));
    items.forEach(function (item) {
      var filename = String(item.filename || '');
      var url = String(item.url || '');
      if (!filename || known.has(filename) || !/^https:\/\//i.test(url)) return;
      state.assets.items.push({
        key: String(item.id || ('asset-' + Date.now().toString(36))),
        name: String(item.name || 'Загруженный материал'),
        description: 'Загруженный фирменный материал объекта.',
        filename: filename,
        exists: true,
        url: url,
        uploaded: true,
        active_for: []
      });
      known.add(filename);
    });
  }

  async function loadMaterialLibrary() {
    if (!state.project || !uploadServiceUrl()) return;
    var credential = window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.get ? window.FEED_STUDIO_CREDENTIAL.get() : '';
    if (!credential) return;
    try {
      var response = await fetch(serviceEndpoint('/materials?project=' + encodeURIComponent(state.project.slug)), {
        headers: { Authorization: 'Bearer ' + credential },
        cache: 'no-store'
      });
      if (!response.ok) return;
      var payload = await response.json();
      mergeMaterialItems(payload.items || []);
    } catch (error) {
      return;
    }
  }

  function renderMaterialUploadState() {
    var zone = $('#material-drop-zone');
    var button = $('#choose-material-file');
    var status = $('#material-upload-status');
    if (!zone || !button || !status) return;
    var available = Boolean(uploadServiceUrl() && state.project);
    zone.classList.toggle('disabled', !available);
    zone.classList.toggle('uploading', state.materialUploadBusy);
    button.disabled = !available || state.materialUploadBusy;
    status.className = 'image-upload-status' + (state.materialUploadTone ? ' ' + state.materialUploadTone : '');
    status.textContent = state.materialUploadMessage || (available ? 'После загрузки выберите, где использовать материал.' : 'Загрузка станет доступна после подключения защищённого хранилища.');
  }

  function setMaterialUploadMessage(message, tone) {
    state.materialUploadMessage = message || '';
    state.materialUploadTone = tone || '';
    renderMaterialUploadState();
  }

  async function optimizeMaterialFile(file) {
    var allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
    if (!file || allowed.indexOf(file.type) < 0) throw new Error('Выберите JPG, PNG, WebP или SVG.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Исходный файл не должен превышать 20 МБ.');
    if (file.type === 'image/svg+xml') {
      if (file.size > 10 * 1024 * 1024) throw new Error('SVG не должен превышать 10 МБ.');
      return file;
    }
    var bitmap = await createImageBitmap(file);
    var maxSide = 2400;
    var scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    var context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    var outputType = file.type === 'image/png' ? 'image/png' : 'image/webp';
    var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, outputType, 0.9); });
    if (!blob) throw new Error('Не удалось подготовить материал.');
    if (blob.size > 10 * 1024 * 1024) throw new Error('После оптимизации файл превышает 10 МБ.');
    var name = String(file.name || 'material').replace(/\.[^.]+$/, '').replace(/[^A-Za-zА-Яа-яЁё0-9_-]+/g, '-').slice(0, 60) || 'material';
    return new File([blob], name + (outputType === 'image/png' ? '.png' : '.webp'), { type: outputType });
  }

  async function uploadMaterialFile(file) {
    if (!state.project || !uploadServiceUrl() || state.materialUploadBusy) return;
    var credential = window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.get ? window.FEED_STUDIO_CREDENTIAL.get() : '';
    if (!credential) {
      showToast('Выйдите и войдите в Feed Studio повторно.');
      return;
    }
    state.materialUploadBusy = true;
    setMaterialUploadMessage('Оптимизируем и загружаем материал…', '');
    try {
      var optimized = await optimizeMaterialFile(file);
      var body = new FormData();
      body.append('project', state.project.slug);
      body.append('file', optimized, optimized.name);
      var response = await fetch(serviceEndpoint('/materials/upload'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + credential },
        body: body
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 401 && window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.set) window.FEED_STUDIO_CREDENTIAL.set('');
        throw new Error(payload.error || 'Не удалось загрузить материал.');
      }
      mergeMaterialItems([payload]);
      setMaterialUploadMessage('Материал загружен. Теперь назначьте его логотипом или ключевым рендером.', 'success');
      renderAssets();
    } catch (error) {
      setMaterialUploadMessage(error.message || 'Не удалось загрузить материал.', 'error');
    } finally {
      state.materialUploadBusy = false;
      renderMaterialUploadState();
    }
  }

  function managedUploadPath(item, image) {
    if (!item || !image || image.kind !== 'added' || !/^add-[A-Za-z0-9_-]+$/.test(String(image.id || ''))) return '';
    var expected = new RegExp('^uploads/' + state.project.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' +
      String(item.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' + String(image.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(?:jpg|jpeg|png|webp)$', 'i');
    if (expected.test(String(image.path || ''))) return String(image.path);
    try {
      var parsed = new URL(String(image.url || ''));
      var prefix = '/' + REPOSITORY + '/media/';
      if (parsed.hostname !== 'raw.githubusercontent.com' || parsed.pathname.indexOf(prefix) !== 0) return '';
      var derived = decodeURIComponent(parsed.pathname.slice(prefix.length));
      return expected.test(derived) ? derived : '';
    } catch (error) {
      return '';
    }
  }

  function queueUploadedImageDeletion(item, image) {
    var path = managedUploadPath(item, image);
    if (!path) return;
    if (!window.confirm('Файл будет безвозвратно удалён после успешной публикации нового фида. Продолжить?')) return;
    var override = imageOverride(item);
    override.added = override.added.filter(function (entry) { return entry.id !== image.id; });
    override.hidden = override.hidden.filter(function (id) { return id !== image.id; });
    override.order = override.order.filter(function (id) { return id !== image.id; });
    if (!state.pendingUploadDeletions.some(function (entry) { return entry.path === path; })) {
      state.pendingUploadDeletions.push({ lot: String(item.id), id: String(image.id), path: path });
    }
    setDirty(true);
    renderImages();
    showToast('Файл будет удалён после применения изменений к фиду');
  }

  function renderImageUploadState() {
    var zone = $('#image-drop-zone');
    var button = $('#choose-image-file');
    var status = $('#image-upload-status');
    if (!zone || !button || !status) return;
    var available = Boolean(uploadServiceUrl() && state.imageLotId);
    zone.classList.toggle('disabled', !available);
    zone.classList.toggle('uploading', state.imageUploadBusy);
    button.disabled = !available || state.imageUploadBusy;
    status.className = 'image-upload-status' + (state.imageUploadTone ? ' ' + state.imageUploadTone : '');
    status.textContent = state.imageUploadMessage || (available ? 'Изображение будет уменьшено до 2000 px и сохранено в защищённом хранилище.' : 'Загрузка файлов станет доступна после подключения защищённого хранилища.');
  }

  function setImageUploadMessage(message, tone) {
    state.imageUploadMessage = message || '';
    state.imageUploadTone = tone || '';
    renderImageUploadState();
  }

  async function optimizeImageFile(file) {
    var allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!file || allowed.indexOf(file.type) < 0) throw new Error('Выберите изображение JPG, PNG или WebP.');
    if (file.size > 20 * 1024 * 1024) throw new Error('Исходный файл не должен превышать 20 МБ.');
    var bitmap = await createImageBitmap(file);
    var maxSide = 2000;
    var scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    var width = Math.max(1, Math.round(bitmap.width * scale));
    var height = Math.max(1, Math.round(bitmap.height * scale));
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) bitmap.close();
    var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.88); });
    if (!blob) throw new Error('Не удалось подготовить изображение.');
    if (blob.size > 10 * 1024 * 1024) throw new Error('После оптимизации файл превышает 10 МБ.');
    var name = String(file.name || 'image').replace(/\.[^.]+$/, '').replace(/[^A-Za-zА-Яа-яЁё0-9_-]+/g, '-').slice(0, 60) || 'image';
    return new File([blob], name + '.jpg', { type: 'image/jpeg' });
  }

  async function uploadImageFile(file) {
    var item = state.inventory.items.find(function (lot) { return lot.id === state.imageLotId; });
    var endpoint = uploadServiceUrl();
    if (!item || !endpoint || state.imageUploadBusy) return;
    var credential = window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.get ? window.FEED_STUDIO_CREDENTIAL.get() : '';
    if (!credential) {
      showToast('Сессия входа завершена. Войдите в Feed Studio повторно.');
      window.setTimeout(function () { window.location.reload(); }, 500);
      return;
    }
    state.imageUploadBusy = true;
    setImageUploadMessage('Оптимизируем и загружаем изображение…', '');
    try {
      var optimized = await optimizeImageFile(file);
      var body = new FormData();
      body.append('project', state.project.slug);
      body.append('lot', item.id);
      body.append('file', optimized, optimized.name);
      var response = await fetch(serviceEndpoint('/upload'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + credential },
        body: body
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 401 && window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.set) window.FEED_STUDIO_CREDENTIAL.set('');
        throw new Error(payload.error || 'Сервис загрузки вернул ошибку.');
      }
      if (!/^https:\/\//i.test(String(payload.url || '')) || !/^[A-Za-z0-9_-]+$/.test(String(payload.id || ''))) {
        throw new Error('Сервис загрузки вернул некорректный ответ.');
      }
      addImageToItem(item, { id: String(payload.id), url: String(payload.url), path: String(payload.path || '') });
      setImageUploadMessage('Изображение загружено и добавлено в галерею.', 'success');
      renderImages();
    } catch (error) {
      setImageUploadMessage(error.message || 'Не удалось загрузить изображение.', 'error');
    } finally {
      state.imageUploadBusy = false;
      renderImageUploadState();
    }
  }

  function effectiveImages(item) {
    var images = [{ id: 'brand-card', url: item.final_image, kind: 'generated', label: 'Брендированная карточка' }]
      .concat((item.source_images || []).map(function (image) {
        return { id: image.id, url: image.url, kind: 'source', label: 'Profitbase · исходная позиция ' + image.position };
      }));
    state.imageSettings.bulk_rules.forEach(function (rule) {
      if (rule.enabled !== false && ruleMatchesSimple(item, rule)) {
        images = moveArrayItem(images, rule.from_position, rule.to_position);
      }
    });
    var override = state.imageSettings.lot_overrides[item.id] || { order: [], hidden: [], added: [] };
    (override.added || []).forEach(function (image) {
      images.push({ id: image.id, url: image.url, path: image.path || '', kind: 'added', label: 'Добавлено вручную' });
    });
    var hidden = override.hidden || [];
    images = images.filter(function (image) { return hidden.indexOf(image.id) < 0; });
    var ranks = new Map((override.order || []).map(function (id, index) { return [id, index]; }));
    var sourceRanks = new Map(images.map(function (image, index) { return [image.id, index]; }));
    images.sort(function (left, right) {
      var leftRank = ranks.has(left.id) ? ranks.get(left.id) : ranks.size + sourceRanks.get(left.id);
      var rightRank = ranks.has(right.id) ? ranks.get(right.id) : ranks.size + sourceRanks.get(right.id);
      return leftRank - rightRank;
    });
    return images;
  }

  function filteredImageItems() {
    return state.inventory.items.filter(function (item) { return itemMatchesFilters(item, state.imageFilters); });
  }

  function renderImageBulkRules() {
    $('#image-bulk-rules').innerHTML = state.imageSettings.bulk_rules.length ? state.imageSettings.bulk_rules.map(function (rule) {
      var count = state.inventory.items.filter(function (item) { return ruleMatchesSimple(item, rule); }).length;
      var floorLabel = (rule.floors || []).length ? ' · этаж ' + rule.floors.join(', ') : '';
      var planLabel = (rule.plan_ids || []).length ? ' · выбранная планировка' : '';
      return '<div class="bulk-rule"><div><strong>' + esc(rule.name) + '</strong><small>' + count +
        ' квартир' + esc(floorLabel + planLabel) + ' · ' + esc(rule.from_position) + ' → ' + esc(rule.to_position) + '</small></div><button data-delete-image-rule="' +
        esc(rule.id) + '" aria-label="Удалить правило">×</button></div>';
    }).join('') : '<p class="helper">Массовых правил пока нет.</p>';
    $$('[data-delete-image-rule]', $('#image-bulk-rules')).forEach(function (button) {
      button.addEventListener('click', function () {
        state.imageSettings.bulk_rules = state.imageSettings.bulk_rules.filter(function (rule) { return rule.id !== button.dataset.deleteImageRule; });
        setDirty(true);
        renderImages();
      });
    });
  }

  function renderImageIndividualRules() {
    var root = $('#image-individual-rules');
    if (!root) return;
    var entries = Object.keys(state.imageSettings.lot_overrides || {}).map(function (id) {
      return { id: String(id), override: state.imageSettings.lot_overrides[id] || {} };
    }).filter(function (entry) {
      return (entry.override.order || []).length || (entry.override.hidden || []).length || (entry.override.added || []).length;
    }).sort(function (left, right) { return left.id.localeCompare(right.id, 'ru', { numeric: true }); });
    root.innerHTML = entries.length ? entries.map(function (entry) {
      var parts = [];
      if ((entry.override.order || []).length) parts.push('изменён порядок');
      if ((entry.override.hidden || []).length) parts.push('скрыто: ' + entry.override.hidden.length);
      if ((entry.override.added || []).length) parts.push('добавлено: ' + entry.override.added.length);
      return '<div class="individual-rule"><div class="individual-rule-copy"><strong>ID ' + esc(entry.id) + '</strong><small>' +
        esc(lotCaption(entry.id)) + '</small><span>' + esc(parts.join(' · ')) + '</span></div><div class="individual-rule-actions">' +
        '<button data-open-image-individual="' + esc(entry.id) + '">Открыть</button><button class="danger" data-delete-image-individual="' +
        esc(entry.id) + '">Удалить</button></div></div>';
    }).join('') : '<p class="helper empty-rule-list">Индивидуальных настроек пока нет.</p>';
    $$('[data-open-image-individual]', root).forEach(function (button) {
      button.addEventListener('click', function () { openIndividualLot('images', button.dataset.openImageIndividual); });
    });
    $$('[data-delete-image-individual]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        var id = button.dataset.deleteImageIndividual;
        if (!window.confirm('Удалить все индивидуальные настройки изображений для лота ID ' + id + '?')) return;
        delete state.imageSettings.lot_overrides[id];
        setDirty(true);
        renderImages();
      });
    });
  }

  function renderImages() {
    if (!state.inventory) return;
    var filtered = filteredImageItems();
    $('#image-filter-count').textContent = filtered.length;
    if (!filtered.some(function (item) { return item.id === state.imageLotId; })) state.imageLotId = filtered[0] ? filtered[0].id : null;
    $('#image-lot').innerHTML = filtered.map(function (item) {
      return '<option value="' + esc(item.id) + '">' + esc(item.house + ' · ' + item.rooms + 'к · ID ' + item.id) + '</option>';
    }).join('');
    $('#image-lot').value = state.imageLotId || '';
    var item = state.inventory.items.find(function (lot) { return lot.id === state.imageLotId; });
    if (!item) {
      $('#image-gallery').innerHTML = '<div class="parameter-empty">По выбранным фильтрам квартир нет.</div>';
      $('#removed-images-wrap').classList.add('hidden');
      renderImageBulkRules();
      renderImageIndividualRules();
      renderImageUploadState();
      return;
    }
    var images = effectiveImages(item);
    $('#image-gallery').innerHTML = images.map(function (image, index) {
      var imageUrl = image.kind === 'generated' ? versionedUrl(image.url) : image.url;
      var deleteUpload = managedUploadPath(item, image) ? '<button class="delete-upload" data-delete-upload="' + esc(image.id) +
        '" title="Физически удалить загруженный файл">Удалить файл</button>' : '';
      return '<article class="image-item"><div class="image-item-preview"><img src="' + esc(imageUrl) + '" alt="Изображение ' +
        (index + 1) + '" loading="lazy" decoding="async"><span class="image-position">' + (index + 1) + '</span><span class="image-kind">' +
        esc(image.kind === 'generated' ? 'Feed Studio' : image.kind === 'source' ? 'Profitbase' : 'Добавлено') +
        '</span></div><div class="image-item-copy"><small title="' + esc(image.label) + '">' + esc(image.label) +
        '</small><div class="image-actions"><button data-image-left="' + esc(image.id) + '" ' + (index === 0 ? 'disabled' : '') +
        '>← Выше</button><button data-image-right="' + esc(image.id) + '" ' + (index === images.length - 1 ? 'disabled' : '') +
        '>Ниже →</button><button class="remove-image" data-remove-image="' + esc(image.id) + '" ' +
        (image.kind === 'generated' ? 'disabled title="Брендированную карточку нельзя исключить"' :
          'title="Не включать изображение в новый фид Avito"') + '>Исключить из фида</button>' + deleteUpload + '</div></div></article>';
    }).join('');
    function saveOrder(nextImages) {
      imageOverride(item).order = nextImages.map(function (image) { return image.id; });
      setDirty(true);
      renderImages();
    }
    $$('[data-image-left]', $('#image-gallery')).forEach(function (button) {
      button.addEventListener('click', function () {
        var index = images.findIndex(function (image) { return image.id === button.dataset.imageLeft; });
        saveOrder(moveArrayItem(images, index + 1, index));
      });
    });
    $$('[data-image-right]', $('#image-gallery')).forEach(function (button) {
      button.addEventListener('click', function () {
        var index = images.findIndex(function (image) { return image.id === button.dataset.imageRight; });
        saveOrder(moveArrayItem(images, index + 1, index + 2));
      });
    });
    $$('[data-remove-image]', $('#image-gallery')).forEach(function (button) {
      button.addEventListener('click', function () {
        if (button.disabled) return;
        var override = imageOverride(item);
        var current = images.find(function (image) { return image.id === button.dataset.removeImage; });
        if (current && override.hidden.indexOf(current.id) < 0) override.hidden.push(current.id);
        override.order = images.filter(function (image) { return image.id !== current.id; }).map(function (image) { return image.id; });
        setDirty(true);
        renderImages();
      });
    });
    $$('[data-delete-upload]', $('#image-gallery')).forEach(function (button) {
      button.addEventListener('click', function () {
        var current = images.find(function (image) { return image.id === button.dataset.deleteUpload; });
        if (current) queueUploadedImageDeletion(item, current);
      });
    });
    var override = state.imageSettings.lot_overrides[item.id] || { hidden: [] };
    var hiddenIds = override.hidden || [];
    var hiddenImages = (item.source_images || []).map(function (image) {
      return { id: image.id, url: image.url, label: 'Profitbase · исходная позиция ' + image.position, kind: 'source' };
    }).concat((override.added || []).map(function (image) {
      return { id: image.id, url: image.url, path: image.path || '', label: 'Добавлено вручную', kind: 'added' };
    })).filter(function (image) { return hiddenIds.indexOf(image.id) >= 0; });
    $('#removed-images-wrap').classList.toggle('hidden', hiddenImages.length === 0);
    $('#removed-images').innerHTML = hiddenImages.map(function (image) {
      var deleteUpload = managedUploadPath(item, image) ? '<button class="delete-upload" data-delete-hidden-upload="' + esc(image.id) +
        '">Удалить файл</button>' : '';
      return '<div class="removed-image"><img src="' + esc(image.url) + '" alt="" loading="lazy" decoding="async"><span>' +
        esc(image.label) + '</span><button class="restore-image" data-restore-image="' + esc(image.id) + '">Вернуть в фид</button>' + deleteUpload + '</div>';
    }).join('');
    $$('[data-restore-image]', $('#removed-images')).forEach(function (button) {
      button.addEventListener('click', function () {
        var currentOverride = imageOverride(item);
        currentOverride.hidden = currentOverride.hidden.filter(function (id) { return id !== button.dataset.restoreImage; });
        setDirty(true);
        renderImages();
      });
    });
    $$('[data-delete-hidden-upload]', $('#removed-images')).forEach(function (button) {
      button.addEventListener('click', function () {
        var current = hiddenImages.find(function (image) { return image.id === button.dataset.deleteHiddenUpload; });
        if (current) queueUploadedImageDeletion(item, current);
      });
    });
    renderImageBulkRules();
    renderImageIndividualRules();
    renderImageUploadState();
  }

  function sanitizeDescriptionHtml(value) {
    var source = String(value || '').trim();
    if (!source) return '';
    if (!/<\/?[a-z][\s\S]*>/i.test(source)) {
      return source.split(/\n{2,}/).map(function (paragraph) {
        return '<p>' + esc(paragraph).replace(/\n/g, '<br>') + '</p>';
      }).join('');
    }
    var doc = new DOMParser().parseFromString('<body>' + source + '</body>', 'text/html');
    function clean(node) {
      Array.from(node.childNodes).forEach(clean);
      if (node.nodeType !== 1 || node === doc.body) return;
      var tag = node.tagName;
      if (tag === 'B' || tag === 'I') {
        var replacement = doc.createElement(tag === 'B' ? 'strong' : 'em');
        while (node.firstChild) replacement.appendChild(node.firstChild);
        node.replaceWith(replacement);
        node = replacement;
        tag = node.tagName;
      }
      if (DESCRIPTION_TAGS.indexOf(tag) < 0) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].indexOf(tag) >= 0) node.remove();
        else node.replaceWith.apply(node, Array.from(node.childNodes));
        return;
      }
      Array.from(node.attributes).forEach(function (attribute) { node.removeAttribute(attribute.name); });
    }
    clean(doc.body);
    return doc.body.innerHTML.trim();
  }

  function descriptionValues(item) {
    var values = Object.assign({}, item.source_values || {});
    Object.assign(values, {
      id: item.id, house: item.house, rooms: item.rooms, area: item.area,
      floor: item.floor, floors: item.floors, price: item.price, decoration: item.decoration
    });
    if (!values.Description) values.Description = item.source_description || '';
    return values;
  }

  function resolveDescription(template, item) {
    var values = descriptionValues(item);
    var result = String(template || '').replace(/\{\{([A-Za-z][A-Za-z0-9_:-]{0,63})\}\}/g, function (_match, key) {
      if (key === 'Description') return sanitizeDescriptionHtml(values[key] || '');
      return esc(values[key] == null ? '' : values[key]);
    });
    return sanitizeDescriptionHtml(result);
  }

  function descriptionTemplate(item) {
    var value = item.source_description || '';
    var origin = 'Profitbase';
    state.parameterSettings.bulk_rules.forEach(function (rule) {
      if (rule.enabled !== false && ruleMatchesSimple(item, rule) && rule.values && rule.values[DESCRIPTION_TAG] != null) {
        value = rule.values[DESCRIPTION_TAG];
        origin = 'массовое правило';
      }
    });
    var individual = state.parameterSettings.lot_values[item.id] || {};
    if (individual[DESCRIPTION_TAG] != null) {
      value = individual[DESCRIPTION_TAG];
      origin = 'индивидуальная настройка';
    }
    return { value: sanitizeDescriptionHtml(value), origin: origin, individual: individual[DESCRIPTION_TAG] != null };
  }

  function descriptionShortcodeOptions(item) {
    var values = descriptionValues(item);
    var preferred = ['Rooms', 'Square', 'Floor', 'Floors', 'Price', 'Decoration', 'Address', 'Id', 'NewDevelopmentId'];
    var keys = Object.keys(values).filter(function (key) {
      return key !== DESCRIPTION_TAG && values[key] != null && String(values[key]).trim();
    });
    keys.sort(function (left, right) {
      var leftIndex = preferred.indexOf(left); var rightIndex = preferred.indexOf(right);
      if (leftIndex < 0) leftIndex = preferred.length + keys.indexOf(left);
      if (rightIndex < 0) rightIndex = preferred.length + keys.indexOf(right);
      return leftIndex - rightIndex;
    });
    return keys.map(function (key) {
      var preview = String(values[key]).replace(/\s+/g, ' ').trim();
      var label = (shortcodeLabels[key] || key) + ' · ' + preview;
      return '<option value="' + esc(key) + '" title="' + esc(label) + '">' + esc(label) + '</option>';
    }).join('');
  }

  function closeExpandedDescriptionEditor() {
    var modal = $('#description-modal');
    var body = $('#description-modal-body');
    var restore = expandedDescriptionEditor;
    if (restore && restore.box) {
      if (restore.parent && restore.parent.isConnected) {
        if (restore.next && restore.next.parentNode === restore.parent) restore.parent.insertBefore(restore.box, restore.next);
        else restore.parent.appendChild(restore.box);
      } else if (body && body.contains(restore.box)) {
        body.removeChild(restore.box);
      }
    }
    expandedDescriptionEditor = null;
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('description-modal-open');
  }

  function openExpandedDescriptionEditor(box) {
    var modal = $('#description-modal');
    var body = $('#description-modal-body');
    if (!box || !modal || !body) return;
    closeExpandedDescriptionEditor();
    expandedDescriptionEditor = { box: box, parent: box.parentNode, next: box.nextSibling };
    body.appendChild(box);
    modal.classList.remove('hidden');
    document.body.classList.add('description-modal-open');
    var editor = $('[data-rich-editor]', box);
    if (editor) window.requestAnimationFrame(function () { editor.focus(); });
  }

  function richTextMarkup(value, item, compact) {
    return '<div class="richtext-box ' + (compact ? 'bulk-richtext' : '') + '">' +
      '<div class="richtext-toolbar"><button type="button" data-rich-command="bold" title="Жирный"><strong>Ж</strong></button>' +
      '<button type="button" data-rich-command="italic" title="Курсив"><em>К</em></button>' +
      '<button type="button" data-rich-command="insertUnorderedList" title="Маркированный список">• Список</button>' +
      '<button type="button" data-rich-command="insertOrderedList" title="Нумерованный список">1. Список</button>' +
      (compact ? '<button type="button" class="richtext-expand" data-expand-description>Развернуть редактор</button>' : '') + '</div>' +
      '<div class="shortcode-row"><select data-description-shortcode>' + descriptionShortcodeOptions(item) + '</select>' +
      '<button type="button" data-insert-shortcode>Вставить поле</button></div>' +
      '<div class="richtext-editor" contenteditable="true" data-rich-editor spellcheck="true">' + sanitizeDescriptionHtml(value) + '</div>' +
      '<div class="description-preview" data-description-preview></div><div class="description-counter" data-description-counter></div></div>';
  }

  function bindRichTextEditor(root, item, onChange) {
    var editor = $('[data-rich-editor]', root);
    if (!editor) return;
    var savedRange = null;
    function rememberSelection() {
      var selection = window.getSelection();
      if (selection && selection.rangeCount && editor.contains(selection.anchorNode)) savedRange = selection.getRangeAt(0).cloneRange();
    }
    function update(emitChange) {
      var clean = sanitizeDescriptionHtml(editor.innerHTML);
      var resolved = resolveDescription(clean, item);
      var preview = $('[data-description-preview]', root);
      var counter = $('[data-description-counter]', root);
      if (preview) preview.innerHTML = resolved;
      if (counter) counter.textContent = resolved.replace(/<[^>]*>/g, '').length + ' / 7500 символов';
      if (emitChange && onChange) onChange(clean);
    }
    ['keyup', 'mouseup', 'focus'].forEach(function (eventName) { editor.addEventListener(eventName, rememberSelection); });
    editor.addEventListener('input', function () { rememberSelection(); update(true); });
    editor.addEventListener('paste', function (event) {
      event.preventDefault();
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    });
    $$('[data-rich-command]', root).forEach(function (button) {
      button.addEventListener('mousedown', function (event) { event.preventDefault(); });
      button.addEventListener('click', function () {
        editor.focus();
        if (savedRange) { var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(savedRange); }
        document.execCommand(button.dataset.richCommand, false, null);
        rememberSelection(); update(true);
      });
    });
    var insert = $('[data-insert-shortcode]', root);
    if (insert) insert.addEventListener('click', function () {
      var select = $('[data-description-shortcode]', root);
      if (!select || !select.value) return;
      editor.focus();
      if (savedRange) { var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(savedRange); }
      document.execCommand('insertText', false, '{{' + select.value + '}}');
      rememberSelection(); update(true);
    });
    var expand = $('[data-expand-description]', root);
    if (expand) expand.addEventListener('click', function () { openExpandedDescriptionEditor(expand.closest('.richtext-box')); });
    update(false);
  }

  function renderDescriptionEditor(item) {
    var wrap = $('#description-editor-wrap');
    if (!item) { wrap.innerHTML = ''; return; }
    var template = descriptionTemplate(item);
    wrap.innerHTML = '<div class="description-editor-card"><div class="description-editor-heading"><div><strong>Описание</strong>' +
      '<small>Тег Description · источник: ' + esc(template.origin) + '</small></div>' +
      (template.individual ? '<button type="button" class="description-reset" id="reset-description">Сбросить правку лота</button>' : '') +
      '</div>' + richTextMarkup(template.value, item, false) + '</div>';
    bindRichTextEditor(wrap, item, function (value) {
      var current = descriptionTemplate(item).value;
      if (value === current && !(state.parameterSettings.lot_values[item.id] || {})[DESCRIPTION_TAG]) return;
      if (!state.parameterSettings.lot_values[item.id]) state.parameterSettings.lot_values[item.id] = {};
      state.parameterSettings.lot_values[item.id][DESCRIPTION_TAG] = value;
      setDirty(true);
    });
    var reset = $('#reset-description', wrap);
    if (reset) reset.addEventListener('click', function () {
      delete state.parameterSettings.lot_values[item.id][DESCRIPTION_TAG];
      if (!Object.keys(state.parameterSettings.lot_values[item.id]).length) delete state.parameterSettings.lot_values[item.id];
      setDirty(true); renderParameters();
    });
  }

  function supportedParameters() {
    return (state.inventory.parameter_catalog || []).filter(function (item) { return item.supported; });
  }

  function parameterByTag(tag) {
    return (state.inventory.parameter_catalog || []).find(function (item) { return item.tag === tag; });
  }

  function effectiveParameters(item) {
    var values = {};
    state.parameterSettings.bulk_rules.forEach(function (rule) {
      if (rule.enabled !== false && ruleMatchesSimple(item, rule)) Object.assign(values, rule.values || {});
    });
    Object.assign(values, state.parameterSettings.lot_values[item.id] || {});
    return values;
  }

  function parameterControl(catalog, value, prefix) {
    if (!catalog) return '';
    if (catalog.kind === 'richtext') {
      var item = state.inventory.items.find(function (lot) { return lot.id === state.parameterLotId; }) || state.inventory.items[0];
      return item ? richTextMarkup(value || '', item, prefix === 'bulk-param') : '';
    }
    if (catalog.kind === 'multi') {
      var selected = Array.isArray(value) ? value : [];
      return '<div class="check-group">' + (catalog.values || []).map(function (option) {
        return '<label class="check-chip"><input type="checkbox" data-' + prefix + '-multi="' + esc(catalog.tag) + '" value="' + esc(option) + '" ' +
          (selected.indexOf(option) >= 0 ? 'checked' : '') + '><span>' + esc(option) + '</span></label>';
      }).join('') + '</div>';
    }
    if (catalog.kind === 'number') {
      return '<input type="number" data-' + prefix + '-value="' + esc(catalog.tag) + '" min="' + esc(catalog.min) + '" max="' +
        esc(catalog.max) + '" step="' + esc(catalog.step) + '" value="' + esc(value || catalog.min) + '">';
    }
    return '<select data-' + prefix + '-value="' + esc(catalog.tag) + '">' + (catalog.values || []).map(function (option) {
      return '<option value="' + esc(option) + '" ' + (String(value) === String(option) ? 'selected' : '') + '>' + esc(option) + '</option>';
    }).join('') + '</select>';
  }

  function readParameterControl(root, catalog, prefix) {
    if (catalog.kind === 'richtext') {
      var editor = $('[data-rich-editor]', root);
      return editor ? sanitizeDescriptionHtml(editor.innerHTML) : '';
    }
    if (catalog.kind === 'multi') {
      return $$('[data-' + prefix + '-multi="' + catalog.tag + '"]:checked', root).map(function (input) { return input.value; });
    }
    var control = $('[data-' + prefix + '-value="' + catalog.tag + '"]', root);
    return control ? control.value : '';
  }

  function filteredParameterItems() {
    return state.inventory.items.filter(function (item) { return itemMatchesFilters(item, state.parameterFilters); });
  }

  function renderParameterBulkValue() {
    closeExpandedDescriptionEditor();
    var catalog = parameterByTag($('#bulk-parameter-tag').value);
    var root = $('#bulk-parameter-value');
    var defaultValue = catalog && catalog.kind === 'richtext' ? '' : catalog && catalog.kind === 'multi' ? [catalog.values[0]] : catalog && catalog.values ? catalog.values[0] : catalog ? catalog.min : '';
    root.innerHTML = catalog ? '<label class="field"><span>Значение</span>' + parameterControl(catalog, defaultValue, 'bulk-param') + '</label>' : '';
    if (catalog && catalog.kind === 'richtext') {
      var item = state.inventory.items.find(function (lot) { return lot.id === state.parameterLotId; }) || state.inventory.items[0];
      if (item) bindRichTextEditor(root, item, null);
    }
  }

  function renderParameterBulkRules() {
    $('#parameter-bulk-rules').innerHTML = state.parameterSettings.bulk_rules.length ? state.parameterSettings.bulk_rules.map(function (rule) {
      var count = state.inventory.items.filter(function (item) { return ruleMatchesSimple(item, rule); }).length;
      var labels = Object.keys(rule.values || {}).map(function (tag) { return (parameterByTag(tag) || { name: tag }).name; }).join(', ');
      var floorLabel = (rule.floors || []).length ? ' · этаж ' + rule.floors.join(', ') : '';
      var planLabel = (rule.plan_ids || []).length ? ' · выбранная планировка' : '';
      return '<div class="bulk-rule"><div><strong>' + esc(rule.name) + '</strong><small>' + count + ' квартир' + esc(floorLabel + planLabel) + ' · ' + esc(labels) +
        '</small></div><button data-delete-parameter-rule="' + esc(rule.id) + '" aria-label="Удалить правило">×</button></div>';
    }).join('') : '<p class="helper">Массовых правил пока нет.</p>';
    $$('[data-delete-parameter-rule]', $('#parameter-bulk-rules')).forEach(function (button) {
      button.addEventListener('click', function () {
        state.parameterSettings.bulk_rules = state.parameterSettings.bulk_rules.filter(function (rule) { return rule.id !== button.dataset.deleteParameterRule; });
        setDirty(true);
        renderParameters();
      });
    });
  }

  function renderParameterIndividualRules() {
    var root = $('#parameter-individual-rules');
    if (!root) return;
    var entries = Object.keys(state.parameterSettings.lot_values || {}).map(function (id) {
      return { id: String(id), values: state.parameterSettings.lot_values[id] || {} };
    }).filter(function (entry) { return Object.keys(entry.values).length; })
      .sort(function (left, right) { return left.id.localeCompare(right.id, 'ru', { numeric: true }); });
    root.innerHTML = entries.length ? entries.map(function (entry) {
      var labels = Object.keys(entry.values).map(function (tag) { return (parameterByTag(tag) || { name: tag }).name; });
      return '<div class="individual-rule"><div class="individual-rule-copy"><strong>ID ' + esc(entry.id) + '</strong><small>' +
        esc(lotCaption(entry.id)) + '</small><span>' + esc(labels.join(', ')) + '</span></div><div class="individual-rule-actions">' +
        '<button data-open-parameter-individual="' + esc(entry.id) + '">Открыть</button><button class="danger" data-delete-parameter-individual="' +
        esc(entry.id) + '">Удалить</button></div></div>';
    }).join('') : '<p class="helper empty-rule-list">Индивидуальных настроек пока нет.</p>';
    $$('[data-open-parameter-individual]', root).forEach(function (button) {
      button.addEventListener('click', function () { openIndividualLot('parameters', button.dataset.openParameterIndividual); });
    });
    $$('[data-delete-parameter-individual]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        var id = button.dataset.deleteParameterIndividual;
        if (!window.confirm('Удалить все индивидуальные параметры для лота ID ' + id + '?')) return;
        delete state.parameterSettings.lot_values[id];
        setDirty(true);
        renderParameters();
      });
    });
  }

  function renderParameters() {
    if (!state.inventory) return;
    var tagCounts = state.inventory.source_tag_counts || {};
    var tags = Object.keys(tagCounts).sort();
    $('#source-tags-count').textContent = tags.length + ' тегов';
    $('#source-tags').innerHTML = tags.map(function (tag) {
      return '<span class="tag-chip">' + esc(tag) + ' <strong>' + esc(tagCounts[tag]) + '</strong></span>';
    }).join('');
    var filtered = filteredParameterItems();
    $('#parameter-filter-count').textContent = filtered.length;
    if (!filtered.some(function (item) { return item.id === state.parameterLotId; })) state.parameterLotId = filtered[0] ? filtered[0].id : null;
    $('#parameter-lot').innerHTML = filtered.map(function (item) {
      return '<option value="' + esc(item.id) + '">' + esc(item.house + ' · ' + item.rooms + 'к · ID ' + item.id) + '</option>';
    }).join('');
    $('#parameter-lot').value = state.parameterLotId || '';
    var item = state.inventory.items.find(function (lot) { return lot.id === state.parameterLotId; });
    var supported = supportedParameters();
    var catalogOptions = supported.filter(function (catalog) { return catalog.tag !== DESCRIPTION_TAG; }).map(function (catalog) {
      var count = tagCounts[catalog.tag] || 0;
      return '<option value="' + esc(catalog.tag) + '">' + esc(catalog.name) + (count ? ' · уже есть в Profitbase' : '') + '</option>';
    }).join('');
    var bulkCatalogOptions = supported.map(function (catalog) {
      var count = tagCounts[catalog.tag] || 0;
      return '<option value="' + esc(catalog.tag) + '">' + esc(catalog.name) + (count ? ' · уже есть в Profitbase' : '') + '</option>';
    }).join('');
    $('#new-parameter-tag').innerHTML = catalogOptions;
    var selectedBulkTag = $('#bulk-parameter-tag').value;
    $('#bulk-parameter-tag').innerHTML = bulkCatalogOptions;
    if (selectedBulkTag && parameterByTag(selectedBulkTag)) $('#bulk-parameter-tag').value = selectedBulkTag;
    var deferred = (state.inventory.parameter_catalog || []).filter(function (catalog) { return !catalog.supported; }).map(function (catalog) { return catalog.tag; });
    $('#parameter-catalog-note').textContent = deferred.length ? 'После сверки справочника Avito добавим: ' + deferred.join(', ') + '.' : '';
    if (!item) {
      renderDescriptionEditor(null);
      $('#parameter-list').innerHTML = '<div class="parameter-empty">По выбранным фильтрам квартир нет.</div>';
      renderParameterBulkValue();
      renderParameterBulkRules();
      renderParameterIndividualRules();
      return;
    }
    renderDescriptionEditor(item);
    var values = effectiveParameters(item);
    var tagsWithValues = Object.keys(values).filter(function (tag) { return tag !== DESCRIPTION_TAG; });
    $('#parameter-list').innerHTML = tagsWithValues.length ? tagsWithValues.map(function (tag) {
      var catalog = parameterByTag(tag);
      var individual = Object.prototype.hasOwnProperty.call(state.parameterSettings.lot_values[item.id] || {}, tag);
      return '<div class="parameter-row"><div class="parameter-row-title"><strong>' + esc(catalog ? catalog.name : tag) +
        '</strong><code>' + esc(tag) + (individual ? ' · для лота' : ' · массовое правило') + '</code></div><div>' +
        parameterControl(catalog, values[tag], 'param') + '</div><button class="remove-parameter" data-remove-parameter="' + esc(tag) + '" ' +
        (individual ? '' : 'disabled title="Удалите массовое правило справа"') + '>×</button></div>';
    }).join('') : '<div class="parameter-empty">Дополнительные параметры для этой квартиры ещё не назначены.</div>';
    $$('[data-param-value]', $('#parameter-list')).concat($$('[data-param-multi]', $('#parameter-list'))).forEach(function (control) {
      control.addEventListener('change', function () {
        var tag = control.dataset.paramValue || control.dataset.paramMulti;
        var catalog = parameterByTag(tag);
        if (!state.parameterSettings.lot_values[item.id]) state.parameterSettings.lot_values[item.id] = {};
        state.parameterSettings.lot_values[item.id][tag] = readParameterControl($('#parameter-list'), catalog, 'param');
        setDirty(true);
      });
    });
    $$('[data-remove-parameter]', $('#parameter-list')).forEach(function (button) {
      button.addEventListener('click', function () {
        if (button.disabled) return;
        delete state.parameterSettings.lot_values[item.id][button.dataset.removeParameter];
        if (!Object.keys(state.parameterSettings.lot_values[item.id]).length) delete state.parameterSettings.lot_values[item.id];
        setDirty(true);
        renderParameters();
      });
    });
    renderParameterBulkValue();
    renderParameterBulkRules();
    renderParameterIndividualRules();
  }

  function renderRuleList() {
    $('#rules-list').innerHTML = state.rules.map(function (rule, index) {
      var count = state.inventory.items.filter(function (item) {
        return state.excludedLotIds.indexOf(String(item.id)) < 0 && ruleMatches(item, rule, false);
      }).length;
      return '<button class="rule-item ' + (rule.id === state.activeRuleId ? 'active' : '') + '" data-rule-id="' + esc(rule.id) + '">' +
        '<span class="rule-state ' + (rule.enabled ? 'on' : '') + '"></span><span class="rule-copy"><strong>' +
        esc((index + 1) + '. ' + rule.name) + '</strong><small>' + count + ' квартир · ' + (rule.enabled ? 'включена' : 'выключена') +
        '</small></span></button>';
    }).join('');
    $$('[data-rule-id]', $('#rules-list')).forEach(function (button) {
      button.addEventListener('click', function () {
        state.activeRuleId = button.dataset.ruleId;
        renderRuleList();
        renderRuleEditor();
      });
    });
    renderPromotionIndividualRules();
  }

  function renderPromotionIndividualRules() {
    var root = $('#promotion-individual-rules');
    if (!root) return;
    var entries = [];
    state.rules.forEach(function (rule) {
      (rule.include_ids || []).forEach(function (id) { entries.push({ id: String(id), rule: rule, kind: 'include' }); });
      (rule.exclude_ids || []).forEach(function (id) { entries.push({ id: String(id), rule: rule, kind: 'exclude' }); });
    });
    entries.sort(function (left, right) { return left.id.localeCompare(right.id, 'ru', { numeric: true }); });
    root.innerHTML = entries.length ? entries.map(function (entry) {
      var action = entry.kind === 'include' ? 'индивидуально назначена' : 'исключён из акции';
      return '<div class="individual-rule"><div class="individual-rule-copy"><strong>ID ' + esc(entry.id) + '</strong><small>' +
        esc(lotCaption(entry.id)) + '</small><span>' + esc(entry.rule.name + ' · ' + action) + '</span></div><div class="individual-rule-actions">' +
        '<button data-open-promotion-individual="' + esc(entry.id) + '">Открыть</button><button class="danger" data-delete-promotion-individual="' +
        esc(entry.rule.id) + '" data-lot-id="' + esc(entry.id) + '" data-kind="' + esc(entry.kind) + '">Удалить</button></div></div>';
    }).join('') : '<p class="helper empty-rule-list">Индивидуальных настроек пока нет.</p>';
    $$('[data-open-promotion-individual]', root).forEach(function (button) {
      button.addEventListener('click', function () { openIndividualLot('promotions', button.dataset.openPromotionIndividual); });
    });
    $$('[data-delete-promotion-individual]', root).forEach(function (button) {
      button.addEventListener('click', function () {
        var rule = state.rules.find(function (item) { return item.id === button.dataset.deletePromotionIndividual; });
        if (!rule) return;
        var id = button.dataset.lotId;
        var kind = button.dataset.kind;
        var warning = kind === 'exclude'
          ? 'Удалить исключение для лота ID ' + id + '? После публикации акция снова сможет применяться к нему.'
          : 'Удалить индивидуальное назначение акции для лота ID ' + id + '?';
        if (!window.confirm(warning)) return;
        if (kind === 'include') {
          if ((rule.include_ids || []).length <= 1) {
            state.rules = state.rules.filter(function (item) { return item.id !== rule.id; });
            if (state.activeRuleId === rule.id) state.activeRuleId = state.rules[0] ? state.rules[0].id : null;
          } else {
            rule.include_ids = rule.include_ids.filter(function (value) { return String(value) !== id; });
          }
        } else {
          rule.exclude_ids = rule.exclude_ids.filter(function (value) { return String(value) !== id; });
        }
        setDirty(true);
        renderAll();
      });
    });
  }

  function chips(name, values, selected, labels) {
    return values.map(function (value) {
      return '<label class="check-chip"><input type="checkbox" data-array="' + esc(name) + '" value="' + esc(value) + '" ' +
        (selected.indexOf(String(value)) >= 0 ? 'checked' : '') + '><span>' + esc(labels[value] || value) + '</span></label>';
    }).join('');
  }

  function renderRuleEditor() {
    var editor = $('#rule-editor');
    var rule = state.rules.find(function (item) { return item.id === state.activeRuleId; });
    if (!rule) {
      editor.innerHTML = '<div class="empty-state">Выберите или создайте правило акции.</div>';
      return;
    }
    var houses = [];
    var houseLabels = {};
    var roomValues = [];
    state.inventory.items.forEach(function (item) {
      if (houses.indexOf(item.house_id) < 0) houses.push(item.house_id);
      houseLabels[item.house_id] = item.house;
      if (roomValues.indexOf(item.rooms) < 0) roomValues.push(item.rooms);
    });
    roomValues.sort();
    var roomLabels = {};
    roomValues.forEach(function (room) { roomLabels[room] = room + '-комнатные'; });
    var groupMatches = state.inventory.items.filter(function (item) {
      return state.excludedLotIds.indexOf(String(item.id)) < 0 && ruleMatches(item, rule, true);
    });
    var finalMatches = groupMatches.filter(function (item) { return rule.exclude_ids.indexOf(String(item.id)) < 0; });
    var index = state.rules.indexOf(rule);
    editor.innerHTML =
      '<div class="editor-header"><div><p class="eyebrow">Правило ' + (index + 1) + '</p><h2>' + esc(rule.name) + '</h2></div>' +
      '<div class="editor-header-actions"><button class="button button-secondary" id="move-rule-up" ' + (index === 0 ? 'disabled' : '') + '>↑ Выше</button>' +
      '<button class="button button-danger" id="delete-rule">Удалить</button></div></div>' +
      '<div class="form-grid">' +
      '<label class="field field-wide"><span>Название правила</span><input data-field="name" value="' + esc(rule.name) + '" maxlength="80"></label>' +
      '<label class="field"><span>Короткая метка</span><input data-field="label" value="' + esc(rule.label) + '" maxlength="24"></label>' +
      '<label class="field"><span>Текст на изображении</span><input data-field="text" value="' + esc(rule.text) + '" maxlength="60"></label>' +
      '<div class="field field-wide"><span>Статус</span><div class="switch-row"><label class="switch"><input type="checkbox" data-field="enabled" ' +
      (rule.enabled ? 'checked' : '') + '><span></span></label><strong>' + (rule.enabled ? 'Акция включена' : 'Акция выключена') + '</strong></div></div>' +
      '<div class="field field-wide"><span>Дома · ничего не выбрано = все</span><div class="check-group">' +
      chips('house_ids', houses, rule.house_ids, houseLabels) + '</div></div>' +
      '<div class="field field-wide"><span>Комнатность · ничего не выбрано = любая</span><div class="check-group">' +
      chips('rooms', roomValues, rule.rooms, roomLabels) + '</div></div>' +
      '<div class="field"><span>Площадь, м²</span><div class="field-row"><input type="number" min="0" max="500" step="0.1" data-field="area_min" placeholder="От" value="' +
      (rule.area_min == null ? '' : esc(rule.area_min)) + '"><input type="number" min="0" max="500" step="0.1" data-field="area_max" placeholder="До" value="' +
      (rule.area_max == null ? '' : esc(rule.area_max)) + '"></div></div>' +
      '<div class="field"><span>Период действия</span><div class="field-row"><input type="date" data-field="starts_at" value="' + esc(rule.starts_at) +
      '"><input type="date" data-field="ends_at" value="' + esc(rule.ends_at) + '"></div></div></div>' +
      '<div class="match-block"><div class="match-heading"><div><p class="eyebrow">Результат условия</p><h2>Подходящие квартиры</h2></div><div><strong>' +
      finalMatches.length + '</strong><span> из ' + groupMatches.length + ' после исключений</span></div></div>' +
      '<div class="match-list">' + (groupMatches.length ? groupMatches.map(function (item) {
        var excluded = rule.exclude_ids.indexOf(String(item.id)) >= 0;
        return '<div class="match-item"><div><strong>' + esc(item.house + ' · ' + item.rooms + 'к · ' + formatArea(item.area)) +
          '</strong><small>ID ' + esc(item.id) + '</small></div><button class="exclude-button ' + (excluded ? 'excluded' : '') +
          '" data-exclude="' + esc(item.id) + '">' + (excluded ? 'Вернуть' : 'Исключить') + '</button></div>';
      }).join('') : '<div class="empty-state">Нет подходящих квартир.</div>') + '</div></div>';

    $$('[data-field]', editor).forEach(function (input) {
      var eventName = input.type === 'text' ? 'input' : 'change';
      input.addEventListener(eventName, function () {
        var field = input.dataset.field;
        if (input.type === 'checkbox') rule[field] = input.checked;
        else if (field === 'area_min' || field === 'area_max') rule[field] = input.value === '' ? null : Number(input.value);
        else rule[field] = input.value;
        setDirty(true);
        renderStats();
        renderRuleList();
        renderLots();
        renderPreview();
        if (eventName === 'change') renderRuleEditor();
      });
    });
    $$('[data-array]', editor).forEach(function (input) {
      input.addEventListener('change', function () {
        var field = input.dataset.array;
        if (input.checked && rule[field].indexOf(input.value) < 0) rule[field].push(input.value);
        if (!input.checked) rule[field] = rule[field].filter(function (value) { return value !== input.value; });
        setDirty(true);
        renderAll();
      });
    });
    $$('[data-exclude]', editor).forEach(function (button) {
      button.addEventListener('click', function () {
        var id = button.dataset.exclude;
        if (rule.exclude_ids.indexOf(id) >= 0) rule.exclude_ids = rule.exclude_ids.filter(function (value) { return value !== id; });
        else rule.exclude_ids.push(id);
        setDirty(true);
        renderAll();
      });
    });
    $('#delete-rule').addEventListener('click', function () {
      if (!window.confirm('Удалить правило «' + rule.name + '»?')) return;
      state.rules = state.rules.filter(function (item) { return item.id !== rule.id; });
      state.activeRuleId = state.rules[0] ? state.rules[0].id : null;
      setDirty(true);
      renderAll();
    });
    $('#move-rule-up').addEventListener('click', function () {
      if (index <= 0) return;
      state.rules.splice(index, 1);
      state.rules.splice(index - 1, 0, rule);
      setDirty(true);
      renderAll();
    });
  }

  function renderPreview() {
    if (!state.inventory || !state.inventory.items.length) return;
    var item = state.inventory.items.find(function (lot) { return lot.id === state.previewId; }) || state.inventory.items[0];
    state.previewId = item.id;
    $('#preview-lot').value = item.id;
    renderMaterialPreview(item);
    $('#preview-title').textContent = item.rooms + '-комнатная, ' + formatArea(item.area);
    $('#preview-details').innerHTML =
      '<div><dt>Дом</dt><dd>' + esc(item.house) + '</dd></div><div><dt>ID</dt><dd>' + esc(item.id) + '</dd></div>' +
      '<div><dt>Цена</dt><dd>' + esc(formatPrice(item.price)) + '</dd></div><div><dt>Этаж</dt><dd>' + esc(item.floor + '/' + item.floors) + '</dd></div>';
    var rule = appliedRule(item);
    var promo = $('#live-promo');
    promo.classList.toggle('hidden', !rule);
    if (state.excludedLotIds.indexOf(String(item.id)) >= 0) {
      $('#applied-rule').innerHTML = '<span>Статус лота</span><strong>Исключён из результирующего XML</strong>';
    } else if (rule) {
      $('#live-promo-label').textContent = rule.label;
      $('#live-promo-text').textContent = rule.text;
      $('#applied-rule').innerHTML = '<span>Применяется правило</span><strong>' + esc(rule.name) + ': ' + esc(rule.text) + '</strong>';
    } else {
      $('#applied-rule').innerHTML = '<span>Акция</span><strong>К этой квартире не применяется</strong>';
    }
  }

  var materialPreviewToken = 0;

  function materialPreviewSnapshot(settings) {
    var source = settings || emptyMaterialSettings();
    return {
      logo: String(source.logo || ''),
      key_render: String(source.key_render || ''),
      primary_color: normalizeHexColor(source.primary_color)
    };
  }

  function hasPendingMaterialPreview() {
    return JSON.stringify(materialPreviewSnapshot(state.materialSettings)) !==
      JSON.stringify(materialPreviewSnapshot(state.publishedMaterialSettings));
  }

  function materialAsset(filename) {
    return state.assets && (state.assets.items || []).find(function (asset) {
      return asset.exists && asset.filename === filename;
    });
  }

  function previewImage(url) {
    return new Promise(function (resolve) {
      if (!url) return resolve(null);
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { resolve(null); };
      image.src = versionedUrl(url);
    });
  }

  function darkerColor(value, factor) {
    var normalized = normalizeHexColor(value) || '#000000';
    var channels = [1, 3, 5].map(function (offset) {
      return Math.max(0, Math.min(255, Math.round(parseInt(normalized.slice(offset, offset + 2), 16) * factor)));
    });
    return '#' + channels.map(function (channel) { return channel.toString(16).padStart(2, '0'); }).join('');
  }

  function drawContained(context, image, x, y, width, height, padding) {
    if (!image) return;
    var inset = Number(padding || 0);
    var scale = Math.min((width - inset * 2) / image.naturalWidth, (height - inset * 2) / image.naturalHeight);
    var targetWidth = image.naturalWidth * scale;
    var targetHeight = image.naturalHeight * scale;
    context.drawImage(image, x + (width - targetWidth) / 2, y + (height - targetHeight) / 2, targetWidth, targetHeight);
  }

  function drawCovered(context, image, x, y, width, height) {
    if (!image) return;
    var scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    var sourceWidth = width / scale;
    var sourceHeight = height / scale;
    context.drawImage(image, (image.naturalWidth - sourceWidth) / 2, (image.naturalHeight - sourceHeight) / 2,
      sourceWidth, sourceHeight, x, y, width, height);
  }

  function canvasText(context, value, x, y, font, color, align) {
    context.font = font;
    context.fillStyle = color;
    context.textAlign = align || 'left';
    context.textBaseline = 'alphabetic';
    context.fillText(String(value || ''), x, y);
  }

  async function drawMaterialPreview(canvas, item, token) {
    var logo = materialAsset(state.materialSettings.logo);
    var keyRender = materialAsset(state.materialSettings.key_render);
    var plan = item.source_images && item.source_images[0] ? item.source_images[0].url : '';
    var loaded = await Promise.all([
      previewImage(logo && logo.url),
      previewImage(keyRender && keyRender.url),
      previewImage(plan)
    ]);
    if (token !== materialPreviewToken) return;
    var context = canvas.getContext('2d');
    var primary = normalizeHexColor(state.materialSettings.primary_color) || '#00605C';
    var dark = darkerColor(primary, 0.78);
    var accent = safeColor(state.assets && state.assets.brand && state.assets.brand.gold || '#CEAD75');
    var muted = safeColor(state.assets && state.assets.brand && state.assets.brand.gray || '#9B9B9B');
    var gradient = context.createLinearGradient(0, 0, 1200, 900);
    gradient.addColorStop(0, primary);
    gradient.addColorStop(1, dark);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1200, 900);

    drawContained(context, loaded[0], 56, 54, 350, 111, 2);
    context.strokeStyle = accent;
    context.lineWidth = 2;
    context.strokeRect(56, 235, 470, 405);
    drawCovered(context, loaded[1], 64, 243, 454, 389);

    context.fillStyle = 'rgba(255,255,255,.08)';
    context.fillRect(56, 180, 145, 42);
    canvasText(context, String(item.house || '').toUpperCase(), 74, 208, '700 19px Manrope, Arial', '#FFFFFF');
    canvasText(context, String(item.rooms || '') + '-КОМНАТНАЯ КВАРТИРА', 56, 696, '800 28px Manrope, Arial', '#FFFFFF');
    canvasText(context, item.decoration || 'Без отделки', 56, 732, '500 18px Manrope, Arial', 'rgba(255,255,255,.78)');
    context.fillStyle = accent;
    context.fillRect(56, 754, 405, 92);
    canvasText(context, formatPrice(item.price), 258, 814, '800 36px Manrope, Arial', dark, 'center');

    context.fillStyle = '#FFFFFF';
    context.fillRect(584, 54, 560, 792);
    drawContained(context, loaded[2], 614, 78, 500, 606, 8);
    context.fillStyle = '#DFE5E3';
    context.fillRect(614, 698, 500, 1);
    var centers = [690, 860, 1030];
    var labels = ['КОМНАТ', 'ПЛОЩАДЬ', 'ЭТАЖ'];
    var values = [String(item.rooms || ''), formatArea(item.area), String(item.floor || '') + '/' + String(item.floors || '')];
    centers.forEach(function (center, index) {
      canvasText(context, labels[index], center, 758, '600 16px Manrope, Arial', muted, 'center');
      canvasText(context, values[index], center, 812, '800 38px Manrope, Arial', primary, 'center');
    });
    context.fillStyle = '#DFE5E3';
    context.fillRect(775, 730, 1, 84);
    context.fillRect(945, 730, 1, 84);
    canvas.classList.remove('hidden');
    $('#preview-image').classList.add('hidden');
    $('#preview-material-note').classList.remove('hidden');
  }

  function renderMaterialPreview(item) {
    var image = $('#preview-image');
    var canvas = $('#preview-live-card');
    var note = $('#preview-material-note');
    materialPreviewToken += 1;
    var token = materialPreviewToken;
    image.src = versionedUrl(item.image);
    if (!hasPendingMaterialPreview()) {
      image.classList.remove('hidden');
      canvas.classList.add('hidden');
      note.classList.add('hidden');
      return;
    }
    image.classList.remove('hidden');
    canvas.classList.add('hidden');
    note.classList.add('hidden');
    canvas.dataset.logo = state.materialSettings.logo;
    canvas.dataset.render = state.materialSettings.key_render;
    canvas.dataset.color = normalizeHexColor(state.materialSettings.primary_color);
    drawMaterialPreview(canvas, item, token);
  }

  function renderAll() {
    renderProjectChrome();
    renderStats();
    renderLots();
    renderImages();
    renderParameters();
    renderRuleList();
    renderRuleEditor();
    renderAssets();
    renderPreview();
    renderFeedRefreshState();
    renderUnsavedChangeButton();
  }

  function settingsPayload() {
    return {
      version: 3,
      project: state.project.slug,
      rules: state.rules.map(normalizeRule),
      image_settings: clone(state.imageSettings),
      parameter_settings: clone(state.parameterSettings),
      material_settings: clone(state.materialSettings),
      excluded_lot_ids: clone(state.excludedLotIds),
      pending_upload_deletions: clone(state.pendingUploadDeletions)
    };
  }

  function stopPublishPolling() {
    if (state.publishPollTimer) window.clearTimeout(state.publishPollTimer);
    state.publishPollTimer = null;
  }

  function storePublishOperation(operation) {
    state.publishOperation = operation;
    if (operation && state.project) localStorage.setItem(operationKey(), JSON.stringify(operation));
    else if (state.project) localStorage.removeItem(operationKey());
    renderSavedState();
  }

  async function refreshPublishedProject() {
    var slug = state.project && state.project.slug;
    if (!slug) return;
    try {
      state.registry = await loadRegistry();
      await loadProject(slug, true);
    } catch (error) {
      showToast('Фид опубликован. Обновите страницу, чтобы загрузить новые данные.');
    }
  }

  async function pollPublishStatus() {
    stopPublishPolling();
    var operation = state.publishOperation;
    if (!operation || !operation.request || ['published', 'failed'].indexOf(operation.status) >= 0 || !uploadServiceUrl()) return;
    var credential = window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.get ? window.FEED_STUDIO_CREDENTIAL.get() : '';
    if (!credential) return;
    try {
      var response = await fetch(serviceEndpoint('/status?request=' + encodeURIComponent(operation.request)), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + credential },
        cache: 'no-store'
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || 'Не удалось получить статус публикации.');
      operation.status = String(payload.status || operation.status);
      operation.completedAt = payload.completedAt || operation.completedAt || '';
      operation.message = payload.message || '';
      storePublishOperation(operation);
      if (operation.status === 'published') {
        state.pendingUploadDeletions = [];
        state.draftSaved = false;
        state.dirty = false;
        localStorage.removeItem(draftKey());
        localStorage.removeItem(operationKey());
        showToast('Изменения применены, готовый фид опубликован');
        await refreshPublishedProject();
        return;
      }
      if (operation.status === 'failed') {
        state.draftSaved = true;
        showToast(operation.message || 'Сборка завершилась ошибкой. Настройки сохранены в черновике.');
        return;
      }
    } catch (error) {
      renderSavedState();
    }
    state.publishPollTimer = window.setTimeout(pollPublishStatus, 15000);
  }

  function validateSettings() {
    if (state.rules.length > 10) return 'Допускается не более 10 правил.';
    if (state.imageSettings.bulk_rules.length > 30) return 'Допускается не более 30 массовых правил изображений.';
    if (state.parameterSettings.bulk_rules.length > 30) return 'Допускается не более 30 массовых правил параметров.';
    if (state.excludedLotIds.length > 250) return 'Допускается исключить не более 250 лотов.';
    if (!state.materialSettings.logo || !state.materialSettings.key_render) return 'Выберите логотип и ключевой рендер.';
    var materialFiles = new Set((state.assets && state.assets.items || []).filter(function (asset) { return asset.exists; }).map(function (asset) { return asset.filename; }));
    if (!materialFiles.has(state.materialSettings.logo) || !materialFiles.has(state.materialSettings.key_render)) return 'Один из выбранных материалов недоступен.';
    var primaryColor = normalizeHexColor(state.materialSettings.primary_color);
    if (!primaryColor) return 'Выберите корректный основной цвет проекта.';
    if (!Array.isArray(state.materialSettings.palette) || !state.materialSettings.palette.length || state.materialSettings.palette.length > 24) return 'Палитра должна содержать от 1 до 24 цветов.';
    var paletteColors = state.materialSettings.palette.map(function (color) { return normalizeHexColor(color && color.value); });
    if (paletteColors.some(function (color) { return !color; }) || new Set(paletteColors).size !== paletteColors.length) return 'В палитре есть некорректные или повторяющиеся цвета.';
    if (paletteColors.indexOf(primaryColor) < 0) return 'Основной цвет должен присутствовать в палитре проекта.';
    for (var i = 0; i < state.rules.length; i += 1) {
      var rule = state.rules[i];
      if (!rule.name.trim()) return 'У правила ' + (i + 1) + ' нет названия.';
      if (rule.enabled && !rule.text.trim()) return 'У активного правила «' + rule.name + '» нет текста.';
      if (rule.area_min != null && rule.area_max != null && Number(rule.area_min) > Number(rule.area_max)) {
        return 'В правиле «' + rule.name + '» минимальная площадь больше максимальной.';
      }
      if (rule.starts_at && rule.ends_at && rule.starts_at > rule.ends_at) {
        return 'В правиле «' + rule.name + '» дата начала позже даты окончания.';
      }
    }
    var descriptionError = '';
    Object.keys(state.parameterSettings.lot_values).some(function (lotId) {
      var template = state.parameterSettings.lot_values[lotId][DESCRIPTION_TAG];
      if (template == null) return false;
      var item = state.inventory.items.find(function (lot) { return lot.id === lotId; });
      var result = item ? resolveDescription(template, item) : '';
      if (!result.replace(/<[^>]*>/g, '').trim()) descriptionError = 'Описание квартиры ' + lotId + ' не может быть пустым.';
      else if (result.length > 7500) descriptionError = 'Описание квартиры ' + lotId + ' превышает 7500 символов.';
      return Boolean(descriptionError);
    });
    if (descriptionError) return descriptionError;
    state.parameterSettings.bulk_rules.some(function (rule) {
      var template = rule.values && rule.values[DESCRIPTION_TAG];
      if (template == null) return false;
      return state.inventory.items.filter(function (item) { return ruleMatchesSimple(item, rule); }).some(function (item) {
        var result = resolveDescription(template, item);
        if (!result.replace(/<[^>]*>/g, '').trim()) descriptionError = 'Массовое описание даёт пустой текст для квартиры ' + item.id + '.';
        else if (result.length > 7500) descriptionError = 'Массовое описание для квартиры ' + item.id + ' превышает 7500 символов.';
        return Boolean(descriptionError);
      });
    });
    if (descriptionError) return descriptionError;
    return '';
  }

  function openPublishModal() {
    if (state.publishOperation && ['queued', 'building'].indexOf(state.publishOperation.status) >= 0) {
      showToast('Предыдущие изменения ещё применяются. Дождитесь окончания пересборки.');
      return;
    }
    if (!collectUnsavedChanges().length) {
      if (state.project) localStorage.removeItem(draftKey());
      state.dirty = false;
      state.draftSaved = false;
      renderSavedState();
      showToast('Нет изменений для применения к фиду');
      return;
    }
    var error = validateSettings();
    if (error) {
      showToast(error);
      return;
    }
    saveDraft(false);
    var enabled = state.rules.filter(function (rule) { return rule.enabled; });
    var affected = state.inventory.items.filter(function (item) { return Boolean(appliedRule(item)); }).length;
    $('#publish-summary').innerHTML = '<strong>' + enabled.length + ' активных правил</strong><br>' +
      affected + ' из ' + state.inventory.items.length + ' квартир получат акцию.<br>' +
      Object.keys(state.imageSettings.lot_overrides).length + ' индивидуальных галерей и ' + state.imageSettings.bulk_rules.length + ' массовых правил изображений.<br>' +
      Object.keys(state.parameterSettings.lot_values).length + ' квартир с дополнительными параметрами и ' + state.parameterSettings.bulk_rules.length + ' массовых правил параметров.<br>' +
      '<strong>' + state.excludedLotIds.length + ' лотов исключено из результирующего XML.</strong><br>' +
      'Логотип: <strong>' + esc(state.materialSettings.logo) + '</strong><br>Ключевой рендер: <strong>' + esc(state.materialSettings.key_render) + '</strong>.<br>' +
      'Основной цвет: <strong>' + esc(state.materialSettings.primary_color) + '</strong> · ' + state.materialSettings.palette.length + ' цветов в палитре.' +
      (state.pendingUploadDeletions.length ? '<br><strong>' + state.pendingUploadDeletions.length + ' загруженных файлов будут физически удалены после публикации.</strong>' : '');
    $('#publish-modal').classList.remove('hidden');
  }

  async function confirmPublish() {
    if (state.publishBusy) return;
    if (!collectUnsavedChanges().length) {
      $('#publish-modal').classList.add('hidden');
      if (state.project) localStorage.removeItem(draftKey());
      state.dirty = false;
      state.draftSaved = false;
      renderSavedState();
      showToast('Нет изменений для применения к фиду');
      return;
    }
    if (!uploadServiceUrl()) {
      showToast('Сервис автоматического применения настроек пока недоступен.');
      return;
    }
    var credential = window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.get ? window.FEED_STUDIO_CREDENTIAL.get() : '';
    if (!credential) {
      showToast('Выйдите и войдите в Feed Studio повторно.');
      return;
    }
    state.publishBusy = true;
    $('#confirm-publish').disabled = true;
    $('#confirm-publish').textContent = 'Отправляем…';
    saveDraft(false);
    try {
      var response = await fetch(serviceEndpoint('/settings'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPayload())
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 401 && window.FEED_STUDIO_CREDENTIAL && window.FEED_STUDIO_CREDENTIAL.set) window.FEED_STUDIO_CREDENTIAL.set('');
        throw new Error(payload.error || 'Не удалось отправить настройки.');
      }
      storePublishOperation({ request: payload.request, status: payload.status || 'queued', project: state.project.slug, createdAt: payload.createdAt || new Date().toISOString() });
      $('#publish-modal').classList.add('hidden');
      showToast('Настройки приняты. Следим за пересборкой фида.');
      pollPublishStatus();
    } catch (error) {
      state.draftSaved = true;
      renderSavedState();
      showToast(error.message || 'Не удалось отправить настройки.');
    } finally {
      state.publishBusy = false;
      $('#confirm-publish').disabled = false;
      $('#confirm-publish').textContent = 'Применить к фиду';
    }
  }

  function downloadSettings() {
    var data = JSON.stringify(settingsPayload(), null, 2);
    var blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = state.project.slug + '-promotion-rules.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function slugify(value) {
    var map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '' };
    return String(value || '').toLowerCase().split('').map(function (char) { return map[char] == null ? char : map[char]; }).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  }

  function openProjectModal() {
    $('#new-project-slug').dataset.edited = '';
    $('#new-project-name').value = '';
    $('#new-project-slug').value = '';
    $('#project-modal').classList.remove('hidden');
    $('#new-project-name').focus();
  }

  function syncProjectIdentifiers() {
    var slug = slugify($('#new-project-name').value);
    if (!$('#new-project-slug').dataset.edited) $('#new-project-slug').value = slug;
  }

  function confirmProject() {
    var name = $('#new-project-name').value.trim();
    var slug = $('#new-project-slug').value.trim();
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      showToast('Проверьте название и системное имя объекта.');
      return;
    }
    if (state.registry.projects.some(function (project) { return project.slug === slug; })) {
      showToast('Объект с таким системным именем уже существует.');
      return;
    }
    var payload = { version: 1, name: name, slug: slug };
    var body = 'Запрос на создание нового объекта Feed Studio.\n\n' +
      'FEED_PROJECT_JSON_START\n' + JSON.stringify(payload, null, 2) + '\nFEED_PROJECT_JSON_END\n\n' +
      'После создания нужно добавить закрытую ссылку Profitbase и фирменные материалы.';
    var title = '[feed-project] Добавить ' + name;
    window.open('https://github.com/' + REPOSITORY + '/issues/new?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body), '_blank', 'noopener');
    $('#project-modal').classList.add('hidden');
    showToast('Подтвердите создание объекта в GitHub');
  }

  function bindStaticEvents() {
    $$('.nav-item').forEach(function (button) {
      button.addEventListener('click', function () { navigate(button.dataset.view); });
    });
    $$('[data-go]').forEach(function (button) {
      button.addEventListener('click', function () { navigate(button.dataset.go); });
    });
    $('#filter-house').addEventListener('change', function (event) { state.filters.house = event.target.value; state.page = 1; renderLots(); });
    $('#filter-rooms').addEventListener('change', function (event) { state.filters.rooms = event.target.value; state.page = 1; renderLots(); });
    $('#filter-floor').addEventListener('change', function (event) { state.filters.floor = event.target.value; state.page = 1; renderLots(); });
    $('#filter-search').addEventListener('input', function (event) { state.filters.search = event.target.value; state.page = 1; renderLots(); });
    $('#image-filter-house').addEventListener('change', function (event) { state.imageFilters.house = event.target.value; renderImages(); });
    $('#image-filter-rooms').addEventListener('change', function (event) { state.imageFilters.rooms = event.target.value; renderImages(); });
    $('#image-filter-floor').addEventListener('change', function (event) { state.imageFilters.floor = event.target.value; renderImages(); });
    $('#image-filter-plan').addEventListener('change', function (event) { state.imageFilters.plan = event.target.value; renderImages(); });
    $('#image-filter-search').addEventListener('input', function (event) { state.imageFilters.search = event.target.value; renderImages(); });
    $('#image-lot').addEventListener('change', function (event) { state.imageLotId = event.target.value; renderImages(); });
    $('#choose-image-file').addEventListener('click', function (event) {
      event.stopPropagation();
      if (!uploadServiceUrl()) return;
      $('#image-file-input').click();
    });
    $('#image-file-input').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) uploadImageFile(file);
    });
    var dropZone = $('#image-drop-zone');
    dropZone.addEventListener('click', function () { if (uploadServiceUrl()) $('#image-file-input').click(); });
    dropZone.addEventListener('keydown', function (event) {
      if ((event.key === 'Enter' || event.key === ' ') && uploadServiceUrl()) { event.preventDefault(); $('#image-file-input').click(); }
    });
    ['dragenter', 'dragover'].forEach(function (eventName) {
      dropZone.addEventListener(eventName, function (event) { event.preventDefault(); if (uploadServiceUrl()) dropZone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (eventName) {
      dropZone.addEventListener(eventName, function (event) { event.preventDefault(); dropZone.classList.remove('dragover'); });
    });
    dropZone.addEventListener('drop', function (event) {
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file && uploadServiceUrl()) uploadImageFile(file);
    });
    $('#choose-material-file').addEventListener('click', function (event) {
      event.stopPropagation();
      if (uploadServiceUrl()) $('#material-file-input').click();
    });
    $('#material-file-input').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) uploadMaterialFile(file);
    });
    var materialDropZone = $('#material-drop-zone');
    materialDropZone.addEventListener('click', function () { if (uploadServiceUrl()) $('#material-file-input').click(); });
    materialDropZone.addEventListener('keydown', function (event) {
      if ((event.key === 'Enter' || event.key === ' ') && uploadServiceUrl()) { event.preventDefault(); $('#material-file-input').click(); }
    });
    ['dragenter', 'dragover'].forEach(function (eventName) {
      materialDropZone.addEventListener(eventName, function (event) { event.preventDefault(); if (uploadServiceUrl()) materialDropZone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (eventName) {
      materialDropZone.addEventListener(eventName, function (event) { event.preventDefault(); materialDropZone.classList.remove('dragover'); });
    });
    materialDropZone.addEventListener('drop', function (event) {
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file && uploadServiceUrl()) uploadMaterialFile(file);
    });
    $('#add-brand-color').addEventListener('click', addBrandColor);
    $('#new-brand-color').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        addBrandColor();
      }
    });
    $('#add-image-url').addEventListener('click', function () {
      var item = state.inventory.items.find(function (lot) { return lot.id === state.imageLotId; });
      var input = $('#new-image-url');
      var url = input.value.trim();
      if (!item || !/^https:\/\//i.test(url)) { showToast('Укажите корректную HTTPS-ссылку на изображение.'); return; }
      try {
        addImageToItem(item, { id: 'add-' + Date.now().toString(36), url: url });
      } catch (error) {
        showToast(error.message);
        return;
      }
      input.value = '';
      renderImages();
    });
    $('#apply-image-bulk').addEventListener('click', function () {
      var items = filteredImageItems();
      var from = Number($('#bulk-image-from').value);
      var to = Number($('#bulk-image-to').value);
      if (!items.length) { showToast('По текущим фильтрам нет квартир.'); return; }
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > 40 || to > 40 || from === to) {
        showToast('Проверьте исходную и новую позиции.'); return;
      }
      state.imageSettings.bulk_rules.push(Object.assign({
        id: 'image-rule-' + Date.now(),
        name: 'Перестановка ' + from + ' → ' + to,
        enabled: true,
        from_position: from,
        to_position: to
      }, filterRuleFrom(state.imageFilters, items)));
      setDirty(true);
      renderImages();
      showToast('Массовое правило создано для ' + items.length + ' квартир');
    });
    $('#parameter-filter-house').addEventListener('change', function (event) { state.parameterFilters.house = event.target.value; renderParameters(); });
    $('#parameter-filter-rooms').addEventListener('change', function (event) { state.parameterFilters.rooms = event.target.value; renderParameters(); });
    $('#parameter-filter-floor').addEventListener('change', function (event) { state.parameterFilters.floor = event.target.value; renderParameters(); });
    $('#parameter-filter-plan').addEventListener('change', function (event) { state.parameterFilters.plan = event.target.value; renderParameters(); });
    $('#parameter-filter-search').addEventListener('input', function (event) { state.parameterFilters.search = event.target.value; renderParameters(); });
    $('#parameter-lot').addEventListener('change', function (event) { state.parameterLotId = event.target.value; renderParameters(); });
    $('#add-parameter').addEventListener('click', function () {
      var item = state.inventory.items.find(function (lot) { return lot.id === state.parameterLotId; });
      var catalog = parameterByTag($('#new-parameter-tag').value);
      if (!item || !catalog) return;
      if (!state.parameterSettings.lot_values[item.id]) state.parameterSettings.lot_values[item.id] = {};
      if (Object.prototype.hasOwnProperty.call(effectiveParameters(item), catalog.tag)) {
        showToast('Этот параметр уже назначен квартире.'); return;
      }
      state.parameterSettings.lot_values[item.id][catalog.tag] = catalog.kind === 'multi' ? [catalog.values[0]] :
        catalog.kind === 'number' ? String(catalog.min) : catalog.values[0];
      setDirty(true);
      renderParameters();
    });
    $('#bulk-parameter-tag').addEventListener('change', renderParameterBulkValue);
    $('#close-description-modal').addEventListener('click', closeExpandedDescriptionEditor);
    $('#description-modal').addEventListener('click', function (event) {
      if (event.target.id === 'description-modal') closeExpandedDescriptionEditor();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('#description-modal').classList.contains('hidden')) closeExpandedDescriptionEditor();
    });
    $('#apply-parameter-bulk').addEventListener('click', function () {
      var items = filteredParameterItems();
      var catalog = parameterByTag($('#bulk-parameter-tag').value);
      if (!items.length) { showToast('По текущим фильтрам нет квартир.'); return; }
      if (!catalog) return;
      var value = readParameterControl($('#bulk-parameter-value'), catalog, 'bulk-param');
      if (catalog.kind === 'multi' && !value.length) { showToast('Выберите хотя бы одно значение.'); return; }
      if (catalog.kind === 'richtext' && !String(value).replace(/<[^>]*>/g, '').trim()) { showToast('Описание не может быть пустым.'); return; }
      var values = {}; values[catalog.tag] = value;
      state.parameterSettings.bulk_rules.push(Object.assign({
        id: 'parameter-rule-' + Date.now(),
        name: catalog.name,
        enabled: true,
        values: values
      }, filterRuleFrom(state.parameterFilters, items)));
      setDirty(true);
      renderParameters();
      showToast('Параметр назначен для ' + items.length + ' квартир');
    });
    $('#preview-lot').addEventListener('change', function (event) { state.previewId = event.target.value; renderPreview(); });
    $('#add-rule').addEventListener('click', function () {
      if (state.rules.length >= 10) { showToast('Можно создать не более 10 правил.'); return; }
      var rule = emptyRule();
      state.rules.push(rule);
      state.activeRuleId = rule.id;
      setDirty(true);
      renderAll();
    });
    $('#save-draft').addEventListener('click', function () { saveDraft(true); });
    $('#review-unsaved').addEventListener('click', openChangesModal);
    $('#close-changes').addEventListener('click', function () { $('#changes-modal').classList.add('hidden'); });
    $('#remove-selected-changes').addEventListener('click', removeSelectedChanges);
    $('#clear-unsaved').addEventListener('click', clearAllUnsavedChanges);
    $('#select-all-changes').addEventListener('change', function (event) {
      $$('input[type="checkbox"]', $('#change-review-list')).forEach(function (box) { box.checked = event.target.checked; });
      syncChangeReviewSelection();
    });
    $('#changes-modal').addEventListener('click', function (event) {
      if (event.target.id === 'changes-modal') $('#changes-modal').classList.add('hidden');
    });
    $('#refresh-profitbase').addEventListener('click', requestFeedRefresh);
    $('#publish-settings').addEventListener('click', openPublishModal);
    $('#cancel-publish').addEventListener('click', function () { $('#publish-modal').classList.add('hidden'); });
    $('#confirm-publish').addEventListener('click', confirmPublish);
    $('#publish-modal').addEventListener('click', function (event) {
      if (event.target.id === 'publish-modal') $('#publish-modal').classList.add('hidden');
    });
    var feedLinksToggle = $('#feed-links-toggle');
    if (feedLinksToggle) {
      feedLinksToggle.addEventListener('click', function () {
        var menu = $('#feed-links-menu');
        var open = !menu.classList.contains('open');
        menu.classList.toggle('open', open);
        feedLinksToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      var feedLinks = document.querySelectorAll('#feed-links-list a');
      for (var feedLinkIndex = 0; feedLinkIndex < feedLinks.length; feedLinkIndex += 1) {
        feedLinks[feedLinkIndex].addEventListener('click', function (event) {
          var mobileFeedLinks = window.matchMedia && window.matchMedia('(max-width: 860px)').matches;
          if (mobileFeedLinks) {
            event.preventDefault();
            copyText(this.href).then(function () {
              showToast('Ссылка на фид скопирована');
            }).catch(function () {
              showToast('Не удалось скопировать ссылку');
            });
          }
          var menu = $('#feed-links-menu');
          menu.classList.remove('open');
          feedLinksToggle.setAttribute('aria-expanded', 'false');
        });
      }
    }
    $('#project-select').addEventListener('change', function (event) { loadProject(event.target.value); });
    $('#add-project').addEventListener('click', openProjectModal);
    $('#cancel-project').addEventListener('click', function () { $('#project-modal').classList.add('hidden'); });
    $('#confirm-project').addEventListener('click', confirmProject);
    $('#project-modal').addEventListener('click', function (event) {
      if (event.target.id === 'project-modal') $('#project-modal').classList.add('hidden');
    });
    $('#new-project-name').addEventListener('input', syncProjectIdentifiers);
    $('#new-project-slug').addEventListener('input', function () {
      this.dataset.edited = this.value ? '1' : '';
    });
  }

  async function loadProject(slug, preservePublication) {
    stopPublishPolling();
    stopFeedRefreshPolling();
    var project = state.registry.projects.find(function (item) { return item.slug === slug; });
    if (!project) return;
    if (!projectIsReady(project)) {
      showToast('Объект создан, но источник Profitbase ещё не подключён.');
      $('#project-select').value = state.project ? state.project.slug : state.registry.default_project;
      return;
    }
    var base = dataUrl(project.base);
    var version = '?v=' + encodeURIComponent(cacheVersion());
    try {
      var backupBase = RAW_DATA_ROOT + '/projects/' + encodeURIComponent(project.slug);
      var data = await Promise.all([
        requestJson(base + '/inventory.json' + version, 'inventory.json', backupBase + '/inventory.json' + version),
        requestJson(base + '/settings.json' + version, 'settings.json', backupBase + '/settings.json' + version),
        requestJson(base + '/status.json' + version, 'status.json', backupBase + '/status.json' + version),
        requestJson(base + '/assets.json' + version, 'assets.json', backupBase + '/assets.json' + version)
      ]);
      state.project = project;
      state.inventory = data[0];
      state.status = data[2];
      state.assets = data[3];
      var publishedRules = (data[1].rules || []).map(normalizeRule);
      state.publishedRules = clone(publishedRules);
      state.publishedImageSettings = normalizeImageSettings(data[1].image_settings || emptyImageSettings());
      state.publishedParameterSettings = normalizeParameterSettings(data[1].parameter_settings || emptyParameterSettings());
      var draft = null;
      try { draft = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch (error) { draft = null; }
      state.rules = draft && Array.isArray(draft.rules) ? draft.rules.map(normalizeRule) : publishedRules;
      state.imageSettings = normalizeImageSettings(draft && draft.image_settings != null ? draft.image_settings : data[1].image_settings || emptyImageSettings());
      state.parameterSettings = normalizeParameterSettings(draft && draft.parameter_settings != null ? draft.parameter_settings : data[1].parameter_settings || emptyParameterSettings());
      state.publishedMaterialSettings = normalizeMaterialSettings(data[1].material_settings || emptyMaterialSettings(), state.assets);
      state.materialSettings = normalizeMaterialSettings(draft && draft.material_settings != null ? draft.material_settings : state.publishedMaterialSettings, state.assets);
      var availableLotIds = new Set(state.inventory.items.map(function (item) { return String(item.id); }));
      state.publishedExcludedLotIds = Array.from(new Set((data[1].excluded_lot_ids || []).map(String)))
        .filter(function (id) { return availableLotIds.has(id); });
      state.excludedLotIds = Array.from(new Set((draft && Array.isArray(draft.excluded_lot_ids) ? draft.excluded_lot_ids : state.publishedExcludedLotIds).map(String)))
        .filter(function (id) { return availableLotIds.has(id); });
      state.pendingUploadDeletions = draft && Array.isArray(draft.pending_upload_deletions) ? clone(draft.pending_upload_deletions) : [];
      state.draftSaved = Boolean(draft);
      if (!preservePublication) {
        try { state.publishOperation = JSON.parse(localStorage.getItem(operationKey()) || 'null'); } catch (error) { state.publishOperation = null; }
      }
      try { state.feedRefreshOperation = JSON.parse(localStorage.getItem(feedRefreshKey()) || 'null'); } catch (error) { state.feedRefreshOperation = null; }
      state.activeRuleId = state.rules[0] ? state.rules[0].id : null;
      state.previewId = null;
      state.imageLotId = null;
      state.parameterLotId = null;
      state.imageUploadBusy = false;
      state.imageUploadMessage = '';
      state.imageUploadTone = '';
      state.materialUploadBusy = false;
      state.materialUploadMessage = '';
      state.materialUploadTone = '';
      state.page = 1;
      state.filters = { house: '', rooms: '', floor: '', search: '' };
      state.imageFilters = { house: '', rooms: '', floor: '', plan: '', search: '' };
      state.parameterFilters = { house: '', rooms: '', floor: '', plan: '', search: '' };
      await loadMaterialLibrary();
      populateFilters();
      renderAll();
      navigate(state.activeView);
      setDirty(false);
      pollPublishStatus();
      pollFeedRefreshStatus();
    } catch (error) {
      document.querySelector('main').innerHTML = '<section class="panel empty-state"><div><h2>Кабинет временно недоступен</h2><p>' + esc(error.message) + '</p></div></section>';
    }
  }

  async function init() {
    try {
      state.registry = await loadRegistry();
      $('#project-select').innerHTML = state.registry.projects.map(function (project) {
        var ready = projectIsReady(project);
        return '<option value="' + esc(project.slug) + '" ' + (ready ? '' : 'disabled') + '>' +
          esc(project.name) + (ready ? '' : ' · настройка') + '</option>';
      }).join('');
      bindStaticEvents();
      var requestedView = window.location.hash.replace('#', '');
      state.activeView = ['dashboard', 'lots', 'images', 'parameters', 'promotions', 'assets', 'preview'].indexOf(requestedView) >= 0 ? requestedView : 'dashboard';
      await loadProject(state.registry.default_project);
    } catch (error) {
      document.querySelector('main').innerHTML = '<section class="panel empty-state"><div><h2>Кабинет временно недоступен</h2><p>' + esc(error.message) + '</p></div></section>';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
