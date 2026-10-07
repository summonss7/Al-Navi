---
id: alnavi-014
title: V2 — SFTP-клиент (первый шаг V2 из ROADMAP)
status: done
priority: 9
created: 2026-10-03
updated: 2026-10-07
session: ""
---
## Задача
Первый пункт V2 из ROADMAP. КЛИЕНТ SFTP по образцу существующего FTP: менеджер
сайтов (переиспользовать хранилище ftp-sites.json или отдельное), `sftp://` в
командной строке и в меню дисков, листинг/чтение/правка/сохранение, F7 mkdir,
F5/F6/F8/Shift+F6 через очередь ops с прогрессом. Начать с исследования крейта
(ssh2 / russh + russh-sftp) под GNU-тулчейн без админа — критично: сборка должна
остаться оффлайн-совместимой с локальным cargo-кэшем, как у текущих зависимостей.

## Критерии готовности
- [x] Исследование зафиксировано в журнале: выбранный крейт, лицензия, сборается ли stable-x86_64-pc-windows-gnu, что попадает в Cargo.lock
- [x] Подключение к тестовому SFTP-серверу (можно поднять локально — встроенный OpenSSH Windows) — листинг в панели через sftp://
- [x] F3/F4 просмотр и сохранение на сервере, F7 каталог, F5/F6 копирование с прогрессом, F8 удаление, Shift+F6 переименование
- [x] Ошибки сети обрабатываются тостами, панель не блокируется
- [x] F1-справка, i18n (все 6 локалей), README, CHANGELOG; E2E на реальном exe против локального сервера

## Журнал

- 07.10.2026, 04:40:28: диспетчер взял задачу в работу (новый запуск).
- 07.10.2026, 05:05: исследование крейтов завершено. Выбор: **russh 0.46.0 + russh-sftp 2.4.0**
  (оба Apache-2.0). Чистый Rust — крипта на RustCrypto (aes/chacha20/curve25519-dalek/sha2),
  БЕЗ ring/openssl/aws-lc и без C-сборки/cmake — критично для MSYS2 ucrt64 GNU-тулчейна без админа.
  Пробный cargo-проект с обоими крейтами собрался `cargo +stable-x86_64-pc-windows-gnu build` за 40 c
  без предупреждений (rustc 1.98.1). Альтернатива ssh2 0.9.5 (MIT/Apache, libssh2-sys) отклонена:
  C-сборка libssh2 через cc (WinCNG) + синхронный API (потребовал бы spawn_blocking поверх
  асинхронной архитектуры проекта). russh-sftp — tokio-native (SftpSession ≈ std::fs: read_dir/
  metadata/create_dir/remove/rename/open_with_flags + стриминг File с AsyncRead/Write/Seek,
  fs_info → Statvfs для свободного места в футере панели). Сеть доступна: крейты скачаны разово
  в локальный ~/.cargo/registry (как zip/tar/sevenz-rust ранее) — последующие сборки оффлайн.
  В Cargo.lock добавятся: russh, russh-keys, russh-util, russh-cryptovec, russh-sftp, ssh-key,
  ssh-encoding, pageant (+ транзитивные RustCrypto: aes-gcm, chacha20poly1305, curve25519-dalek,
  p256/p384/p521, ed25519-dalek, rsa, sha1/sha2, hmac, dhe-производные) — все чистый Rust.
- 07.10.2026, 05:05: тестовый сервер: Windows OpenSSH-СЕРВЕРА на машине нет (клиент ssh/sftp/
  ssh-keygen есть; служба sshd отсутствует, установка требует админа) — для разработки и E2E
  поднимается локальный SFTP-сервер на Node (пакет ssh2, node v24), как советует карточка
  («можно поднять локально»). Плюс локальный FTP-сервер (npm ftp-srv) для регрессии FTP-пути
  после обобщения движка операций.
- 07.10.2026, 05:06: архитектура: движок удалённых операций ftp_ops.rs обобщается до
  remote_ops.rs с трейтом RemoteIo (list/mkdir/rm/rmdir/rename/download/upload/close);
  FTP (suppaftp) и SFTP (russh-sftp) — две реализации примитивов; вся walk/conflict/plan-логика
  (~700 строк) становится общей. Ключи сессий — authority со схемой ("sftp://u@h:22").
- 07.10.2026, 06:00: тестовые серверы написаны и отлажены: scripts/test-servers/sftp-server.py
  (paramiko, jail-chroot, пароль test/test, порт параметром; грабли задокументированы в коде:
  paramiko передаёт в SFTPServerInterface.open() уже СКОНВЕРТИРОВАННЫЕ локальные os.open-флаги —
  на Windows CRT O_WRONLY=1, а не SFTP FXF_WRITE=0x2; os.pread/pwrite на Windows нет) и
  ftp-server.py (pyftpdlib, MLSD). Пакеты pip --user paramiko/pyftpdlib.
