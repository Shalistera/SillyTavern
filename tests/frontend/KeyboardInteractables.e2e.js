import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.beforeEach(async ({ page }) => {
    await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        data.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: data });
    });
    await testSetup.awaitST({ page });
    await page.locator('#chat .mes[type="welcome_prompt"]').waitFor();
});

test('dynamic and extension controls remain focusable and activate once with Enter', async ({ page }) => {
    await page.evaluate(async () => {
        const keyboard = await import('/scripts/keyboard.js');
        const fixture = document.createElement('div');
        fixture.id = 'keyboard-test-fixture';
        fixture.innerHTML = '<div class="menu_button" id="dynamic-keyboard-button"><span>Activate</span></div><div class="extension-keyboard-region"><div class="extension-keyboard-action" id="extension-keyboard-button">Extension</div></div>';
        document.body.append(fixture);
        keyboard.registerInteractableType('.extension-keyboard-region .extension-keyboard-action');
        window.keyboardClicks = 0;
        fixture.querySelector('#dynamic-keyboard-button').addEventListener('click', () => window.keyboardClicks++);
    });
    await expect(page.locator('#dynamic-keyboard-button')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#extension-keyboard-button')).toHaveAttribute('tabindex', '0');
    await page.locator('#dynamic-keyboard-button').press('Enter');
    expect(await page.evaluate(() => window.keyboardClicks)).toBe(1);
    await page.evaluate(() => {
        const button = document.createElement('div');
        button.id = 'late-extension-keyboard-button';
        button.className = 'extension-keyboard-action';
        document.querySelector('.extension-keyboard-region').append(button);
    });
    await expect(page.locator('#late-extension-keyboard-button')).toHaveAttribute('tabindex', '0');
});

test('repeated disabled and not-focusable updates preserve an explicit tab order', async ({ page }) => {
    await page.evaluate(() => {
        const fixture = document.createElement('div');
        fixture.id = 'keyboard-disabled-fixture';
        fixture.className = 'disabled';
        fixture.innerHTML = '<div id="custom-tab-order" class="menu_button interactable" tabindex="7">Button</div>';
        document.body.append(fixture);
    });
    const button = page.locator('#custom-tab-order');
    await expect(button).not.toHaveAttribute('tabindex');
    await expect(button).toHaveAttribute('data-original-tabindex', '7');
    for (const className of ['unrelated-a', 'unrelated-b']) {
        await page.locator('#keyboard-disabled-fixture').evaluate((element, className) => element.classList.add(className), className);
        await expect(button).toHaveAttribute('data-original-tabindex', '7');
    }
    await page.locator('#keyboard-disabled-fixture').evaluate(element => element.classList.remove('disabled'));
    await expect(button).toHaveAttribute('tabindex', '7');
    await page.locator('#keyboard-disabled-fixture').evaluate(element => element.classList.add('not_focusable'));
    await expect(button).not.toHaveAttribute('tabindex');
    await page.locator('#keyboard-disabled-fixture').evaluate(element => element.classList.remove('not_focusable'));
    await expect(button).toHaveAttribute('tabindex', '7');
});

test('scroll reset listeners are installed once across class changes and removal', async ({ page }) => {
    await page.evaluate(() => {
        const container = document.createElement('div');
        container.id = 'keyboard-scroll-reset-fixture';
        container.className = 'scroll-reset-container';
        container.style.cssText = 'height:60px;width:100px;overflow:auto;position:fixed;top:0;left:0';
        container.innerHTML = '<div style="height:500px">Scroll content</div>';
        const addEventListener = container.addEventListener;
        window.scrollResetListenerCount = 0;
        container.addEventListener = function (type, ...args) {
            if (type === 'focusout') window.scrollResetListenerCount++;
            return addEventListener.call(this, type, ...args);
        };
        document.body.append(container);
    });
    await expect.poll(() => page.evaluate(() => window.scrollResetListenerCount)).toBe(1);
    for (const className of ['updated', 'updated-again']) {
        await page.locator('#keyboard-scroll-reset-fixture').evaluate((element, className) => element.classList.add(className), className);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    }
    await page.locator('#keyboard-scroll-reset-fixture').evaluate(element => {
        element.remove();
        document.body.append(element);
        element.scrollTop = 200;
        element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => window.scrollResetListenerCount)).toBe(1);
    await expect.poll(() => page.locator('#keyboard-scroll-reset-fixture').evaluate(element => element.scrollTop)).toBe(0);
});
