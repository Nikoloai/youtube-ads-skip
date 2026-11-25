// ==UserScript==
// @name         YouTube Ads Skip
// @namespace    https://github.com/Nikoloai/youtube-ads-skip
// @author       Nikoloai
// @license      MIT
// @homepageURL  https://github.com/Nikoloai/youtube-ads-skip
// @downloadURL  https://github.com/Nikoloai/youtube-ads-skip/raw/main/youtube-ads-skip.user.js
// @updateURL    https://github.com/Nikoloai/youtube-ads-skip/raw/main/youtube-ads-skip.user.js
// @version      1.6.1
// @description  Пропускает рекламу YouTube, как только появляется «Пропустить», возвращает точную позицию (не даёт YouTube откатить назад) и качество, выключает звук на время рекламы
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
  // Сколько секунд после рекламы следить, чтобы YouTube не откатил видео назад
  const GUARD_SEC = 15;
  // Дополнительный сдвиг вперёд (обычно не нужен, оставьте 0)
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

  const log = (...a) => console.log('[AutoSkip]', ...a);
  const isVisible = (el) => el && el.offsetParent !== null;

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
    let time = video.currentTime || 0;
    try {
      if (player.getCurrentTime) time = player.getCurrentTime();
    } catch (e) { /* ignore */ }
    let quality = content.id === id ? content.quality : null;
    try {
      const q = player.getPlaybackQuality && player.getPlaybackQuality();
      if (q && !BAD_QUALITY_VALUES.includes(q)) quality = q;
    } catch (e) { /* ignore */ }
    let duration = 0;
    try {
      duration = (player.getDuration && player.getDuration()) || video.duration || 0;
    } catch (e) { /* ignore */ }
    content = { id, time, quality, duration };
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
  function guardPosition(player, video) {
    if (!restore) return;
    const now = Date.now();
    if (now > restore.until) {
      log(`слежение закончено, видео на ${video.currentTime.toFixed(1)} c`);
      restore = null;
      return;
    }
    const pid = playerVideoId(player);
    if ((pid && pid !== restore.id) || video.readyState < 1) return;

    // Качество просим вернуть один раз: частые запросы заставляют плеер перезагружаться и откатываться
    if (!restore.qualityApplied) {
      applyQuality(player, restore.quality);
      restore.qualityApplied = true;
    }

    const behind = restore.time - video.currentTime;
    if (behind > 2) {
      // Видео отстаёт от нужного места: YouTube откатил назад, возвращаем
      log(`YouTube откатил на ${behind.toFixed(1)} c, возвращаю на ${restore.time.toFixed(1)} c`);
      video.currentTime = restore.time;
      return;
    }
    if (!restore.reachedAt) {
      restore.reachedAt = now;
      restore.until = now + GUARD_SEC * 1000; // дальше просто следим
    }
    // Пока следим, двигаем цель вместе с воспроизведением,
    // чтобы ловить откаты относительно текущего места
    if (!video.paused && video.currentTime > restore.time) restore.time = video.currentTime;
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

    if (!adShowing) {
      if (restore) guardPosition(player, video);
      else if (id) rememberContent(player, video, id);
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
})();