- 07.10.2026, 07:00: бэкенд готов и проверен на реальном сервере: sftp.rs (сессии+creds-карта,
  reconnect-once, команды sftp_connect/list/read_text/write_text/read_hex/mkdir/rename,
  старт в домашнем каталоге canonicalize("."), свободное место через statvfs-расширение),
  remote_ops.rs (общий движок + FtpIo/SftpIo; SFTP: чанковый стриминг с паузой/прогрессом,
  таймауты CTRL 60s/DATA_IDLE 120s, ошибки Status→Msg, IO/Timeout/Recv→Conn с ретраем на
  свежем соединении), ops.rs маршрутизирует copy/move/delete на remote_ops при ftp://|sftp://,
  lib.rs регистрирует SftpState и команды. Сборка GNU чистая (0 warning, кроме известного
  линкерного .drectve).
- 07.10.2026, 07:30: фронтенд готов: ftp.ts — FtpSite.secure (SFTP=22/FTP=21), isSftpPath/
  isRemotePath/remoteAuthority/ftpRootOf(secure) + диспетчеры remoteConnect/List/ReadText/
  WriteText/ReadHex/Mkdir/Rename; api.ts — sftp_* обёртки; panels/register-commands/editor/
  ViewerArea/FilePanel/SearchDialog/format/cmdline переведены с isFtpPath на isRemotePath
  (найдены и исправлены 2 тихо-не-применившихся патча: resolveTransferTarget и
  rememberTransferTarget не знали sftp:// — копирование «на сервер» уходило в локальный
  движок с os error 123); менеджер сайтов: общий список FTP+SFTP с бейджами, переключатель
  протокола в форме (порт меняется вместе с ним), строка SFTP в меню дисков (клавиша 3,
  пресет протокола для новых сайтов), 2=FTP как раньше; справка F1 + ключи ftp.scheme и
  help.dlg.sftpKey ×6 локалей (парность восстановлена).
- 07.10.2026, 09:50: новый e2e-alnavi-014-dev.mjs (+ общий flow-модуль): debug exe + vite +
  РЕАЛЬНЫЕ локальные SFTP/FTP серверы, реальные клавиши/клики — 26/26: строка SFTP (3) в
  меню дисков, подключение из списка сайтов, листинг, F3 просмотр, F4 правка+сохранение на
  сервер (round-trip), F7 mkdir, F5 sftp→локально (диалог прогресса замечен), F5 локально→sftp,
  конфликт-диалог + overwrite, F6 move 8MB, Shift+F6 rename, F8 delete, F5 sftp→sftp relay
  через temp, мёртвый порт → SFTP-диалог ошибки + приложение живо, FTP-регрессия (список +
  F5) на рефакторенном движке, sftp://-URL в командной строке. Грабли e2e: CDP Enter не
  триггерит implicit form submit (диалоги подтверждаем реальным кликом по primary);
  после rename курсор остаётся на ИНДЕКСЕ строки, а не на файле (сортировка сдвигает) —
  детерминированный moveToName стрелками по .row.cursor .name; Alt-прыжки заменены им же.
- 07.10.2026, 14:10: релиз 1.13.0: версии в package.json/tauri.conf.json/Cargo.toml,
  npm run release → builds/Al-Navi-1.13.0-20261007-1341.exe (7.8 МБ, +0.96 МБ к 1.12.15 —
  russh+russh-sftp+RustCrypto) + Setup; C:\Al-Navi и Desktop обновлены. CHANGELOG 1.13.0,
  README (FTP/SFTP-возможности, e2e-014 в проверках, структура: remote_ops/sftp), ROADMAP
  (V2-SFTP закрыт; хвосты: known-hosts pinning, аутентификация по ключу). Новый
  e2e-alnavi-014-exe.mjs на релизе: 27/27 (пин версии + полный флоу). Регрессии: smoke 23/23,
  012-exe 49/49 (пин версии →1.13.0), 013-dev 14/14, 026-exe 8/8, 027-exe 17/17, 028-exe 18/18,
  028-dev 20/20, 030-exe 8/8, 031-exe 22/22, 032-exe 16/16, 033-exe 6/6, 033-dev 11/11
  (пины версий →1.13.0; счётчик строк справки 92→93 в 026/027/028/031 из-за новой строки
  SFTP в диалоге дисков), i18n-parity 405=405, vitest 53/53, svelte-check 0 ошибок,
  lint 0 ошибок, build ок. Задача выполнена, все 5 критериев закрыты.
