# Категории и дежурства (плагин herdr `anton.sidebar`)

Свои категории в левой панели herdr, вынос копии проекта (worktree) из группы и пометка дежурных агентов.
Описание: `docs/superpowers/specs/2026-10-01-sidebar-categories-design.md`.

## Установка

    herdr plugin link C:\Users\me\projects\herdr-sidebar
    node C:\Users\me\projects\herdr-sidebar\src\cli.js install

Окно: `prefix+shift+s` или правой кнопкой на рабочем месте → «Категории и дежурства».

## Дежурный агент

    herdr-duty start --every 30m --note "реклама autopase"
    herdr-duty ok
    herdr-duty fail "кабинет Google Ads не открывается"
    herdr-duty stop

## Откат

    node C:\Users\me\projects\herdr-sidebar\src\cli.js uninstall

## Проверки

    cd sidebar && node --test "test/*.test.js"
    node test/integration/run.js        # отдельная сессия herdr sbplug, рабочую не трогает
