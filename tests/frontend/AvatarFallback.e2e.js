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

test('reusing a message avatar installs one fallback and preserves other error handlers', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { chat, updateMessageElement } = await import('/script.js');
        const message = {
            name: 'Avatar fallback test',
            is_user: false,
            is_system: false,
            force_avatar: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
            mes: 'Initial answer',
            send_date: '2026-10-22T10:00:00.000Z',
            extra: {},
        };
        chat.splice(0, chat.length, message);
        const messageElement = updateMessageElement(message, { messageId: 0 });
        document.getElementById('chat').replaceChildren(messageElement[0]);
        const avatar = messageElement.find('.avatar img')[0];
        let externalErrors = 0;
        let nativeErrors = 0;
        $(avatar).on('error.avatarTestExtension', () => externalErrors++);
        avatar.addEventListener('error', () => nativeErrors++);
        for (let swipe = 0; swipe < 40; swipe++) {
            message.mes = `Revised answer ${swipe}`;
            updateMessageElement(message, { messageId: 0, messageElement });
        }
        const sameAvatar = messageElement.find('.avatar img')[0] === avatar;
        // The fallback hides the failed avatar before replacing its container.
        // Count invocations, since repeated handlers on an already detached img
        // would otherwise produce the same final DOM and hide the regression.
        let fallbackCalls = 0;
        const originalHide = $.fn.hide;
        $.fn.hide = function (...args) {
            if (this[0] === avatar) fallbackCalls++;
            return originalHide.apply(this, args);
        };
        try {
            avatar.dispatchEvent(new Event('error'));
        } finally {
            $.fn.hide = originalHide;
        }
        return {
            sameAvatar, fallbackCalls, externalErrors, nativeErrors,
            fallbacks: messageElement.find('.avatar .missing-avatar.fa-user-slash').length,
            remainingImages: messageElement.find('.avatar img').length,
        };
    });
    expect(result).toEqual({ sameAvatar: true, fallbackCalls: 1, externalErrors: 1, nativeErrors: 1, fallbacks: 1, remainingImages: 0 });
});
