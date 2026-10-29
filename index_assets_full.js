require("dotenv").config();
const { chromium } = require("playwright");
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("fs");
const path = require("path");
const readline = require("readline");

// Default OU shown after login. If OU_INSTANCE_ASSETS is empty, null, or equals
// this string, the Change Context step is skipped.
// (Note the double space between "HO" and "OPERATING" — matches the Ramco label.)
const DEFAULT_OU_INSTANCE = "AAI WORLDWIDE LOGISTICS, INC. HO  OPERATING UNIT";

// Map full OU Instance label → short folder name used under
// output/Fixed Assets - Asset and Doc Details/.
// Unknown OUs fall back to a sanitized PascalCase version of the label.
const OU_FOLDER_MAP = {
  "AAI WORLDWIDE LOGISTICS, INC. HO  OPERATING UNIT": "AAIHO",
  "A2Z LOGISTICS INC.": "A2ZLogisticsInc",
};

function deriveOuFolder(ou) {
  const raw = (ou || DEFAULT_OU_INSTANCE).trim();
  const normalized = raw.replace(/\s+/g, ' ').toUpperCase();
  for (const [key, val] of Object.entries(OU_FOLDER_MAP)) {
    if (key.replace(/\s+/g, ' ').toUpperCase() === normalized) return val;
  }
  return raw
    .replace(/[,.]/g, '')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

// ─── CONFIG (loaded from .env) ─────────────────────────────────────────────
const CONFIG = {
  url:      process.env.RAMCO_URL      || "https://aai.ramcoes.com/RVW/extui/vwrt/LaunchPanel.htm",
  username: process.env.RAMCO_USERNAME || "",
  password: process.env.RAMCO_PASSWORD || "",
  // Dedicated OU Instance for the Asset Capitalization workflow.
  ouInstance: (process.env.OU_INSTANCE_ASSETS || "").trim(),
  headless: false,
  slowMo:   50,
  timeout:  30000,

  // Select Asset search filters (dd/mm/yyyy). All OPTIONAL — leave blank to
  // pull every asset for the Finance Book.
  capDateFrom:       process.env.CAP_DATE_FROM_ASSETS        || "",
  capDateTo:         process.env.CAP_DATE_TO_ASSETS          || "",
  inServiceDateFrom: process.env.IN_SERVICE_DATE_FROM_ASSETS || "",
  inServiceDateTo:   process.env.IN_SERVICE_DATE_TO_ASSETS   || "",

  // Settle delay (ms) around ticking a row's checkbox. Increase if you ever see
  // "Select atleast one row" — the grid wasn't interactive yet. Default 900ms.
  selectDelayMs: parseInt(process.env.SELECT_DELAY_MS || "900", 10) || 900,

  // Cap the number of assets processed in one run (handy while testing against
  // the 1773-row set). Blank/0 = process every row.
  maxAssets: parseInt(process.env.MAX_ASSETS_ASSETS || "0", 10) || 0,

  // Resume support: 1-based row index in the result set to start from.
  resumeFromRow: parseInt(process.env.RESUME_FROM_ASSET_ROW || "0", 10) || 0,
};

if (!CONFIG.username || !CONFIG.password) {
  console.error("❌ Missing credentials. Please set RAMCO_USERNAME and RAMCO_PASSWORD in your .env file.");
  process.exit(1);
}

// Short folder name for the active OU. Exports go under
// output/Fixed Assets - Asset and Doc Details/<OU_FOLDER>/<date>/...
const OU_FOLDER = deriveOuFolder(CONFIG.ouInstance || DEFAULT_OU_INSTANCE);
console.log(`📁 Output folder for this run: output/Fixed Assets - Asset and Doc Details/${OU_FOLDER}/`);

// Auto-resume checkpoint: a per-OU file that records every Asset No. already
// exported, so an interrupted run can be re-launched and skip what it finished.
const RESUME_FILE = `output/.assets-resume-${OU_FOLDER}.json`;

// ─── MENU PATH ─────────────────────────────────────────────────────────────
// Fixed Assets → Asset Capitalization → View Asset
// (the "View Asset" activity opens the "Select Asset" search screen)
const MENU_PATHS = [
  ["Fixed Assets", "Asset Capitalization", "View Asset"],
];

// Asset No. text pattern, e.g. "AAI/BDI-1" — a single token (no spaces) with a
// "/" and ending in "-<digits>". Used to read the Asset No. from a grid row.
const ASSET_NO_PATTERN = /^[^\s]+\/[^\s]+-\d+$/;

// Order in which checkbox-tick methods are attempted. Whichever first avoids the
// "Select atleast one row" popup AND loads the target screen wins.
// This Ramco grid renders the checkbox as an <img> (unchecked.gif/checked.gif)
// in a locked column, so "img" (click the image) is the primary method.
const TICK_MODES = ["img", "imgcell", "coords", "space"];

// CSS for the per-row checkbox image. The checkbox column's <img> src contains
// "check" (both "unchecked.gif" and "checked.gif" match); the header select-all
// is outside .x-grid3-row, so this indexes data rows only — one per row.
const CHECKBOX_IMG_SELECTOR = '.x-grid3-row img[src*="check"]';

// Dump the grid markup to a file just once, for diagnostics if selection fails.
let GRID_DEBUG_DUMPED = false;

// ─── HELPERS ───────────────────────────────────────────────────────────────
function waitForEnter(msg = "👉 Press ENTER to close the browser...") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("\n" + msg + "\n", () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Helper to get the actual Frame object (necessary for .evaluate / .waitForSelector).
 */
async function getFrame(page) {
  const frame = page.frames().find(
    (f) => f.name() === "ilboinnerframe" || f.url().includes("ilrt/rvw_blank.aspx") || f.url().includes("ilbo")
  );
  if (!frame) return page.mainFrame().childFrames()[0];
  return frame;
}

// ─── LOGIN ─────────────────────────────────────────────────────────────────
async function login(page) {
  console.log("📂 Navigating to Ramco VirtualWorks...");
  await page.goto(CONFIG.url, { waitUntil: "domcontentloaded" });

  console.log("  ⏳ Waiting for app shell to initialize...");
  await page.waitForTimeout(4000);

  console.log("  🔍 Scanning frames for login form...");
  let loginFrame = null;

  for (let attempt = 0; attempt < 12; attempt++) {
    const frames = page.frames();
    console.log(`  [attempt ${attempt + 1}] frames: ${frames.length}`);
    for (const frame of frames) {
      const url = frame.url();
      if (url === CONFIG.url || url === "about:blank" || url.includes("rvw_blank")) continue;
      const inputs = await frame.$$("input").catch(() => []);
      if (inputs.length > 0) {
        console.log(`  ✔ Login frame: name="${frame.name()}" url="${url}"`);
        loginFrame = frame;
        break;
      }
    }
    if (loginFrame) break;
    await page.waitForTimeout(2000);
  }

  if (!loginFrame) {
    for (const frame of page.frames()) {
      if (frame.name() === "ilboinnerframe") {
        const inputs = await frame.$$("input").catch(() => []);
        if (inputs.length > 0) loginFrame = frame;
      }
    }
  }

  if (!loginFrame) {
    throw new Error("❌ Could not find login frame.");
  }

  const userSel = "#ide_username";
  const pwSel   = "#ide_password";

  await loginFrame.waitForSelector(userSel, { state: "attached", timeout: CONFIG.timeout });
  await loginFrame.waitForSelector(pwSel,   { state: "attached", timeout: CONFIG.timeout });

  console.log("  ✏ Typing username...");
  await loginFrame.focus(userSel);
  await loginFrame.fill(userSel, "");
  await loginFrame.type(userSel, CONFIG.username, { delay: 30 });
  await page.waitForTimeout(200);

  console.log("  ✏ Typing password...");
  await loginFrame.focus(pwSel);
  await loginFrame.fill(pwSel, "");
  await loginFrame.type(pwSel, CONFIG.password, { delay: 30 });
  await page.waitForTimeout(300);

  console.log("  🖱 Pressing Enter to submit...");
  await loginFrame.press(pwSel, "Enter");
  await page.waitForTimeout(1000);

  const stillOnLogin = page.frames().some((f) => f.url().includes("security/login"));
  if (stillOnLogin) {
    console.log("  ⚠ Still on login — trying JS anchor click...");
    await loginFrame.evaluate((pwSel) => {
      const anchors = Array.from(document.querySelectorAll("a"));
      const btn = anchors.find(
        (a) => a.offsetParent !== null && !a.id.includes("forgot") && !/forgot/i.test(a.innerText)
      );
      if (btn) { btn.click(); return; }
      const form = document.querySelector("form");
      if (form) { form.submit(); return; }
      const pw = document.querySelector(pwSel);
      if (pw) ["keydown", "keypress", "keyup"].forEach((t) =>
        pw.dispatchEvent(new KeyboardEvent(t, { key: "Enter", keyCode: 13, bubbles: true }))
      );
    }, pwSel);
    await page.waitForTimeout(2000);
  }

  console.log("✅ Login complete.");
}

// ─── CHANGE CONTEXT (User Menu → Change Context → SwitchContexts) ──────────
async function changeContext(page, ouInstance) {
  const target = (ouInstance || "").trim();

  if (!target || target === DEFAULT_OU_INSTANCE) {
    console.log(`\n🔄 OU Instance unchanged (using default: "${DEFAULT_OU_INSTANCE}").`);
    return;
  }

  console.log(`\n🔄 Switching OU Instance → "${target}"...`);

  await page.waitForSelector('#userinfo', { timeout: CONFIG.timeout });
  await page.waitForTimeout(800);

  console.log('  🖱 Opening User Menu (#userinfo)...');
  await page.locator('#userinfo').first().click();
  await page.waitForTimeout(500);

  console.log('  🖱 Clicking "Change Context"...');
  const changeCtxItem = page.locator(
    '.x-menu-item-text:has-text("Change Context"), [qtip="Change Context"], a:has-text("Change Context")'
  ).first();
  await changeCtxItem.waitFor({ state: 'visible', timeout: CONFIG.timeout });
  await changeCtxItem.click();

  console.log('  ⏳ Waiting for SwitchContexts dialog...');
  await page.waitForTimeout(1500);

  const scopes = [page, ...page.frames()];
  let scope = null;
  let ouInputHandle = null;

  for (let attempt = 0; attempt < 10 && !ouInputHandle; attempt++) {
    for (const s of scopes) {
      try {
        const handle = await s.evaluateHandle(() => {
          const all = document.querySelectorAll('div, td, span, label');
          let labelEl = null;
          for (const el of all) {
            const own = Array.from(el.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent.trim())
              .join(' ')
              .trim();
            if (own === 'OU Instance' || /^OU\s+Instance$/i.test(own)) { labelEl = el; break; }
          }
          if (!labelEl) return null;

          let container = labelEl.parentElement;
          for (let i = 0; i < 6 && container; i++) {
            const inp = container.querySelector('input[type="text"], input:not([type])');
            if (inp && !labelEl.contains(inp)) return inp;
            container = container.parentElement;
          }
          let next = labelEl.nextElementSibling;
          while (next) {
            if (next.tagName === 'INPUT') return next;
            const inp = next.querySelector && next.querySelector('input');
            if (inp) return inp;
            next = next.nextElementSibling;
          }
          return null;
        });

        const el = handle.asElement();
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) { scope = s; ouInputHandle = el; break; }
        }
      } catch (_) { /* frame might be detached */ }
    }
    if (!ouInputHandle) await page.waitForTimeout(500);
  }

  if (!ouInputHandle) {
    throw new Error("❌ Could not locate the OU Instance input in the SwitchContexts dialog.");
  }

  console.log('  ✏ Filling OU Instance...');
  await ouInputHandle.scrollIntoViewIfNeeded().catch(() => {});
  await ouInputHandle.click({ clickCount: 3 }).catch(async () => { await ouInputHandle.focus(); });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(target, { delay: 30 });
  await page.waitForTimeout(900);

  const dropdownItem = scope.locator(
    `.x-combo-list-item:has-text("${target}"), li:has-text("${target}")`
  ).first();
  if (await dropdownItem.isVisible({ timeout: 1500 }).catch(() => false)) {
    await dropdownItem.click();
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(500);

  console.log('  🖱 Clicking OK...');
  const okBtn = scope.locator(
    'button:has-text("OK"), .x-btn-text:has-text("OK"), input[type="button"][value="OK"]'
  ).first();
  if (await okBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await okBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  console.log('  ⏳ Waiting for context to switch...');
  await page.waitForTimeout(4500);
  await page.waitForSelector('#userinfo', { timeout: CONFIG.timeout }).catch(() => {});

  const userInfoText = await page.locator('#userinfo').first().innerText().catch(() => "");
  if (userInfoText && userInfoText.toUpperCase().includes(target.toUpperCase())) {
    console.log(`✅ OU Instance switched to "${target}".`);
  } else {
    console.warn(`  ⚠ Could not verify OU switch from toolbar text: "${userInfoText.replace(/\s+/g, ' ').trim()}"`);
  }
}

// ─── GO TO LANDING PAGE ────────────────────────────────────────────────────
async function goToLandingPage(page) {
  console.log("\n🏠 Navigating to landing/home page...");
  await page.waitForTimeout(3000);

  const homeSelectors = [
    "#tb-homepage button",
    "button.x-icon-uhome",
    'div[qtip="Go to Home Page"]',
    'div.x-tool-uhome',
    '#home button',
  ];

  for (const sel of homeSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        console.log(`  ✔ Clicked home: ${sel}`);
        await page.waitForSelector('#tb-bpc-menu', { timeout: 8000 }).catch(() => {});
        break;
      }
    } catch (_) {}
  }

  await page.waitForSelector('#tb-bpc-menu', { timeout: 10000 }).catch(() => {});
}

