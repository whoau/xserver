const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

function loadUsers() {
    if (process.env.USERS_JSON) {
        return JSON.parse(process.env.USERS_JSON);
    }
    const filePath = path.join(__dirname, 'users.json');
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    throw new Error('未找到用户配置 USERS_JSON');
}

function ensureScreenshotDir() {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function safeScreenshot(page, filename) {
    try {
        const filePath = path.join(SCREENSHOT_DIR, filename);
        await page.screenshot({ path: filePath, fullPage: true });
        return filePath;
    } catch { return null; }
}

async function notify(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        if (imagePath && fs.existsSync(imagePath)) {
            const formData = new FormData();
            formData.append('chat_id', TG_CHAT_ID);
            formData.append('caption', message);
            formData.append('photo', new Blob([fs.readFileSync(imagePath)]), path.basename(imagePath));
            await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: formData });
        } else {
            await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message })
            });
        }
    } catch (e) { console.error('TG 通知失败:', e.message); }
}

async function processUser(browser, user) {
    const tag = user.username || 'Unknown';
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 }
    });
    
    const page = await context.newPage();
    page.setDefaultTimeout(30000); // 全局超时 30 秒

    try {
        let isLoggedInt = false;

        // ==========================================
        // 策略 1：Cookie 登录尝试
        // ==========================================
        if (user.cookies && user.cookies.length > 0) {
            console.log(`  [${tag}] 发现 Cookie，尝试直接进入游戏管理后台...`);
            const formattedCookies = user.cookies.map(c => ({
                name: c.name, value: c.value, domain: c.domain, path: c.path || '/'
            }));
            await context.addCookies(formattedCookies);

            await page.goto('https://secure.xserver.ne.jp/xmgame/game/index', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000); // 给服务器一点验证 session 的时间

            // 【精准校验】判断是否真进了后台：页面有没有「アップグレード・期限延長」按钮
            const upgradeLink = page.getByRole('link', { name: 'アップグレード・期限延長' });
            if (await upgradeLink.isVisible().catch(() => false)) {
                console.log(`  [${tag}] ✅ Cookie 有效，免密进入后台成功！`);
                isLoggedInt = true;
            } else {
                console.log(`  [${tag}] ⚠️ Cookie 已过期或被 IP 拦截，清除并回退到密码登录...`);
                await context.clearCookies(); // 核心：清理失效的 Cookie，防止干扰密码登录
            }
        }

        // ==========================================
        // 策略 2：账号密码登录兜底
        // ==========================================
        if (!isLoggedInt) {
            console.log(`  [${tag}] 正在执行账号密码登录...`);
            await page.goto('https://secure.xserver.ne.jp/xapanel/login/xmgame', { waitUntil: 'domcontentloaded' });
            await page.getByRole('textbox', { name: 'XServerアカウントID または メールアドレス' }).fill(user.username);
            await page.locator('#user_password').fill(user.password);
            
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45000 }).catch(() => {}),
                page.getByRole('button', { name: 'ログインする' }).click()
            ]);

            const gameLink = page.getByRole('link', { name: 'ゲーム管理' });
            try {
                await gameLink.waitFor({ state: 'visible', timeout: 15000 });
                await gameLink.click();
                await page.waitForLoadState('networkidle');
            } catch (err) {
                throw new Error('密码登录后找不到「ゲーム管理」，可能是密码错误或遭遇了验证码拦截。');
            }

            // 二次校验
            const upgradeLink = page.getByRole('link', { name: 'アップグレード・期限延長' });
            if (await upgradeLink.isVisible().catch(() => false)) {
                console.log(`  [${tag}] ✅ 密码登录进入后台成功！`);
            } else {
                throw new Error('无法进入游戏管理面板。');
            }
        }

        // ==========================================
        // 执行延期逻辑
        // ==========================================
        console.log(`  [${tag}] 正在检查延期状态...`);
        await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();

        const extendLink = page.getByRole('link', { name: '期限を延長する' });
        try {
            await extendLink.waitFor({ state: 'visible', timeout: 6000 });
        } catch {
            const bodyText = await page.locator('body').innerText();
            const match = bodyText.match(/更新をご希望の場合は、(.+?)以降にお試しください。/);
            const reason = match?.[1] ? `下次可延长时间: ${match[1]}` : '页面无延长按钮（可能已达上限）';
            
            const msg = `⚠️ [${tag}] 跳过 — ${reason}`;
            console.log(`  ${msg}`);
            await notify(msg, await safeScreenshot(page, `skip_${tag}.png`));
            return 'skipped';
        }

        console.log(`  [${tag}] 点击延期并确认...`);
        await extendLink.click();
        await page.getByRole('button', { name: '確認画面に進む' }).click();
        await page.getByRole('button', { name: '期限を延長する' }).click();
        
        // 容错处理：成功后点击返回，即使没找到也不报错
        await page.waitForLoadState('networkidle');
        await page.getByRole('link', { name: '戻る' }).click().catch(() => {});

        const msg = `✅ [${tag}] 成功延长期限`;
        console.log(`  ${msg}`);
        await notify(msg, await safeScreenshot(page, `success_${tag}.png`));
        return 'success';

    } catch (err) {
        const msg = `❌ [${tag}] 处理失败: ${err.message}`;
        console.error(`  ${msg}`);
        await notify(msg, await safeScreenshot(page, `error_${tag}.png`));
        return 'failed';
    } finally {
        await context.close();
    }
}

// 主入口
(async () => {
    let users;
    try { users = loadUsers(); } catch (e) { console.error(e.message); process.exit(1); }
    ensureScreenshotDir();

    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const results = { success: [], skipped: [], failed: [] };

    for (const user of users) {
        console.log(`\n========== 处理用户: ${user.username || 'Unknown'} ==========`);
        const status = await processUser(browser, user);
        results[status].push(user.username || 'Unknown');
    }
    await browser.close();

    console.log('\n========== 执行汇总 ==========');
    console.log(`  成功: ${results.success.length} — ${results.success.join(', ')}`);
    console.log(`  跳过: ${results.skipped.length} — ${results.skipped.join(', ')}`);
    console.log(`  失败: ${results.failed.length} — ${results.failed.join(', ')}`);

    if (results.failed.length > 0) process.exit(1);
})();
