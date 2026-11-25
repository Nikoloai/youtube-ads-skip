# YouTube Auto Skip Ad

A small userscript for Tampermonkey that skips YouTube ads as soon as the **Skip** button appears, keeps your place in the video, and mutes the ad while it plays.

[Русская версия ниже](#русский)

## What it does

- Skips skippable ads the moment the **Skip** button shows up.
- Returns you to the exact second you were at, and stops YouTube from rolling the video back after the ad.
- Tries to restore the video quality you had before the ad.
- Mutes ads and turns the sound back on when they end.
- Closes banner ads that cover the video.

It is **not** an ad blocker. Ads still load, and ads without a Skip button still play (muted).

## Why it reloads the video

YouTube ignores clicks made by scripts on the Skip button: it only accepts a real user click. So when the Skip button appears, the script reloads the same video at the second you were at, which removes the ad.

## Install

1. Install the **Tampermonkey** extension for your browser (Chrome Web Store or Microsoft Edge Add-ons).
2. Open your browser's extensions page (`chrome://extensions` or `edge://extensions`) and turn on **Developer mode**. Without it, Tampermonkey does not run userscripts in current Chromium browsers. If Tampermonkey's details page has an **Allow User Scripts** toggle, turn that on too.
3. Tampermonkey → **Create a new script**, delete the template, paste the contents of [`youtube-auto-skip.user.js`](youtube-auto-skip.user.js) and press **Ctrl+S**.
4. Reload YouTube.

## Settings

At the top of the script:

| Setting | Default | Meaning |
|---|---|---|
| `MUTE_DURING_AD` | `true` | Mute ads while they play |
| `FORCE_QUALITY` | `null` | `null` restores the quality you had; or set `'hd1080'`, `'hd720'`, `'large'` (480p), `'medium'` (360p) |
| `GUARD_SEC` | `15` | Seconds after an ad during which the script stops YouTube from rolling the video back |
| `RESUME_OFFSET_SEC` | `0` | Extra seconds to jump forward after an ad, if you ever need it |

## Known limitations

- YouTube changes its player often, so the script can stop working after an update.
- During the first `GUARD_SEC` seconds after an ad, seeking backwards yourself gets undone.
- YouTube may ignore the request to restore quality, so quality can drop for a moment after a skip.
- Debug messages are printed to the browser console with the `[AutoSkip]` prefix.

## Disclaimer

This script is provided for personal use, as is. Using it may go against YouTube's Terms of Service. If you want YouTube without ads and support creators, YouTube Premium is the official way.

## License

[MIT](LICENSE)

---

## Русский

Userscript для Tampermonkey: пропускает рекламу на YouTube, как только появляется кнопка «Пропустить», возвращает вас на то же место в видео и выключает звук на время рекламы.

**Установка:** поставьте расширение Tampermonkey, включите «Режим разработчика» на странице расширений (`edge://extensions` или `chrome://extensions`), затем Tampermonkey → **Create a new script**, вставьте код из файла [`youtube-auto-skip.user.js`](youtube-auto-skip.user.js) и нажмите Ctrl+S. Обновите YouTube.

Это не блокировщик рекламы: реклама загружается, а реклама без кнопки «Пропустить» проигрывается без звука. Настройки описаны в таблице выше и в начале скрипта.
