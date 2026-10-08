import { expect, test, type Page } from "@playwright/test";

/**
 * Console errors and failed same-origin requests collected for the whole test. One browser message is not
 * an app error and is left out: a third-party asset icon whose host forbids embedding (the page shows the
 * asset's initials instead).
 */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const thirdPartyImage = /ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_ORB/.test(m.text()) && new URL(m.location().url || "http://x").origin !== new URL(page.url()).origin;
    if (!thirdPartyImage) problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`exception: ${e.message}`));
  page.on("response", (r) => {
    const sameOrigin = new URL(r.url()).origin === new URL(page.url() || "http://x").origin;
    if (sameOrigin && r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
  });
  return problems;
}

const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeEach(async ({ page }) => {
  // The first-visit risk notice is tested on its own; elsewhere it is acknowledged.
  await page.addInitScript(() => localStorage.setItem("sluice.riskAck", "true"));
});

test("first visit states the risk once and remembers the acknowledgement", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("sluice.riskAck"));
  await page.goto("/");
  await expect(page.getByText("This is Stellar mainnet")).toBeVisible();
  await page.getByRole("button", { name: "I understand" }).click();
  await expect(page.getByText("This is Stellar mainnet")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("sluice.riskAck"))).toBe("true");
});

test("quotes live mainnet routes and labels each one atomic or not", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One quote across both layers.");
  await page.getByLabel("You pay", { exact: true }).fill("25");
  const routes = page.getByRole("radiogroup", { name: "Choose a route" }).getByRole("radio");
  await expect(routes.first()).toBeChecked();
  expect(await routes.count()).toBeGreaterThan(0);
  for (const label of await page.getByRole("radiogroup").locator("label").allInnerTexts()) {
    expect(label).toMatch(/One transaction, atomic|Two transactions, not atomic/);
    expect(label).toMatch(/Minimum [\d,.]+ USDC, or the swap does not execute/);
  }
  // The amount shown as received is the selected route's, and it is a real positive number.
  const received = (await page.locator("output").innerText()).replace(/,/g, "");
  expect(Number(received)).toBeGreaterThan(0);
  // Without a wallet the action is to connect one, not a button that goes nowhere.
  await expect(page.locator("fieldset").getByRole("button", { name: "Connect wallet" })).toBeEnabled();
  expect(await sidewaysScroll(page)).toBe(0);
  expect(problems).toEqual([]);
});

test("invalid and impossible input is explained in place", async ({ page }) => {
  await page.goto("/");
  const amount = page.getByLabel("You pay", { exact: true });
  await amount.fill("1.123456789");
  await expect(page.getByText("Use digits and at most 7 decimal places.")).toBeVisible();
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await amount.fill("abc");
  await expect(amount).toHaveValue("");
});

test("asset picker searches the live list, checks pasted assets on chain, and swaps sides on a same-asset pick", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^You receive: USDC/ }).click();
  const dialog = page.getByRole("dialog", { name: "You receive" });
  const search = dialog.getByPlaceholder("Search, or paste CODE:ISSUER");
  await expect(search).toBeFocused();
  // The list comes from three public asset lists; on a cold server it arrives a moment after the dialog opens.
  await expect(dialog.getByRole("listitem").nth(20)).toBeVisible({ timeout: 60_000 });
  await search.fill("aqua");
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  // A code and issuer that is on no list and does not exist.
  await search.fill("NOPE:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  await expect(dialog.getByText("No asset with that code and issuer exists on Stellar mainnet.")).toBeVisible();
  // Picking the asset already on the other side flips the pair instead of making XLM to XLM.
  await search.fill("xlm");
  await dialog.getByRole("listitem").first().getByRole("button").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /^You receive: XLM/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^You pay: USDC/ })).toBeVisible();
});

test("two-transaction routes are hidden until asked for", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("You pay", { exact: true }).fill("25");
  await expect(page.getByRole("radiogroup")).toBeVisible();
  await expect(page.getByText("Two transactions, not atomic")).toHaveCount(0);
  await page.getByRole("button", { name: /^Slippage/ }).click();
  const toggle = page.getByRole("checkbox", { name: /Also show routes that need two transactions/ });
  await toggle.check();
  await expect(page.getByRole("button", { name: /two-transaction routes shown/ })).toBeVisible();
});

test("earn shows live pool state read from the contract", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/#/earn");
  await expect(page).toHaveTitle("Earn · Sluice");
  await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
  const reserves = page.getByRole("list", { name: /assets$/ }).first().getByRole("listitem");
  // Read from the pool contract over a public RPC endpoint.
  await expect(reserves.first()).toBeVisible({ timeout: 60_000 });
  expect(await reserves.count()).toBeGreaterThan(0);
  for (const text of await reserves.allInnerTexts()) {
    expect(text).toMatch(/supply APR now/);
    expect(text).toMatch(/[\d.<]+% borrowed/);
  }
  // Depositing without a wallet asks for one.
  await reserves.first().getByRole("button", { name: /^Deposit/ }).click();
  await expect(reserves.first().getByRole("button", { name: "Connect wallet" })).toBeEnabled();
  expect(await sidewaysScroll(page)).toBe(0);
  expect(problems).toEqual([]);
});

