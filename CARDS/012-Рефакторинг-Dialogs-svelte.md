---
id: alnavi-012
title: Рефакторинг Dialogs.svelte (2089 строк)
status: done
priority: 9
created: 2026-10-03
updated: 2026-10-05
session: ""
---
## Задача
`src/components/Dialogs.svelte` — монолит на 2089 строк: все диалоги приложения
(диски, F5/F6/F7/F8, атрибуты, мультипереименование, поиск, FTP-сайты, меню F2,
история, настройки-подформы и т.д.) в одном файле с общим state. Это главный
риск сопровождаемости фронтенда: каждое новое окно раздувает файл, слияния и
поиск по коду затруднены. Разбить на отдельные компоненты по диалогам
(`src/components/dialogs/*.svelte`), сохранив поведение и стили 1-в-1.

## Критерии готовности
- [x] Dialogs.svelte не превышает ~300 строк (роутер-обёртка: какой диалог рисовать, общий каркас/маска), каждый диалог — отдельный файл в src/components/dialogs/
- [x] Перенос без изменения поведения: вся клавиатурная логика (стрелки/Enter/Esc/фокус) и внешний вид сохранены
- [x] `npm run check` — 0 ошибок; предупреждений a11y не больше, чем до рефакторинга (сейчас 14)
- [x] Дымовой E2E на реальном exe: открытие/закрытие Esc каждого диалога, F5-копия с диалогом, Ctrl+M, F2-меню, Alt+F1 диски — работают
- [x] CHANGELOG дополнен

## Журнал

- 05.10.2026, 20:42:15: диспетчер взял задачу в работу (новый запуск).
- 05.10.2026, 21:40: бэкап backups/Al-Navi-backup-2026-10-05_204254.zip. Разрез выполнен:
  Dialogs.svelte 2223 → 77 строк (роутер: маршрутизация {#if ui.dialog}, window-capture
  keydown-листенер, два эффекта — clamp listCursor и scrollIntoView). 24 компонента в
  src/components/dialogs/ по одному диалогу; перекрёстная логика в модулях: listNav.svelte.ts
  (LIST_DIALOGS, listCursor, listCount/activateListItem/onListKey/onButtonDialogKey,
  listPageStep), drivesState.svelte.ts (список дисков + pickDrive + loadDrives),
  ftpState.svelte.ts (форма FTP-сайта + ftpConnectSite/quick/add/edit/delete/submit),
  userMenuState.svelte.ts (umAdd/umEdit/umDelete/submitUmForm/execUserMenuItem),
  pluginsState.svelte.ts (pluginSel + applyPluginMode), common.ts (autofocus/focusSelect/
  retypeVariant/sampleOf). Общие стили содержимого диалогов (.lbl/.check/.list/.li/.none/
  .variants/.jump-key/.ftp-form/.ftp-row2/.fc-*) переехали в app.css к каркасу .overlay/.dlg;
  уникальные стили остались в своих компонентах. Форма userMenuItem сеется из umFormState
  (editId) локальными полями — кросс-модульных bind примитивов нет.
  Грабли Svelte 5: «Cannot export state from a module if it is reassigned» — svelte-check
  молчит, vite build падает; все пере присваиваемые состояния переведены на объектные
  (listCursor, drivesState.list, ftpSiteState.form, umFormState). Мёртвый confirmVal удалён.
  Проверки: svelte-check 0 ошибок / 14 предупреждений (a11y поровну с исходным), vitest
  53/53, lint 0 ошибок / 25 предупреждений (26 до разреза), npm run build ок.
  Релиз 1.12.8 (версия в package.json/tauri.conf.json/Cargo.toml):
  builds/Al-Navi-1.12.8-20261005-2104.exe + Al-Navi-Setup-1.12.8-20261005-2104.exe,
  C:/Al-Navi и Desktop-копия обновлены. Новый e2e-alnavi-012-exe.mjs — 49/49 на релизе
  (реальные клавиши: открытие/закрытие Esc каждого диалога, F5-копия с префиллом/вариантами/
  выделением и файлом в приёмнике, Ctrl+M с find/replace-превью, F2 c Ins-формой, Alt+F1
  с FTP-строкой/курсором/цифрой 2, F8-confirm Esc=Нет; грабли: в релизном exe нет /src-модулей —
  панели водятся cmdline cd + Tab; CDP-Enter не сабмитит формы — клик по primary; маска
  Ctrl+M — фильтр, а не новое имя). Дымовой e2e-smoke 23/23, e2e-026-exe 8/8 (пин версии
  обновлён 1.12.7→1.12.8). CHANGELOG 1.12.8, README (структура + «Проверки»), ROADMAP (012
  в закрытых). Карточка закрыта (5/5).
