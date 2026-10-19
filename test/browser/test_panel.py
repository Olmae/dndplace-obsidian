"""Run against scripts/panel-browser-server.mjs. Synthetic renderer, not installed-host acceptance."""
import os
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('PANEL_TEST_URL', 'http://127.0.0.1:31986')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    try:
        for width, theme in [(300, 'dark'), (390, 'light'), (1366, 'dark')]:
            page = browser.new_page(viewport={'width': width, 'height': 768}, color_scheme=theme, reduced_motion='reduce')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(URL, wait_until='networkidle')
            # Native ItemView is a fixed-height flex scroller, not an expanding web page.
            page.add_style_tag(content='main.dndplace-panel{height:768px;min-height:0;overflow-y:auto}')
            page.get_by_label('Папка кампании', exact=True).select_option('local')
            expect(page.get_by_role('checkbox')).to_have_count(40)
            assert page.evaluate('window.panelTest.stats.writes') == 0
            checkbox = page.get_by_role('checkbox', name='Портовый трактир', exact=True)
            checkbox.focus()
            checkbox.press('Space')
            expect(checkbox).to_be_checked()
            expect(checkbox).to_be_focused()
            checkbox.press('Space')
            expect(checkbox).not_to_be_checked()
            scroll_list = page.get_by_role('group', name='Записи на сайте')
            scroll_list.evaluate('(el)=>{el.scrollTop=180}')
            scrolled_note = page.get_by_role('checkbox', name='Запись архива 5', exact=True)
            scrolled_note.focus()
            saved_scroll = scroll_list.evaluate('(el)=>el.scrollTop')
            scrolled_note.press('Space')
            expect(scrolled_note).to_be_focused()
            assert scroll_list.evaluate('(el)=>el.scrollTop') == saved_scroll
            scrolled_note.press('Space')
            search = page.get_by_role('searchbox', name='Поиск записей')
            search.press_sequentially('Портовый')
            expect(search).to_have_value('Портовый')
            expect(search).to_be_focused()
            expect(page.get_by_role('checkbox')).to_have_count(1)
            checkbox.check()
            page.get_by_role('button', name='Предпросмотр получения', exact=True).click()
            expect(page.get_by_role('region', name='Подтверждение получения')).to_be_visible()
            assert page.evaluate('window.panelTest.stats.writes') == 0
            checkbox.uncheck()
            expect(page.get_by_role('region', name='Подтверждение получения')).to_have_count(0)
            assert page.evaluate('window.panelTest.stats.writes') == 0
            checkbox.check()
            page.get_by_role('button', name='Предпросмотр получения', exact=True).click()
            page.get_by_role('button', name='Получить выбранные записи', exact=True).click()
            expect(page.get_by_role('heading', name='Готово', exact=True)).to_be_visible()
            assert page.evaluate('window.panelTest.stats.writes') == 1
            page.get_by_label('Папка кампании', exact=True).select_option('local')
            page.get_by_role('button', name='На сайт', exact=True).click()
            expect(page.get_by_role('group', name='Записи Obsidian')).to_be_visible()
            page.get_by_role('checkbox', name='Портовый трактир', exact=True).check()
            page.get_by_role('button', name='Предпросмотр отправки', exact=True).click()
            assert page.evaluate('window.panelTest.stats.staged') == 0
            assert page.evaluate('window.panelTest.stats.writes') == 1
            page.get_by_role('button', name='Подготовить отправку', exact=True).click()
            expect(page.get_by_role('button', name='Отправить на сайт', exact=True)).to_be_visible()
            assert page.evaluate('window.panelTest.stats.staged') == 1
            assert page.evaluate('window.panelTest.stats.writes') == 1
            assert page.locator('main').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            page.screenshot(path=f'/tmp/dnd-panel-send-review-{width}-{theme}.png', full_page=True)
            page.get_by_role('button', name='Отправить на сайт', exact=True).click()
            expect(page.get_by_text('Отправлено: 1 · Ожидает решения: 0', exact=True)).to_be_visible()
            assert page.evaluate('window.panelTest.stats.writes') == 2
            history_button = page.get_by_role('button', name='История записи', exact=True)
            history_button.click()
            expect(page.get_by_role('region', name='История записи', exact=True)).to_be_visible()
            site_link = page.get_by_role('link', name='Открыть запись на сайте', exact=True)
            expect(site_link).to_be_visible()
            expect(site_link).to_have_attribute('href', 'https://example.test/dm/camp/prep?open=note%3Anote')
            expect(site_link).to_have_attribute('target', '_blank')
            expect(site_link).to_have_attribute('rel', 'noopener noreferrer')
            site_link.focus()
            expect(site_link).to_be_focused()
            assert page.evaluate('window.panelTest.stats.writes') == 2
            version = page.get_by_role('button', name='Открыть версию: Версия 1', exact=True)
            version.click()
            expect(version).to_be_focused()
            expect(page.get_by_text('Текст отличается', exact=True)).to_be_visible()
            page.get_by_label('Сравнить с', exact=True).select_option('v2')
            expect(page.get_by_role('heading', name='Версия 2', exact=True)).to_be_visible()
            assert page.locator('main img').count() == 0
            assert page.locator('main').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            page.screenshot(path=f'/tmp/dnd-history-{width}-{theme}.png', full_page=True)
            page.get_by_role('button', name='Восстановить текст локально…', exact=True).click()
            expect(page.get_by_role('button', name='Отмена восстановления', exact=True)).to_be_focused()
            expect(page.get_by_role('heading', name='После восстановления', exact=True)).to_be_visible()
            assert page.evaluate('window.panelTest.stats.restores') == 0
            assert page.evaluate('window.panelTest.stats.writes') == 2
            assert page.locator('main img').count() == 0
            assert page.locator('main').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            page.screenshot(path=f'/tmp/dnd-history-restore-{width}-{theme}.png', full_page=True)
            page.get_by_role('button', name='Отмена восстановления', exact=True).click()
            expect(page.get_by_role('button', name='Восстановить текст локально…', exact=True)).to_be_focused()
            assert page.evaluate('window.panelTest.stats.restores') == 0
            page.get_by_role('button', name='Восстановить текст локально…', exact=True).click()
            page.get_by_role('button', name='Подтвердить восстановление текста', exact=True).click()
            expect(page.get_by_text('Текст восстановлен как локальная правка.', exact=False)).to_be_visible()
            expect(page.get_by_role('button', name='Закрыть историю', exact=True)).to_be_focused()
            assert page.evaluate('window.panelTest.stats.restores') == 1
            assert page.evaluate('window.panelTest.stats.writes') == 2
            page.get_by_role('button', name='Закрыть историю', exact=True).click()
            expect(page.get_by_role('region', name='История записи', exact=True)).to_have_count(0)
            expect(history_button).to_be_focused()
            page.evaluate("window.panelTest.setHistoryOrigin('cache')")
            history_button.click()
            expect(page.get_by_text('Сохранённая история', exact=False)).to_be_visible()
            expect(page.get_by_role('link', name='Открыть запись на сайте', exact=True)).to_have_count(0)
            page.get_by_role('button', name='Открыть версию: Версия 1', exact=True).click()
            expect(page.get_by_text('Показан сохранённый текст версии.', exact=True)).to_be_visible()
            page.get_by_role('button', name='Закрыть историю', exact=True).click()
            page.evaluate("window.panelTest.setHistoryOrigin('server')")
            assert page.evaluate('window.panelTest.stats.writes') == 2
            search.fill('')
            conflict_button = page.get_by_role('button', name='Сравнить версии', exact=True)
            conflict_button.click()
            expect(page.get_by_role('region', name='Сравнение версий', exact=True)).to_be_visible()
            expect(page.get_by_role('group', name='Направление обмена', exact=True)).to_have_count(0)
            assert page.get_by_role('heading', name='Версии', exact=True).evaluate('(el)=>el.offsetHeight<40')
            expect(page.get_by_role('heading', name='На сайте · версия 2', exact=True)).to_be_visible()
            assert page.locator('main img').count() == 0
            page.get_by_role('button', name='Взять с сайта', exact=True).click()
            expect(page.get_by_role('button', name='Отмена решения', exact=True)).to_be_focused()
            assert page.evaluate('window.panelTest.stats.conflictApplies') == 0
            assert page.locator('main').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            page.screenshot(path=f'/tmp/dnd-conflict-{width}-{theme}.png', full_page=True)
            page.get_by_role('button', name='Отмена решения', exact=True).click()
            expect(page.get_by_role('button', name='Взять с сайта', exact=True)).to_be_focused()
            page.get_by_role('button', name='Создать копию', exact=True).click()
            expect(page.get_by_text('Кампании/Пески/Запись 1 — копия.md', exact=True)).to_be_visible()
            page.get_by_role('button', name='Создать локальную копию', exact=True).click()
            expect(conflict_button).to_be_focused()
            assert page.evaluate('window.panelTest.stats.conflictApplies') == 1
            conflict_button.click()
            page.get_by_role('button', name='Позже', exact=True).click()
            page.get_by_role('button', name='Отложить конфликт', exact=True).click()
            expect(page.get_by_text('Конфликт отложен и сохранён.', exact=False)).to_be_visible()
            conflict_button.click()
            page.get_by_role('button', name='Взять с сайта', exact=True).click()
            page.get_by_role('button', name='Подтвердить получение', exact=True).click()
            expect(conflict_button).to_be_focused()
            assert page.evaluate('window.panelTest.stats.conflictApplies') == 3
            assert page.evaluate('window.panelTest.stats.writes') == 2
            conflict_button.click()
            page.get_by_role('button', name='Оставить локальную', exact=True).click()
            expect(page.get_by_role('heading', name='1. Локальная версия', exact=True)).to_be_visible()
            page.get_by_role('button', name='Отмена решения', exact=True).click()
            assert page.evaluate('window.panelTest.stats.localStages') == 0
            page.get_by_role('button', name='Оставить локальную', exact=True).click()
            page.get_by_role('button', name='Подготовить перезапись', exact=True).click()
            expect(page.get_by_role('heading', name='2. Подтверждение сайта', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Не отправлять сейчас', exact=True)).to_be_focused()
            assert page.evaluate('window.panelTest.stats.localStages') == 1
            assert page.evaluate('window.panelTest.stats.localWrites') == 0
            assert page.locator('main img').count() == 0
            assert page.locator('main').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            page.screenshot(path=f'/tmp/dnd-keep-local-{width}-{theme}.png', full_page=True)
            page.get_by_role('button', name='Не отправлять сейчас', exact=True).click()
            expect(conflict_button).to_be_focused()
            assert page.evaluate('window.panelTest.stats.localWrites') == 0
            page.get_by_role('button', name='Продолжить отправку', exact=True).click()
            expect(page.get_by_role('button', name='Перезаписать на сайте', exact=True)).to_be_visible()
            expect(page.get_by_role('heading', name='Перезаписать версию 2 на сайте', exact=True)).to_be_visible()
            assert page.evaluate('window.panelTest.stats.localWrites') == 0
            assert page.locator('main').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            page.screenshot(path=f'/tmp/dnd-keep-resume-{width}-{theme}.png', full_page=True)
            page.get_by_role('button', name='Перезаписать на сайте', exact=True).click()
            assert page.evaluate('window.panelTest.stats.localWrites') == 1
            conflict_button.click()
            page.get_by_role('button', name='Оставить локальную', exact=True).click()
            page.get_by_role('button', name='Подготовить перезапись', exact=True).click()
            page.get_by_role('button', name='Перезаписать на сайте', exact=True).click()
            expect(conflict_button).to_be_focused()
            assert page.evaluate('window.panelTest.stats.localWrites') == 2
            page.evaluate('window.panelTest.setOverwriteBlocked(true)')
            conflict_button.click()
            page.get_by_role('button', name='Оставить локальную', exact=True).click()
            page.get_by_role('button', name='Подготовить перезапись', exact=True).click()
            expect(page.get_by_role('button', name='Перезаписать на сайте', exact=True)).to_be_disabled()
            page.get_by_role('button', name='Не отправлять сейчас', exact=True).click()
            assert page.evaluate('window.panelTest.stats.localWrites') == 2
            assert page.locator('main img').count() == 0
            assert page.evaluate('window.injected === undefined')
            assert page.locator('main').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
            page.screenshot(path=f'/tmp/dnd-panel-{width}-{theme}-1018.png', full_page=True)
            page.get_by_text('Связать папку с кампанией', exact=True).click()
            page.get_by_label('Подключение', exact=True).select_option('connection')
            page.get_by_label('Кампания', exact=True).select_option('camp')
            page.get_by_label('Название новой привязки', exact=True).fill('Новая полка')
            page.get_by_label('Привязка архива', exact=True).select_option('remote')
            expect(page.get_by_label('Название новой привязки', exact=True)).to_have_value('Новая полка')
            page.get_by_label('Папка Obsidian', exact=True).select_option('Кампании/Пески')
            assert page.locator('main').evaluate('(el)=>el.scrollWidth<=el.clientWidth')
            page.get_by_role('button', name='Связать папку', exact=True).click()
            expect(page.get_by_role('checkbox')).to_have_count(40)
            page.get_by_label('Кампания', exact=True).select_option('second')
            expect(page.get_by_role('checkbox')).to_have_count(0)
            assert page.evaluate('window.panelTest.stats.writes') == 2
            assert errors == [], errors
            page.close()
            print(f'PASS {width}px {theme}: keyboard focus, search, preview/confirmation, inert HTML, no overflow/errors')
    finally:
        browser.close()
