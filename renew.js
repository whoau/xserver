const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ============================================================
// 配置
// ============================================================
const LOGIN_URL = 'https://secure.xserver.ne.jp/xapanel/login/xmgame';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

// ============================================================
// 工具函数
// ============================================================
function loadUsers() {
    if (process.env.USERS_JSON) {
        const users = JSON.parse(process.env.USERS_JSON);
        if (!Array.isArray(users) || users.length === 0) {
            throw new Error('USERS_JSON 必须是非空的对象数组');
        }
        console.log(`从环境变量加载了 ${users.length} 个用户`);
        return users;
    }

    const filePath = path.join(__dirname, 'users.json');
    if (fs.existsSync(filePath)) {
        const users = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(users) || users.length === 0) {
            throw new Error('users.json 必须是非空的对象数组');
        }
        console.log(`从 users.json 加载了 ${users.length} 个用户`);
        return users;
    }

    throw new Error('未找到用户配置：请设置 USERS_JSON 环境变量或创建 users.json 文件');
}

function ensureScreenshotDir() {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
}

async function safeScreenshot(page, filename) {
    try {
        const filePath = path.join(SCREENSHOT_DIR, filename);
        await page.screenshot({ path: filePath, fullPage: true });
        console.log(`  截图已保存: ${filePath}`);
        return filePath;
    } catch (err) {
        console.warn(`  截图失败: ${err.message}`);
        return null;
    }
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
                body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message }),
            });
        }
    } catch (err) {
        console.error('  TG 通知异常:', err.message);
    }
}

// ============================================================
// 单用户处理流程
// ============================================================
async function processUser(browser, user) {
    const tag = user.username || 'Unknown_User';
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    
    // 注入 Cookie (如果存在)
    let usingCookie = false;
    if (user.cookies && Array.isArray(user.cookies) && user.cookies.length > 0) {
        console.log(`  [${tag}] 检测到 Cookie 配置，尝试免密码登录...`);
        // Playwright 要求的 Cookie 格式，确保有 domain
        const formattedCookies = user.cookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain || '.xserver.ne.jp',
            path: c.path || '/'
        }));
        await context.addCookies(formattedCookies);
        usingCookie = true;
    }

    const page = await context.newPage();
    page.setDefaultTimeout(30_000); // 30秒超时

    try {
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

        // 检查当前页面是否还在登录界面 (判断有没有登录按钮)
        const loginBtn = page.getByRole('button', { name: 'ログインする' });
        const isLoginPage = await loginBtn.isVisible().catch(() => false);

        if (isLoginPage) {
            if (usingCookie) {
                throw new Error('Cookie 登录失败（Cookie 可能已过期失效），页面仍停留在登录页。请重新获取 Cookie！');
            } else {
                console.log(`  [${tag}] 执行账号密码登录...`);
                await page.getByRole('textbox', { name: 'XServerアカウントID または メールアドレス' }).fill(user.username);
                await page.locator('#user_password').fill(user.password);
                
                // 点击登录并等待页面加载
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}),
                    loginBtn.click()
                ]);
            }
        } else {
            console.log(`  [${tag}] Cookie 登录成功，已进入后台。`);
        }

        // ---- 进入管理页 ----
        const gameLink = page.getByRole('link', { name: 'ゲーム管理' });
        await gameLink.waitFor({ state: 'visible', timeout: 15000 }); // 等待元素出现
        await gameLink.click();
        await page.waitForLoadState('networkidle');

        // ---- 进入延长页 ----
        await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();

        // ---- 检查是否可延长 ----
        const extendLink = page.getByRole('link', { name: '期限を延長する' });
        try {
            await extendLink.waitFor({ state: 'visible', timeout: 5000 });
        } catch {
            const bodyText = await page.locator('body').innerText();
            const match = bodyText.match(/更新をご希望の場合は、(.+?)以降にお試しください。/);
            const reason = match?.[1] ? `下次可延长时间: ${match[1]}` : '未找到延长按钮，可能已达上限或非可用期';
            const msg = `⚠️ [${tag}] 跳过 — ${reason}`;
            console.log(`  ${msg}`);
            const img = await safeScreenshot(page, `skip_${tag}.png`);
            await notify(msg, img);
            return 'skipped';
        }

        await extendLink.click();

        // ---- 确认 & 执行 ----
        await page.getByRole('button', { name: '確認画面に進む' }).click();
        await page.getByRole('button', { name: '期限を延長する' }).click();
        await page.getByRole('link', { name: '戻る' }).click();

        const msg = `✅ [${tag}] 成功延长期限`;
        console.log(`  ${msg}`);
        const img = await safeScreenshot(page, `success_${tag}.png`);
        await notify(msg, img);
        return 'success';

    } catch (err) {
        const msg = `❌ [${tag}] 处理失败: ${err.message}`;
        console.error(`  ${msg}`);
        const img = await safeScreenshot(page, `error_${tag}.png`);
        await notify(msg, img);
        return 'failed';
    } finally {
        await context.close();
    }
}

// ============================================================
// 主流程
// ============================================================
(async () => {
    let users;
    try { users = loadUsers(); } catch (err) { console.error(err.message); process.exit(1); }
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

    const summary = [
        '📊 XServer 延期执行汇总',
        `✅ 成功 (${results.success.length}): ${results.success.join(', ') || '无'}`,
        `⚠️ 跳过 (${results.skipped.length}): ${results.skipped.join(', ') || '无'}`,
        `❌ 失败 (${results.failed.length}): ${results.failed.join(', ') || '无'}`,
    ].join('\n');
    await notify(summary);

    if (results.failed.length > 0) process.exit(1);
})();
