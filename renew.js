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

/**
 * 加载用户列表：优先环境变量 USERS_JSON，其次本地 users.json
 */
function loadUsers() {
    // 1. 尝试从环境变量读取
    if (process.env.USERS_JSON) {
        const users = JSON.parse(process.env.USERS_JSON);
        if (!Array.isArray(users) || users.length === 0) {
            throw new Error('USERS_JSON 必须是非空的对象数组');
        }
        console.log(`从环境变量加载了 ${users.length} 个用户`);
        return users;
    }

    // 2. 尝试从本地文件读取
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

/**
 * 确保截图目录存在
 */
function ensureScreenshotDir() {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
}

/**
 * 安全截图 —— 截图失败不抛出异常
 */
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

/**
 * 发送 Telegram 通知（支持纯文字 / 带图片）
 */
async function notify(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    try {
        if (imagePath && fs.existsSync(imagePath)) {
            const formData = new FormData();
            formData.append('chat_id', TG_CHAT_ID);
            formData.append('caption', message);
            formData.append(
                'photo',
                new Blob([fs.readFileSync(imagePath)]),
                path.basename(imagePath),
            );

            const res = await fetch(
                `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`,
                { method: 'POST', body: formData },
            );
            if (!res.ok) console.error('  TG 图片发送失败:', await res.text());
        } else {
            const res = await fetch(
                `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message }),
                },
            );
            if (!res.ok) console.error('  TG 消息发送失败:', await res.text());
        }
    } catch (err) {
        console.error('  TG 通知异常:', err.message);
    }
}

// ============================================================
// 单用户处理流程
// ============================================================
async function processUser(browser, user) {
    const tag = user.username;
    const context = await browser.newContext();
    const page = await context.newPage();

    // 设置全局超时，避免单用户卡死
    page.setDefaultTimeout(30_000);

    try {
        // ---- 登录 ----
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

        const emailInput = page.getByRole('textbox', {
            name: 'XServerアカウントID または メールアドレス',
        });
        await emailInput.fill(user.username);
        await page.locator('#user_password').fill(user.password);
        await page.getByRole('button', { name: 'ログインする' }).click();

        // ---- 进入管理页 ----
        await page.getByRole('link', { name: 'ゲーム管理' }).click();
        await page.waitForLoadState('networkidle');

        // ---- 进入延长页 ----
        await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();

        // ---- 检查是否可延长 ----
        const extendLink = page.getByRole('link', { name: '期限を延長する' });
        try {
            await extendLink.waitFor({ state: 'visible', timeout: 5000 });
        } catch {
            // 尝试提取下次可延长时间
            const bodyText = await page.locator('body').innerText();
            const match = bodyText.match(
                /更新をご希望の場合は、(.+?)以降にお試しください。/,
            );

            const reason = match?.[1]
                ? `下次可延长时间: ${match[1]}`
                : '未找到延长按钮';

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
    // 1. 加载用户
    let users;
    try {
        users = loadUsers();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    ensureScreenshotDir();

    // 2. 启动浏览器
    const browser = await chromium.launch({
        headless: true,
        channel: 'chrome',
    });

    // 3. 逐用户处理 & 收集结果
    const results = { success: [], skipped: [], failed: [] };

    for (const user of users) {
        console.log(`\n========== 处理用户: ${user.username} ==========`);
        const status = await processUser(browser, user);
        results[status].push(user.username);
    }

    await browser.close();

    // 4. 汇总报告
    console.log('\n========== 执行汇总 ==========');
    console.log(`  成功: ${results.success.length} — ${results.success.join(', ') || '无'}`);
    console.log(`  跳过: ${results.skipped.length} — ${results.skipped.join(', ') || '无'}`);
    console.log(`  失败: ${results.failed.length} — ${results.failed.join(', ') || '无'}`);

    // 发送汇总通知
    const summary = [
        '📊 XServer 延期执行汇总',
        `✅ 成功 (${results.success.length}): ${results.success.join(', ') || '无'}`,
        `⚠️ 跳过 (${results.skipped.length}): ${results.skipped.join(', ') || '无'}`,
        `❌ 失败 (${results.failed.length}): ${results.failed.join(', ') || '无'}`,
    ].join('\n');
    await notify(summary);

    // 有失败时以非零码退出，便于 CI 感知
    if (results.failed.length > 0) {
        process.exit(1);
    }
})();