// ─── NAVIGATE MENU ─────────────────────────────────────────────────────────
async function navigateMenu(page, menuPath) {
  console.log(`\n📋 Navigating: ${menuPath.join(" → ")}`);

  const isMenuCollapsed = await page.evaluate(() => {
    const tp = document.getElementById('ilbo-tp');
    const collapsedBar = document.getElementById('ilbo-tp-xcollapsed');
    return !tp || tp.classList.contains('x-panel-collapsed') || (collapsedBar && window.getComputedStyle(collapsedBar).display !== 'none');
  });

  if (isMenuCollapsed) {
    console.log("  📂 Menu is collapsed. Expanding...");
    const expandSelectors = ['#tb-bpc-menu button', '#ext-gen309', '.x-tool-expand-west'];
    for (const sel of expandSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(2000);
        break;
      }
    }
  }

  for (let i = 0; i < menuPath.length; i++) {
    const label = menuPath[i];
    console.log(`  [${i + 1}/${menuPath.length}] Looking for "${label}"...`);

    let clicked = false;
    const selectors = [
      `.x-menu-item-text:has-text("${label}")`,
      `.x-menu-item:has-text("${label}")`,
      `.x-tree-node-text:has-text("${label}")`,
      `.x-tree-node-anchor:has-text("${label}")`,
      `span:has-text("${label}")`,
      `a:has-text("${label}")`,
      `div:has-text("${label}")`,
    ];

    for (const sel of selectors) {
      try {
        const el = page.locator(sel).filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }).first();
        if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          if (i < menuPath.length - 1) {
            console.log(`    🖱 Hovering "${label}"...`);
            await el.hover({ force: true }).catch(() => {});
            await page.waitForTimeout(400);
          }
          console.log(`    🖱 Clicking "${label}"...`);
          await el.click();
          await page.waitForTimeout(1000);
          console.log(`    ✔ Clicked "${label}" via: ${sel}`);
          clicked = true;
          break;
        }
      } catch (_) {}
    }

    if (!clicked) {
      console.warn(`    ⚠ Exact match for "${label}" failed. Trying generic visibility...`);
      try {
        const looseEl = page.getByText(label).filter({ visible: true }).first();
        if (await looseEl.isVisible({ timeout: 2000 }).catch(() => false)) {
          if (i < menuPath.length - 1) {
            await looseEl.hover().catch(() => {});
            await page.waitForTimeout(1000);
          }
          await looseEl.click();
          await page.waitForTimeout(2500);
          console.log(`    ✔ Clicked "${label}" via visibility filter`);
          clicked = true;
        }
      } catch (_) {}
    }

    if (!clicked) {
      console.error(`    ❌ FAILED to find "${label}"`);
      if (i === menuPath.length - 1) {
        console.log("    🔍 Attempting search box fallback for final item...");
        await page.fill('#bpcsearch', label);
        await page.waitForTimeout(500);
        await page.press('#bpcsearch', 'Enter');
        await page.waitForTimeout(4000);
        console.log("    ✔ Search submitted.");
        clicked = true;
      }
    }
  }

  console.log("  ⏳ Waiting for page to load...");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);

  return { menuPath, url: page.url() };
}

