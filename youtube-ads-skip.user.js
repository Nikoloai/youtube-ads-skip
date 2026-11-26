// ==UserScript==
// @name         YouTube Ads Skip
// @namespace    https://github.com/Nikoloai/youtube-ads-skip
// @author       Nikoloai
// @license      MIT
// @homepageURL  https://github.com/Nikoloai/youtube-ads-skip
// @downloadURL  https://github.com/Nikoloai/youtube-ads-skip/raw/main/youtube-ads-skip.user.js
// @updateURL    https://github.com/Nikoloai/youtube-ads-skip/raw/main/youtube-ads-skip.user.js
// @version      1.7.1
// @description  Пропускает рекламу YouTube, как только появляется «Пропустить», возвращает точную позицию, не даёт видео откатываться назад, выключает звук на время рекламы
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ===== Настройки =====
  const MUTE_DURING_AD = true;
  const CHECK_EVERY_MS = 300;
  const RELOAD_COOLDOWN_MS = 3000;
  // Качество после пропуска: null = вернуть то, что было до рекламы,
  // или задать жёстко: 'hd1080', 'hd720', 'large' (480p), 'medium' (360p)
  const FORCE_QUALITY = null;
  // Сколько секунд после рекламы особенно внимательно держать позицию
  const GUARD_SEC = 15;
  // Возвращать видео, если оно само прыгнуло назад (а вы ничего не нажимали)
  const ANTI_ROLLBACK = true;
  const ROLLBACK_MIN_SEC = 3;       // насколько назад должно прыгнуть, чтобы считать это откатом
  const USER_INPUT_GRACE_MS = 2500; // после вашего клика/клавиши столько времени прыжки назад не трогаем
  const MAX_FIXES_PER_30S = 3;      // защита от бесконечной борьбы с плеером
  // Дополнительный сдвиг вперёд после рекламы (обычно не нужен, оставьте 0)
  const RESUME_OFFSET_SEC = 0;

  const SKIP_SELECTORS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-slot button',
    'button[id^="skip-button"]',
    '[class*="skip-ad"] button',
    '[class*="skip"] button',
  ];
  const SKIP_TEXTS = ['пропустить', 'skip'];
  const OVERLAY_CLOSE = '.ytp-ad-overlay-close-button';
  const BAD_QUALITY_VALUES = ['unknown', 'auto', 'tiny', ''];

  let mutedByScript = false;
  let lastReload = 0;
  let wasAd = false;
  let content = { id: null, time: 0, quality: null, duration: 0 }; // основное видео до рекламы
  let restore = null; // { id, time, quality, reachedAt, until }
  let last = { id: null, time: 0, at: 0 }; // позиция на прошлом шаге, для поиска откатов
  let lastUserInput = 0;
  let fixTimes = [];
  let lastTickAt = 0;
  let seekInfo = null;     // последняя перемотка: кто её начал
  let ownSeekUntil = 0;    // перемотки самого скрипта

  const log = (...a) => console.log('[AutoSkip]', ...a);
  const isVisible = (el) => el && el.offsetParent !== null;

  // Любое ваше действие на странице: после него прыжок назад считаем вашей перемоткой
  ['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((t) =>
    document.addEventListener(t, () => { lastUserInput = Date.now(); }, true)
  );

  // В момент начала любой перемотки запоминаем, кто её начал: вы, скрипт или сам плеер
  document.addEventListener('seeking', (e) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    const now = Date.now();
    seekInfo = {
      at: now,
      own: now < ownSeekUntil,
      userActed: now - lastUserInput < USER_INPUT_GRACE_MS,
    };
  }, true);

  // ===== Время берём и ставим через плеер YouTube, чтобы не путать его время с временем видеоэлемента =====
  function getTime(player, video) {
    try {
      if (player.getCurrentTime) {
        const t = player.getCurrentTime();
        if (isFinite(t)) return t;
      }
    } catch (e) { /* ignore */ }
    return video.currentTime || 0;
  }

  function seekTo(player, video, t) {
    ownSeekUntil = Date.now() + 1500;
    try {
      if (player.seekTo) { player.seekTo(t, true); return; }
    } catch (e) { /* ignore */ }
    video.currentTime = t;
  }

  function getDuration(player, video) {
    try {
      const d = player.getDuration && player.getDuration();
      if (d > 0) return d;
    } catch (e) { /* ignore */ }
    return video.duration || 0;
  }

  function isPlaying(player, video) {
    try {
      if (player.getPlayerState) return player.getPlayerState() === 1;
    } catch (e) { /* ignore */ }
    return !video.paused;
  }

  function urlVideoId() {
    const url = new URL(location.href);
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const m = url.pathname.match(/\/(shorts|live|embed)\/([\w-]{11})/);
    return m ? m[2] : null;
  }

  function startTimeFromUrl() {
    const t = new URL(location.href).searchParams.get('t');
    return t ? parseInt(t, 10) || 0 : 0;
  }

  function playerVideoId(player) {
    try {
      return (player.getVideoData && player.getVideoData().video_id) || null;
    } catch (e) {
      return null;
    }
  }

  function findSkipButton() {
    for (const sel of SKIP_SELECTORS) {
      const el = document.querySelector('#movie_player ' + sel) || document.querySelector(sel);
      if (isVisible(el)) return el;
    }
    const player = document.querySelector('#movie_player');
    if (!player) return null;
    for (const btn of player.querySelectorAll('button')) {
      const t = (btn.textContent || '').trim().toLowerCase();
      if (isVisible(btn) && SKIP_TEXTS.some((s) => t.startsWith(s))) return btn;
    }
    return null;
  }

  function applyQuality(player, q) {
    if (!q) return;
    try {
      if (player.setPlaybackQualityRange) player.setPlaybackQualityRange(q, q);
      if (player.setPlaybackQuality) player.setPlaybackQuality(q);
    } catch (e) { /* YouTube может игнорировать */ }
  }

  // Запоминаем позицию, качество и длину основного видео, пока реклама не идёт
  function rememberContent(player, video, id) {
    const pid = playerVideoId(player);
    if ((pid && pid !== id) || video.seeking) return;
    let quality = content.id === id ? content.quality : null;
    try {
      const q = player.getPlaybackQuality && player.getPlaybackQuality();
      if (q && !BAD_QUALITY_VALUES.includes(q)) quality = q;
    } catch (e) { /* ignore */ }
    content = { id, time: getTime(player, video), quality, duration: getDuration(player, video) };
  }

  // Видео само прыгнуло назад, а вы ничего не нажимали: возвращаем
  function antiRollback(player, video, id) {
    const now = Date.now();
    const continuous = now - lastTickAt < 2000; // шаги идут без пропусков (вкладка не спала)
    lastTickAt = now;
    // Пока идёт перемотка, ждём её конца и помним позицию до неё
    if (video.seeking) return false;
    const cur = getTime(player, video);
    const seek = seekInfo && now - seekInfo.at < 15000 ? seekInfo : null;
    seekInfo = null;
    if (ANTI_ROLLBACK && continuous && last.id === id) {
      const jumpBack = last.time - cur;
      // Кто перематывал, решаем по моменту начала перемотки, а не по её концу
      const userActed = seek ? seek.userActed || seek.own : now - lastUserInput < USER_INPUT_GRACE_MS;
      const dur = getDuration(player, video);
      const nearEnd = dur > 0 && last.time > dur - 3; // повтор с начала после конца видео — это нормально
      fixTimes = fixTimes.filter((t) => now - t < 30000);
      if (jumpBack > ROLLBACK_MIN_SEC && !userActed && !nearEnd) {
        if (fixTimes.length < MAX_FIXES_PER_30S) {
          log(`видео само откатилось на ${jumpBack.toFixed(1)} c (с ${last.time.toFixed(1)} на ${cur.toFixed(1)}), возвращаю`);
          seekTo(player, video, last.time);
          fixTimes.push(now);
          return true; // позицию last.time сохраняем
        }
        log(`откаты повторяются слишком часто, больше не мешаю плееру (${cur.toFixed(1)} c)`);
      }
    }
    last = { id, time: cur, at: now };
    return false;
  }


  // Куда вернуть видео после рекламы
  function targetTime(id) {
    if (content.id !== id) return startTimeFromUrl();
    let t = content.time > 1 ? content.time + RESUME_OFFSET_SEC : content.time;
    if (content.duration > 0) t = Math.min(t, content.duration - 1);
    return Math.max(0, t);
  }

  function startRestore(id, why) {
    if (content.id !== id || content.time < 1) return; // реклама перед началом видео: возвращать некуда
    restore = {
      id,
      time: targetTime(id),
      quality: FORCE_QUALITY || content.quality,
      reachedAt: 0,
      until: Date.now() + 20000,
    };
    log(`${why}: возвращаю на ${restore.time.toFixed(1)} c`);
  }

  // Перезагрузить основное видео: реклама исчезает
  function reloadContent(player) {
    const id = urlVideoId();
    if (!id || typeof player.loadVideoById !== 'function') return;
    const time = targetTime(id);
    player.loadVideoById({ videoId: id, startSeconds: time });
    lastReload = Date.now();
    startRestore(id, 'пропуск рекламы');
  }

  // После рекламы: встать на нужную секунду и не давать YouTube откатить назад
  function guardPosition(player, video, id) {
    const now = Date.now();
    const cur = getTime(player, video);
    if (now > restore.until) {
      log(`слежение после рекламы закончено, видео на ${cur.toFixed(1)} c`);
      restore = null;
      last = { id, time: cur, at: now };
      return;
    }
    const pid = playerVideoId(player);
    if ((pid && pid !== restore.id) || video.readyState < 1) return;

    // Качество просим вернуть один раз: частые запросы заставляют плеер перезагружаться и откатываться
    if (!restore.qualityApplied) {
      applyQuality(player, restore.quality);
      restore.qualityApplied = true;
    }

    const behind = restore.time - cur;
    const userActed = now - lastUserInput < USER_INPUT_GRACE_MS;
    if (userActed && restore.reachedAt) {
      // Вы сами перемотали: перестаём держать позицию
      log(`вы перемотали сами, слежение после рекламы остановлено (${cur.toFixed(1)} c)`);
      restore = null;
      last = { id, time: cur, at: now };
      return;
    }
    if (behind > 2) {
      log(`после рекламы видео отстаёт на ${behind.toFixed(1)} c, возвращаю на ${restore.time.toFixed(1)} c`);
      seekTo(player, video, restore.time);
      return;
    }
    if (!restore.reachedAt) {
      restore.reachedAt = now;
      restore.until = now + GUARD_SEC * 1000;
    }
    // Двигаем цель вместе с воспроизведением, чтобы ловить откаты относительно текущего места
    if (isPlaying(player, video) && cur > restore.time) restore.time = cur;
  }

  function tick() {
    const player = document.querySelector('#movie_player');
    const video = document.querySelector('#movie_player video') || document.querySelector('video');
    if (!player || !video) return;

    const adShowing = player.classList.contains('ad-showing');
    const id = urlVideoId();

    // Реклама только что закончилась сама (без нашей перезагрузки)
    if (wasAd && !adShowing && !restore && id) startRestore(id, 'реклама закончилась');
    if (!wasAd && adShowing) log(`началась реклама, запомнил позицию ${content.time.toFixed(1)} c`);
    wasAd = adShowing;

    if (adShowing) {
      last = { id: null, time: 0, at: 0 }; // во время рекламы откаты не ищем
    } else if (id) {
      if (restore) guardPosition(player, video, id);
      else if (!antiRollback(player, video, id)) rememberContent(player, video, id);
    }

    const skip = findSkipButton();
    if (adShowing && skip && Date.now() - lastReload > RELOAD_COOLDOWN_MS) {
      skip.click();
      reloadContent(player);
    }

    const overlay = document.querySelector(OVERLAY_CLOSE);
    if (isVisible(overlay)) overlay.click();

    if (MUTE_DURING_AD) {
      if (adShowing && !video.muted) {
        video.muted = true;
        mutedByScript = true;
      } else if (!adShowing && mutedByScript) {
        video.muted = false;
        mutedByScript = false;
      }
    }
  }

  setInterval(tick, CHECK_EVERY_MS);
  log('скрипт запущен, версия 1.7.1');
})();