test("navigation is real: tabs are links, back works, the skip link lands on the content", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Earn", exact: true }).click();
  await expect(page).toHaveURL(/#\/earn$/);
  await expect(page.getByRole("link", { name: "Earn", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One quote across both layers.");
  await expect(page.locator('a[href="#main"]')).toHaveCount(1);
  await expect(page.locator("#main")).toHaveCount(1);
});

test("no dead links: every link on both screens answers", async ({ page, request }) => {
  const seen = new Set<string>();
  for (const path of ["/", "/#/earn"]) {
    await page.goto(path);
    await expect(page.getByRole("contentinfo")).toBeVisible();
    for (const href of await page.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) seen.add(href);
  }
  expect(seen.size).toBeGreaterThan(3);
  for (const href of seen) {
    const url = new URL(href);
    expect(url.hash === "#" && url.pathname === "/" && !href.includes("#/") ? "bare # link" : "ok", href).toBe("ok");
    const res = await request.get(href.split("#")[0]!, { maxRedirects: 5 });
    expect(res.status(), href).toBeLessThan(400);
  }
});

/** Bring a screen to the state a visitor sees with live data loaded. */
const screens = {
  swap: async (page: Page) => {
    await page.goto("/");
    await page.getByLabel("You pay", { exact: true }).fill("25");
    // Live quotes from five venues: allow for a cold server and a busy machine.
    await expect(page.getByRole("radiogroup")).toBeVisible({ timeout: 60_000 });
  },
  earn: async (page: Page) => {
    await page.goto("/#/earn");
    // Going to the same hash again is not a page load; reload so every pass starts from a closed form.
    await page.reload();
    const first = page.getByRole("list", { name: /assets$/ }).first().getByRole("listitem").first();
    await expect(first).toBeVisible({ timeout: 60_000 });
    // Open one deposit form so its controls are checked too.
    await first.getByRole("button", { name: /^Deposit/ }).click();
    await expect(first.getByRole("textbox", { name: "Pay with" })).toBeVisible();
  },
};

for (const [screen, open] of Object.entries(screens)) {
  test(`no dead buttons: every enabled button on the ${screen} screen does something`, async ({ page }) => {
    // One fresh page load with live data per button.
    test.setTimeout(8 * 60_000);
    // The app remembers the chosen pair between visits (on purpose). Here every pass must start from the
    // same screen, so what an earlier click saved (flipping the pair, picking an asset) is cleared on load.
    await page.addInitScript(() => { for (const k of ["sluice.in", "sluice.out", "sluice.slippage", "sluice.customAssets"]) localStorage.removeItem(k); });
    await open(page);
    const enabled = page.locator("button:enabled:visible");
    const describe = () => enabled.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") ?? (b as HTMLElement).innerText.trim()));
    // Each button is identified by its label and which occurrence of that label it is, because the page is
    // reloaded with fresh live data for every click and positions can shift.
    const wanted = await describe();
    expect(wanted.length).toBeGreaterThan(5);
    const absent: string[] = [];
    for (const [n, name] of wanted.entries()) {
      const occurrence = wanted.slice(0, n).filter((x) => x === name).length;
      await open(page);
      // Let the page settle first (the wallet layer finishes loading in the background), so a change seen
      // after the click was caused by the click.
      await expect(page.getByRole("navigation").getByRole("button", { name: /Connect/ })).toBeEnabled();
      await page.waitForTimeout(400);
      const now = await describe();
      const index = now.reduce<number[]>((hits, x, i) => (x === name ? [...hits, i] : hits), [])[occurrence];
      if (index === undefined) {
        absent.push(name);
        continue;
      }
      const button = enabled.nth(index);
      // A click must change the page: open something, move something, or start a request. The once-a-second
      // "updated Ns ago" label is ignored, or every button would pass.
      const changed = page.evaluate(() => new Promise<boolean>((resolve) => {
        const done = (v: boolean) => { observer.disconnect(); resolve(v); };
        const observer = new MutationObserver((records) => {
          const real = records.some((m) => !(m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement)?.closest("[data-ticker]"));
          if (real) done(true);
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        setTimeout(() => done(false), 4000);
      }));
      await button.click();
      expect(await changed, `"${name}" did nothing`).toBe(true);
    }
    // Only controls that depend on which routes the market returns may come and go between loads.
    expect(absent.filter((name) => !/health score/.test(name)), "buttons that vanished on reload").toEqual([]);
  });
}

test("fits a 360px phone without sideways scrolling, on both screens with data loaded", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await screens.swap(page);
  // Longest content the swap screen produces: two-transaction routes with multi-hop paths.
  await page.getByRole("button", { name: /^Slippage/ }).click();
  await page.getByRole("checkbox", { name: /Also show routes that need two transactions/ }).check();
  await expect(page.getByRole("radiogroup")).toBeVisible();
  expect(await sidewaysScroll(page)).toBe(0);
  await screens.earn(page);
  expect(await sidewaysScroll(page)).toBe(0);
});

test("works from the keyboard: skip link first, picker opens and closes, focus returns, routes are arrow-selectable", async ({ page, browserName }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "keyboard use is a desktop check");
  // On a fresh page the first Tab stop is the skip link.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByLabel("You pay", { exact: true }).fill("25");
  await expect(page.getByRole("radiogroup")).toBeVisible();
  const opener = page.getByRole("button", { name: /^You receive:/ });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "You receive" });
  await expect(dialog.getByPlaceholder("Search, or paste CODE:ISSUER")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  // Routes are a native radio group: arrow keys move the selection.
  const routes = page.getByRole("radiogroup").getByRole("radio");
  if ((await routes.count()) > 1) {
    await routes.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(routes.nth(1)).toBeChecked();
  }
  // The health details open and close with the keyboard too.
  const badge = page.locator("fieldset").getByRole("button", { name: /health score/ });
  if (await badge.count()) {
    await badge.first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  expect(browserName).toBeTruthy();
});