// ─── PERFORM SEARCH (Select Asset screen) ──────────────────────────────────
/**
 * Fills any optional date filters and clicks the Search button on the Select
 * Asset screen, then reports how many rows the grid found.
 */
async function performAssetSearch(page) {
  console.log("\n🔍 Preparing to search assets inside frame...");
  const frame = await getFrame(page);
  if (!frame) throw new Error("Could not find ilboinnerframe");

  try {
    // Optional date filters. Each label is followed by a [From] input then a
    // "To" input → following::input[1] = From, following::input[2] = To.
    const fillDateField = async (labelText, position, value) => {
      if (!value) return false;
      const field = frame.locator(
        `xpath=//label[contains(text(), "${labelText}")]/following::input[${position}] | ` +
        `//td[contains(text(), "${labelText}")]/following::input[${position}] | ` +
        `//span[contains(text(), "${labelText}")]/following::input[${position}]`
      ).first();
      if (await field.isVisible({ timeout: 3000 }).catch(() => false)) {
        await field.click();
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.press('Delete');
        await field.fill(value);
        await page.keyboard.press('Tab');
        return true;
      }
      console.warn(`  ⚠️ Date field not found for "${labelText}" (position ${position}).`);
      return false;
    };

    if (CONFIG.capDateFrom || CONFIG.capDateTo) {
      console.log(`  📅 Capitalization Date: ${CONFIG.capDateFrom || "(blank)"} → ${CONFIG.capDateTo || "(blank)"}`);
      await fillDateField("Capitalization Date From", 1, CONFIG.capDateFrom);
      await fillDateField("Capitalization Date From", 2, CONFIG.capDateTo);
    }
    if (CONFIG.inServiceDateFrom || CONFIG.inServiceDateTo) {
      console.log(`  📅 In-Service Date: ${CONFIG.inServiceDateFrom || "(blank)"} → ${CONFIG.inServiceDateTo || "(blank)"}`);
      await fillDateField("In-Service Date From", 1, CONFIG.inServiceDateFrom);
      await fillDateField("In-Service Date From", 2, CONFIG.inServiceDateTo);
    }
    if (!CONFIG.capDateFrom && !CONFIG.capDateTo && !CONFIG.inServiceDateFrom && !CONFIG.inServiceDateTo) {
      console.log("  ℹ No date filters set — searching all assets for the Finance Book.");
    }

    // Click Search.
    console.log('  🖱 Clicking "Search" button...');
    const searchBtn = frame.locator('button, .x-btn-text').filter({ hasText: /^Search$/i }).last();
    if (await searchBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await searchBtn.click();
      console.log("  🚀 Search triggered.");
      await frame.locator('.x-grid3-row').first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {
        console.log("  ⏳ Still waiting for grid rows...");
      });
    } else {
      console.error("  ❌ Search button not found in frame.");
    }

    // Report grid totals using the real pager (input + "- end / total" button).
    const info = await getPageInfo(page);
    const visibleRows = await countRowsOnPage(page);
    const stats = { total: info.total, visibleRows, pagingText: info.raw };

    console.log(`  ✔ Grid: total ${stats.total} rows, ${stats.visibleRows} on current page. (pager: "${stats.pagingText}")`);
    return stats;

  } catch (error) {
    console.error(`  ❌ Search failed: ${error.message}`);
    return { total: 0, visibleRows: 0 };
  }
}

