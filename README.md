# Категории и дежурства (плагин herdr `anton.sidebar`)

Свои категории в левой панели herdr, вынос копии проекта (worktree) из группы, пометка дежурных агентов
и горячие клавиши для прыжка к проекту.
Описание: `docs/superpowers/specs/2026-10-01-sidebar-categories-design.md`.

## Установка

    herdr plugin link C:\Users\me\projects\herdr-sidebar
    node C:\Users\me\projects\herdr-sidebar\src\cli.js install

Окно: `prefix+shift+s` или правой кнопкой на рабочем месте → «Категории и дежурства».

## Горячие клавиши

В окне плагина встаньте на проект и нажмите `k` (или Enter → «Горячая клавиша…»), выберите клавишу:
Alt+1…Alt+0 или F1…F12 (F11 оставлена терминалу), либо своё сочетание. У проекта с несколькими вкладками
можно выбрать, на какую вкладку прыгать. Клавиша видна в боковой панели рядом с названием.

Как устроено: плагин пишет в config.toml (между метками `anton.sidebar keys`) привязку клавиши к действию
`anton.sidebar.jump-N`, а действие находит проект по имени (и папке, если имён два) — так клавиша
переживает переименование и перезапуск herdr. Занятые herdr или другими плагинами клавиши не предлагаются;
если herdr не примет новую привязку, файл возвращается как был.

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