// ─── ROW SELECTION + FOOTER LINKS ──────────────────────────────────────────
/**
 * Writes the grid markup to output/_debug_grid_row.html once, so the exact
 * checkbox structure can be inspected if selection misbehaves.
 */
async function dumpGridDebug(page, rowIdx) {
  if (GRID_DEBUG_DUMPED) return;
  GRID_DEBUG_DUMPED = true;
  const frame = await getFrame(page);
  if (!frame) return;
  const d = await frame.evaluate((rowIdx) => {
    const rows = document.querySelectorAll('.x-grid3-row');
    const row = rows[rowIdx] || rows[0];
    const totalInputs = document.querySelectorAll('.x-grid3-row input[type="checkbox"]').length;
    const checkerCells = document.querySelectorAll('.x-grid3-row-checker, .x-grid3-td-checker, .x-grid3-check-col').length;
    const locked = !!document.querySelector('.x-grid3-locked, .x-grid-locked');
    const body = row && row.parentElement ? row.parentElement.outerHTML.slice(0, 8000) : "";
    return {
      summary: `totalRows=${rows.length} totalRowCheckboxes=${totalInputs} checkerCells=${checkerCells} lockedGrid=${locked}`,
      rowHtml: row ? row.outerHTML : "(no row)",
      body,
    };
  }, rowIdx).catch((e) => ({ summary: `dump failed: ${e.message}`, rowHtml: "", body: "" }));
  console.log(`  🔎 [debug] ${d.summary}`);
  try {
    const { writeFileSync } = require("fs");
    writeFileSync("output/_debug_grid_row.html",
      `${d.summary}\n\n=== TARGET ROW ===\n${d.rowHtml}\n\n=== GRID BODY ===\n${d.body}`);
    console.log("  🔎 [debug] wrote output/_debug_grid_row.html");
  } catch (_) {}
}

/**
 * Whether the rowIdx-th row's checkbox is ticked. This Ramco grid swaps the
 * checkbox <img> between "unchecked.gif" and "checked.gif", so we read its src.
 * (Falls back to a real <input> if a different screen uses one.)
 */
async function isRowChecked(page, rowIdx) {
  const frame = await getFrame(page);
  if (!frame) return false;
  return await frame.evaluate((rowIdx) => {
    const imgs = Array.from(document.querySelectorAll('.x-grid3-row img'))
      .filter((im) => /check|tick/i.test(im.getAttribute('src') || ''));
    if (imgs.length) {
      const img = imgs[rowIdx];
      if (!img) return false;
      const src = img.getAttribute('src') || '';
      return !/unchecked|uncheck/i.test(src);
    }
    const inputs = document.querySelectorAll('.x-grid3-row input[type="checkbox"]');
    if (inputs.length) return inputs[rowIdx] ? !!inputs[rowIdx].checked : false;
    return false;
  }, rowIdx).catch(() => false);
}

/**
 * Reads the Asset No. shown in the rowIdx-th grid row (empty if none).
 */
async function readAssetNo(page, rowIdx) {
  const frame = await getFrame(page);
  if (!frame) return "";
  const list = await frame.evaluate((patternSrc) => {
    const pattern = new RegExp(patternSrc);
    const out = [];
    document.querySelectorAll('.x-grid3-row').forEach((row) => {
      for (const c of row.querySelectorAll('.x-grid3-cell-inner, td')) {
        const t = (c.innerText || c.textContent || '').trim();
        if (pattern.test(t)) { out.push(t); break; }
      }
    });
    return out;
  }, ASSET_NO_PATTERN.source).catch(() => []);
  return list[rowIdx] || "";
}

/**
 * Performs ONE checkbox-tick attempt on the rowIdx-th row using `mode`:
 *   img     — real-click the checkbox <img>
 *   imgcell — click the <td> cell that holds the checkbox <img>
 *   coords  — physical mouse click on the <img>'s centre
 *   space   — focus the row and press Space
 */
async function tickRow(page, rowIdx, mode) {
  const fl = page.frameLocator("#ilboinnerframe");
  const frame = await getFrame(page);
  const settle = CONFIG.selectDelayMs;
  const img = fl.locator(CHECKBOX_IMG_SELECTOR).nth(rowIdx);

  if (mode === "img") {
    if (await img.count().catch(() => 0)) {
      await img.scrollIntoViewIfNeeded().catch(() => {});
      await img.click({ force: true, timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(settle);
    }
  } else if (mode === "imgcell") {
    if (await img.count().catch(() => 0)) {
      const cell = img.locator('xpath=ancestor::td[1]');
      await cell.click({ force: true, timeout: 4000 }).catch(async () => {
        await img.click({ force: true }).catch(() => {});
      });
      await page.waitForTimeout(settle);
    }
  } else if (mode === "coords" && frame) {
    const rect = await frame.evaluate((rowIdx) => {
      const imgs = Array.from(document.querySelectorAll('.x-grid3-row img'))
        .filter((im) => /check|tick/i.test(im.getAttribute('src') || ''));
      const el = imgs[rowIdx];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, rowIdx).catch(() => null);
    const box = await page.locator('#ilboinnerframe').boundingBox().catch(() => null);
    if (rect && box) {
      await page.mouse.click(box.x + rect.x + rect.w / 2, box.y + rect.y + rect.h / 2);
      await page.waitForTimeout(settle);
    }
  } else if (mode === "space") {
    const rowCell = fl.locator('.x-grid3-row').nth(rowIdx).locator('.x-grid3-cell-inner').first();
    if (await rowCell.count().catch(() => 0)) {
      await rowCell.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.press(' ').catch(() => {});
      await page.waitForTimeout(settle);
    }
  }

  return await isRowChecked(page, rowIdx);
}

/**
 * Clicks a footer hyperlink (e.g. "View Asset Details"). Ramco renders these as
 * styled <span>/<div> elements, so we JS-dispatch a real click on the innermost
 * element whose own text is exactly the label, with a Playwright fallback.
 */
async function clickFooterLink(page, label) {
  console.log(`  🖱 Clicking "${label}"...`);
  const frame = await getFrame(page);

  let clicked = false;
  if (frame) {
    clicked = await frame.evaluate((label) => {
      const isVisible = (el) => {
        if (!el || el.offsetParent === null) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      for (const el of document.querySelectorAll('*')) {
        if (!isVisible(el)) continue;
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent.trim())
          .join('');
        if (directText !== label) continue;
        const rect = el.getBoundingClientRect();
        ['mousedown', 'mouseup', 'click'].forEach((t) =>
          el.dispatchEvent(new MouseEvent(t, {
            bubbles: true, cancelable: true, view: window,
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0,
          }))
        );
        return true;
      }
      return false;
    }, label);
  }

  if (!clicked) {
    try {
      const link = page.frameLocator("#ilboinnerframe").getByText(label, { exact: true }).first();
      await link.waitFor({ state: "visible", timeout: 5000 });
      await link.click({ force: true });
      clicked = true;
    } catch (e) {
      console.error(`    ❌ Could not click "${label}": ${e.message}`);
    }
  }
  if (clicked) console.log(`    ✔ Clicked "${label}".`);
  await page.waitForTimeout(1200);
  return clicked;
}

/**
 * Detects and closes the VirtualWorks message popup (e.g. "Select atleast one
 * row of multiline"). Returns true if a popup was found and closed.
 */
async function closeMessagePopup(page) {
  const scopes = [page, page.frameLocator("#ilboinnerframe")];
  for (const root of scopes) {
    const candidates = [
      root.locator('#message-panel'),
      root.locator('.x-window:has-text("Message")'),
      root.locator('.x-window:has-text("atleast one row")'),
    ];
    for (const c of candidates) {
      const panel = c.first();
      if (await panel.isVisible({ timeout: 400 }).catch(() => false)) {
        const closeBtn = panel.locator('button, .x-btn-text').filter({ hasText: /^Close$/i }).first();
        if (await closeBtn.isVisible({ timeout: 400 }).catch(() => false)) {
          await closeBtn.click({ force: true }).catch(() => {});
        } else {
          await panel.locator('.x-tool-close').first().click({ force: true }).catch(() => {});
        }
        await page.waitForTimeout(400);
        return true;
      }
    }
  }
  return false;
}

/**
 * Unchecks every currently-ticked row in the active grid. Needed because
 * Ramco's multiline grid keeps prior selections — without clearing, selecting
 * tag 2 after tag 1 leaves BOTH checked and the footer link is rejected.
 */
async function clearAllRowChecks(page) {
  const imgs = page.frameLocator("#ilboinnerframe").locator(CHECKBOX_IMG_SELECTOR);
  const n = await imgs.count().catch(() => 0);
  let cleared = 0;
  for (let k = 0; k < n; k++) {
    if (await isRowChecked(page, k)) {
      await imgs.nth(k).click({ force: true }).catch(() => {});
      await page.waitForTimeout(200);
      cleared++;
    }
  }
  if (cleared) console.log(`  ↺ Cleared ${cleared} pre-existing row selection(s).`);
}

/**
 * Selects ONLY the row at `rowIdx`, then opens `linkLabel`, confirming the
 * target screen (`expectText`) loaded. Clears any prior selection first, then
 * cycles through TICK_MODES using the Ramco "Select atleast one row" popup as
 * the authoritative "not selected" signal. Returns { ok, assetNo }.
 */
async function selectRowAndOpen(page, rowIdx, linkLabel, expectText) {
  await page.frameLocator("#ilboinnerframe").locator('.x-grid3-row').nth(rowIdx)
    .waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  // Let the grid finish rendering / become interactive before clicking.
  await page.waitForTimeout(CONFIG.selectDelayMs);
  await dumpGridDebug(page, rowIdx);

  // Clear leftover selections so only the target row ends up checked.
  await clearAllRowChecks(page);

  const assetNo = await readAssetNo(page, rowIdx);

  for (const mode of TICK_MODES) {
    const checked = await tickRow(page, rowIdx, mode);
    console.log(`  • select row ${rowIdx + 1} via "${mode}" → checkbox=${checked ? "ticked" : "?"}`);

    await page.waitForTimeout(Math.round(CONFIG.selectDelayMs / 2));
    await clickFooterLink(page, linkLabel);

    // Ground truth: if Ramco complains, this method didn't select the row.
    if (await closeMessagePopup(page)) {
      console.warn(`    ⚠ "${mode}" did not select the row — trying next method...`);
      continue;
    }

    const loaded = await page.frameLocator("#ilboinnerframe")
      .getByText(expectText, { exact: false }).first()
      .waitFor({ state: "attached", timeout: 12000 })
      .then(() => true).catch(() => false);
    if (loaded) {
      console.log(`  ☑ Row ${rowIdx + 1} selected via "${mode}".`);
      await page.waitForTimeout(500);
      return { ok: true, assetNo };
    }

    console.warn(`    ⚠ "${expectText}" not detected after "${linkLabel}" (mode "${mode}").`);
    await closeMessagePopup(page);
  }

  return { ok: false, assetNo };
}

/**
 * Filesystem-safe version of an Asset No. (e.g. "AAI/BDI-1" → "AAI_BDI-1").
 */
function safeAssetFolder(assetNo) {
  return (assetNo || "UnknownAsset").replace(/[\\/:*?"<>|]/g, "_").trim();
}

// ─── AUTO-RESUME CHECKPOINT ────────────────────────────────────────────────
// Keyed by Asset No. (not row index), so a restarted run skips the assets it
// already exported even if the grid order shifts. The file is deleted once a
// run completes in full; an interrupted run simply leaves it on disk.
function loadDoneAssets(file) {
  try {
    if (!existsSync(file)) return new Set();
    const data = JSON.parse(readFileSync(file, "utf8"));
    return new Set(Array.isArray(data.done) ? data.done : []);
  } catch (_) { return new Set(); }
}

function saveDoneAssets(file, doneSet, total) {
  try {
    writeFileSync(file, JSON.stringify({
      updatedAt: new Date().toISOString(),
      total,
      done: [...doneSet],
    }, null, 2));
  } catch (_) {}
}

function clearDoneAssets(file) {
  try { if (existsSync(file)) rmSync(file); } catch (_) {}
}

/**
 * Reads the Ramco grid pager and returns { start, end, total, raw }.
 *
 * This grid's pager has a "page text" input holding the start row (1, 6, 11…)
 * plus a button reading "- <end> / <total>" (e.g. "- 5 / 1773"). There is no
 * standard .x-paging-info element.
 */
async function getPageInfo(page) {
  const frame = await getFrame(page);
  if (!frame) return { start: 0, end: 0, total: 0, raw: "" };
  return await frame.evaluate(() => {
    const n = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10) || 0;

    const input = document.querySelector('input[id^="pageText_"]');
    const start = input ? n(input.value) : 0;

    // Search the pager toolbar (the input's toolbar ancestor) for "<end> / <total>".
    let scope = input;
    for (let i = 0; i < 10 && scope && !/x-toolbar/.test(scope.className || ''); i++) {
      scope = scope.parentElement;
    }
    scope = scope || document;

    let end = 0, total = 0, raw = "";
    for (const el of scope.querySelectorAll('button, .x-btn-text, em, td, span, div')) {
      const t = (el.textContent || "").trim();
      const m = t.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
      if (m) { end = n(m[1]); total = n(m[2]); raw = `${start} ${t}`; break; }
    }
    return { start, end, total, raw: raw.trim() };
  });
}

/**
 * Clicks a pager nav tool by its tool class (e.g. ".x-tool-next1" for next,
 * ".x-tool-left" for first). Returns true if the element was found/clicked.
 */
async function pagerClick(page, toolClass) {
  const btn = page.frameLocator("#ilboinnerframe").locator(toolClass).first();
  if (!(await btn.count().catch(() => 0))) return false;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ force: true }).catch(() => {});
  return true;
}

/**
 * Waits until the pager's start row changes from `beforeStart` (confirms a page
 * actually advanced). Returns true on change, false on timeout.
 */
async function waitStartChanged(page, beforeStart, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const s = (await getPageInfo(page)).start;
    if (s && s !== beforeStart) return true;
  }
  return false;
}

/**
 * One-time diagnostic: dump the pagination toolbar markup to a file so the real
 * "next page" control can be identified.
 */
let PAGER_DEBUG_DUMPED = false;
async function dumpPagerDebug(page) {
  if (PAGER_DEBUG_DUMPED) return;
  PAGER_DEBUG_DUMPED = true;
  const frame = await getFrame(page);
  if (!frame) return;
  const html = await frame.evaluate(() => {
    const out = [];
    const info = document.querySelector('.x-paging-info');
    if (info) {
      let t = info;
      for (let i = 0; i < 8 && t.parentElement; i++) {
        if (/x-toolbar|bbar|paging|tbar/i.test(t.className)) break;
        t = t.parentElement;
      }
      out.push('[.x-paging-info ancestor]\n' + t.outerHTML.slice(0, 5000));
    }
    // Any element whose text is exactly "N - M / T" (the page indicator).
    for (const el of document.querySelectorAll('div, span, td, table, input')) {
      const txt = (el.value || el.textContent || '').trim();
      if (/^\d[\d,]*\s*-\s*\d[\d,]*\s*\/\s*\d[\d,]*$/.test(txt) && el.children.length < 4) {
        let t = el;
        for (let i = 0; i < 10 && t.parentElement; i++) {
          if (/x-toolbar|bbar|paging|tbar/i.test(t.className)) break;
          t = t.parentElement;
        }
        out.push('[page-indicator ancestor]\n' + t.outerHTML.slice(0, 5000));
        break;
      }
    }
    const tbs = document.querySelectorAll('.x-toolbar, .x-panel-bbar');
    tbs.forEach((tb, i) => out.push(`[toolbar ${i}]\n` + tb.outerHTML.slice(0, 3000)));
    return out.join('\n\n========\n\n') || '(no pager elements found)';
  }).catch((e) => '(dump failed: ' + e.message + ')');
  try {
    writeFileSync('output/_debug_pager.html', html);
    console.log('  🔎 [debug] wrote output/_debug_pager.html');
  } catch (_) {}
}

/**
 * Counts the rows rendered on the current grid page (one checkbox image per row).
 */
async function countRowsOnPage(page) {
  const frame = await getFrame(page);
  if (!frame) return 0;
  return await frame.evaluate((sel) => {
    const byImg = document.querySelectorAll(sel).length;
    if (byImg) return byImg;
    // Fallback: rows in the largest grid body (handles grids whose checkbox
    // column isn't an <img src*="check">).
    let max = 0;
    document.querySelectorAll('.x-grid3-body').forEach((b) => {
      const r = b.querySelectorAll('.x-grid3-row').length;
      if (r > max) max = r;
    });
    return max;
  }, CHECKBOX_IMG_SELECTOR).catch(() => 0);
}

/**
 * Navigates the grid to a 1-based page by jumping to the first page, then
 * clicking "next" (target - 1) times. Deterministic regardless of current page.
 */
async function goToPage(page, targetPage) {
  console.log(`  📑 Navigating to page ${targetPage}...`);
  let before = (await getPageInfo(page)).start;
  if (before !== 1) {
    await pagerClick(page, '.x-tool-left');   // first page
    await waitStartChanged(page, before);
  }
  for (let p = 1; p < targetPage; p++) {
    before = (await getPageInfo(page)).start;
    if (!(await pagerClick(page, '.x-tool-next1'))) break;
    if (!(await waitStartChanged(page, before))) break;
  }
}

/**
 * Ensures the grid is showing `targetPage`. If it's on an earlier page it
 * advances with single "Next" clicks (efficient); if it's somehow past the
 * target it resets via goToPage. Returns true on success.
 */
async function ensureOnPage(page, targetPage, pageSize) {
  const info = await getPageInfo(page);
  const curPage = info.start ? Math.floor((info.start - 1) / pageSize) + 1 : 1;
  if (curPage === targetPage) return true;

  if (curPage > targetPage) {
    await goToPage(page, targetPage);
    return true;
  }

  for (let p = curPage; p < targetPage; p++) {
    const before = (await getPageInfo(page)).start;
    if (!(await pagerClick(page, '.x-tool-next1'))) return false;
    if (!(await waitStartChanged(page, before))) return false;
  }
  return true;
}

/**
 * Clicks the toolbar "Go back" button (the left-arrow in the dashboard chrome
 * above the iframe), then waits for the screen to settle.
 */
async function goBack(page) {
  console.log("  🔙 Clicking Go back...");
  try {
    const backBtn = page.locator('#back button, button[qtip="Go back"], [qtip="Go back"], .x-tool-back').first();
    await backBtn.waitFor({ state: "attached", timeout: 10000 });
    await backBtn.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await backBtn.click({ force: true, timeout: 5000 });
    } catch (_) {
      const alt = page.locator('button, a, .x-btn-text').filter({ hasText: /Go back/i }).first();
      await alt.evaluate((el) => el.click()).catch(() => {});
    }
  } catch (error) {
    console.error(`  ❌ Go back failed: ${error.message}`);
  }
  await page.waitForTimeout(1500);
}

// ─── EXPORT GRID TO EXCEL ──────────────────────────────────────────────────
/**
 * Exports the currently-displayed grid to Excel and saves it to `savePath`
 * (extension is taken from the server's suggested filename).
 *
 * Primary strategy: click the toolbar button titled "Export to Excel" (the
 * highlighted icon in the screenshots). Fallback: focus the grid and press
 * Shift+E (Ramco's standard export shortcut). Returns the saved path or null.
 */
async function exportGridToExcel(page, savePath) {
  const frame = await getFrame(page);
  mkdirSync(path.dirname(savePath), { recursive: true });

  // Find and click the "Export to Excel" toolbar icon. Ramco sets the title on
  // a qtip/title/ext:qtip attribute; we prefer an exact "export to excel" hint
  // over a generic one (the toolbar also has PDF / chart icons).
  const clickExportIcon = async () => {
    if (!frame) return false;
    return await frame.evaluate(() => {
      const isVisible = (el) => el && el.offsetParent !== null;
      const hintOf = (el) =>
        `${el.getAttribute('qtip') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('ext:qtip') || ''} ${el.className || ''} ${el.id || ''}`.toLowerCase();
      let best = null, bestScore = 0;
      for (const el of document.querySelectorAll('button, a, div, img, span')) {
        if (!isVisible(el)) continue;
        const h = hintOf(el);
        let score = 0;
        if (/export to excel/.test(h)) score = 3;   // exact button title
        else if (/excel|xls/.test(h)) score = 2;
        else if (/export/.test(h)) score = 1;
        if (score > bestScore) { best = el; bestScore = score; }
      }
      if (!best) return false;
      const r = best.getBoundingClientRect();
      ['mousedown', 'mouseup', 'click'].forEach((t) =>
        best.dispatchEvent(new MouseEvent(t, {
          bubbles: true, cancelable: true, view: window,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
        }))
      );
      return true;
    });
  };

  try {
    console.log('  🖱 Clicking "Export to Excel"...');
    let downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    const iconClicked = await clickExportIcon();
    let download = iconClicked ? await downloadPromise.catch(() => null) : null;

    if (!download) {
      console.warn("  ⚠ Export icon produced no download — trying Shift+E...");
      const fl = page.frameLocator("#ilboinnerframe");
      await fl.locator('.x-grid3-row').first().click({ force: true }).catch(async () => {
        await fl.locator('.x-grid3-scroller, .x-grid3-viewport, .x-grid3').first().click({ force: true }).catch(() => {});
      });
      await page.waitForTimeout(200);
      downloadPromise = page.waitForEvent('download', { timeout: 30000 });
      await page.keyboard.down('Shift');
      await page.keyboard.press('E');
      await page.keyboard.up('Shift');
      download = await downloadPromise.catch(() => null);
    }

    if (!download) {
      console.error("  ❌ No Excel download was produced.");
      return null;
    }

    const suggestedName = download.suggestedFilename();
    const ext = suggestedName.includes('.') ? suggestedName.split('.').pop() : 'xls';
    const finalPath = savePath.endsWith(`.${ext}`) ? savePath : `${savePath}.${ext}`;

    let savedPath = finalPath;
    try {
      await download.saveAs(finalPath);
    } catch (saveErr) {
      const locked = /EBUSY|EPERM|EACCES|locked/i.test(saveErr.message);
      if (!locked) throw saveErr;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      savedPath = finalPath.replace(new RegExp(`\\.${ext}$`), ` (${stamp}).${ext}`);
      console.warn(`  ⚠ Target file locked (likely open in Excel). Saving as: ${savedPath}`);
      await download.saveAs(savedPath);
    }

    console.log(`  ✅ Saved → ${savedPath}`);
    return savedPath;

  } catch (error) {
    console.error(`  ❌ Excel export failed: ${error.message}`);
    return null;
  }
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync("screenshots", { recursive: true });
  mkdirSync("output", { recursive: true });

  const browser = await chromium.launch({ headless: CONFIG.headless, slowMo: CONFIG.slowMo });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page    = await context.newPage();

  try {
    const startTime = Date.now();

    // Step 1 — login + navigate to the menu.
    await login(page);
    await changeContext(page, CONFIG.ouInstance);
    await goToLandingPage(page);
    await navigateMenu(page, MENU_PATHS[0]);

    // Step 2 — hit Search.
    const stats = await performAssetSearch(page);
    await dumpPagerDebug(page);   // diagnostic: capture the pager markup once

    // Step 3 — export the search-results grid to Excel.
    const dateFolder = new Date().toISOString().split('T')[0];
    const baseDir = `output/Fixed Assets - Asset and Doc Details/${OU_FOLDER}/${dateFolder}`;
    console.log("\n📁 Step 3: Exporting search results grid (Export to Excel)...");
    const listExport = await exportGridToExcel(page, `${baseDir}/Asset List`);

    // Determine total + page size for the loop.
    const total = stats.total || (await countRowsOnPage(page));
    const firstInfo = await getPageInfo(page);
    let pageSize = (firstInfo.end > 0 && firstInfo.end >= firstInfo.start)
      ? (firstInfo.end - firstInfo.start + 1)
      : 0;
    if (pageSize < 1) pageSize = (await countRowsOnPage(page)) || 5;

    const limit = CONFIG.maxAssets ? Math.min(total, CONFIG.maxAssets) : total;
    const startIndex = CONFIG.resumeFromRow > 0 ? CONFIG.resumeFromRow : 1;

    console.log(`\n🚀 Processing assets ${startIndex}..${limit} of ${total} (page size ${pageSize})...`);
    if (limit - startIndex + 1 > 50) {
      console.log("  ℹ Large set — set MAX_ASSETS_ASSETS for a test run, or filter by date/class. RESUME_FROM_ASSET_ROW continues a stopped run.");
    }

    // ── Loop page-by-page: process every row on a page, THEN advance to the
    //    next page. Steps 4–9 + Go back ×2 are repeated per row. ─────────────
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const startPage = Math.floor((startIndex - 1) / pageSize) + 1;
    const results = [];
    let done = 0, failed = 0, skipped = 0;

    // Auto-resume: load the Asset Nos. exported by a prior, interrupted run of
    // this workflow + OU. Matching rows are skipped without drilling in.
    const doneAssets = loadDoneAssets(RESUME_FILE);
    if (doneAssets.size) {
      console.log(`  ↩ Auto-resume: ${doneAssets.size} asset(s) already exported previously — they will be skipped.`);
    }

    outer:
    for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
      console.log(`\n📄 ===== Page ${pageNum}/${totalPages} =====`);
      await ensureOnPage(page, pageNum, pageSize);

      const rowsOnPage = (await countRowsOnPage(page)) || pageSize;
      // On the first (resume) page, skip rows before the resume point.
      const startRow = (pageNum === startPage) ? ((startIndex - 1) % pageSize) : 0;

      for (let rowIdx = startRow; rowIdx < rowsOnPage; rowIdx++) {
        const globalIdx = (pageNum - 1) * pageSize + rowIdx + 1;
        if (globalIdx > limit) break outer;

        console.log(`\n📍 [Asset ${globalIdx}/${limit}] page ${pageNum}, row ${rowIdx + 1}`);

        // A prior Go back may have moved the grid — make sure we're on this page.
        await ensureOnPage(page, pageNum, pageSize);

        // Auto-resume: read the Asset No. cheaply (no drill-in) and skip the row
        // if a previous run already exported it.
        const preAssetNo = (await readAssetNo(page, rowIdx)).trim();
        if (preAssetNo && doneAssets.has(preAssetNo)) {
          console.log(`  ↩ Asset ${preAssetNo} already exported previously — skipping.`);
          results.push({ index: globalIdx, assetNo: preAssetNo, ok: true, skipped: true });
          skipped++;
          continue;
        }

        // Steps 4–5: select the row, open View Asset Details.
        const open1 = await selectRowAndOpen(page, rowIdx, "View Asset Details", "Asset Information");
        const assetNo = open1.assetNo || `Row-${globalIdx}`;
        const assetDir = `${baseDir}/${safeAssetFolder(assetNo)}`;
        console.log(`  🏷 Asset No.: ${assetNo}`);

        if (!open1.ok) {
          console.error(`  ❌ Could not open View Asset Details for asset #${globalIdx} — skipping.`);
          await closeMessagePopup(page);
          await page.frameLocator("#ilboinnerframe").locator('.x-grid3-row').first()
            .waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
          results.push({ index: globalIdx, assetNo, ok: false });
          failed++;
          continue;
        }

        // Step 6: export the full tag grid on View Asset Details.
        const detailExport = await exportGridToExcel(page, `${assetDir}/Asset Details`);

        // Steps 7–9 per tag, across ALL tag pages. The View Asset Details table
        // can have multiple rows (and pages); each tag has its own documents.
        const tagInfo = await getPageInfo(page);
        let tagPageSize = (tagInfo.end > 0 && tagInfo.end >= tagInfo.start)
          ? (tagInfo.end - tagInfo.start + 1) : 0;
        if (tagPageSize < 1) tagPageSize = (await countRowsOnPage(page)) || 1;
        const tagTotal = tagInfo.total || (await countRowsOnPage(page)) || 1;
        const tagPages = Math.max(1, Math.ceil(tagTotal / tagPageSize));
        console.log(`  🔖 View Asset Details: ${tagTotal} tag(s) across ${tagPages} page(s).`);

        const docExports = [];
        let tagGlobal = 0;
        let returnedToList = false;

        for (let tp = 1; tp <= tagPages; tp++) {
          await ensureOnPage(page, tp, tagPageSize);
          const rowsThisTagPage = (await countRowsOnPage(page)) || tagPageSize;

          for (let tIdx = 0; tIdx < rowsThisTagPage && tagGlobal < tagTotal; tIdx++) {
            tagGlobal++;
            const isLastTag = tagGlobal >= tagTotal;
            const docName = tagTotal > 1 ? `Document Details - Tag ${tagGlobal}` : "Document Details";
            console.log(`  🔖 Tag ${tagGlobal}/${tagTotal} (tag page ${tp}, row ${tIdx + 1})...`);

            // A prior drill-down may reset the tag grid to page 1 — re-page if so.
            await ensureOnPage(page, tp, tagPageSize);

            const openDoc = await selectRowAndOpen(page, tIdx, "View Document Details", "Document Information");
            if (openDoc.ok) {
              docExports.push(await exportGridToExcel(page, `${assetDir}/${docName}`));
              if (isLastTag) {
                // Last tag: Go back twice → View Asset Details → asset list.
                await goBack(page);
                await goBack(page);
                returnedToList = true;
              } else {
                // Back to View Asset Details to select the next tag.
                await goBack(page);
                await page.frameLocator("#ilboinnerframe").getByText("Asset Information", { exact: false }).first()
                  .waitFor({ state: "attached", timeout: 12000 }).catch(() => {});
              }
            } else {
              console.warn(`  ⚠ Could not open View Document Details for tag ${tagGlobal} — skipping.`);
              await closeMessagePopup(page);
              if (isLastTag) {
                // Still on View Asset Details — one Go back reaches the list.
                await goBack(page);
                returnedToList = true;
              }
            }
          }
        }

        // Safety net: make sure we land back on the asset list.
        if (!returnedToList) await goBack(page);
        const onList = await page.frameLocator("#ilboinnerframe").locator('.x-grid3-row').first()
          .waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);

        results.push({ index: globalIdx, assetNo, ok: true, tagCount: tagTotal, detailExport, docExports });
        done++;
        doneAssets.add(assetNo);
        saveDoneAssets(RESUME_FILE, doneAssets, total);
        console.log(`  ✅ Asset ${assetNo} done — ${docExports.length}/${tagTotal} tag doc export(s)${onList ? "" : " (⚠ list not confirmed)"}.`);
        await page.waitForTimeout(400);
      }

      console.log(`  ✔ Page ${pageNum} complete — all its rows exported.`);
    }

    // Whole grid processed without interruption — drop the resume checkpoint.
    clearDoneAssets(RESUME_FILE);

    const secs = Math.floor((Date.now() - startTime) / 1000);
    console.log(`\n✅ Finished. Processed ${done} asset(s), ${failed} failed, ${skipped} skipped (already done), of ${limit - startIndex + 1} attempted (total in grid: ${total}).`);
    if (listExport) console.log(`✅ Search results list → ${listExport}`);
    console.log(`⏱  Total runtime: ${Math.floor(secs / 60)}m ${secs % 60}s`);

    try {
      writeFileSync("output/extracted-data-assets.json",
        JSON.stringify({ total, attempted: limit - startIndex + 1, processed: done, failed, skipped, results }, null, 2));
      console.log("💾 Summary → output/extracted-data-assets.json");
    } catch (_) {}

    await waitForEnter("👉 Press ENTER to close the browser...");

  } catch (err) {
    console.error("❌ Script error:", err.message);
    await page.screenshot({ path: "screenshots/assets-error.png" }).catch(() => {});
    await waitForEnter("⚠ Error occurred. Press ENTER to close...");
  } finally {
    await browser.close();
    console.log("🔒 Browser closed.");
  }
}

main();
